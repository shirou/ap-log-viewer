// Classifying a .tlog's records. As with the .bin path the framing comes from
// the reader's own loop (`scanTlog`), so this file only decides which records
// belong to the window and which are context it needs.
//
// A .tlog has no header: it is a flat run of self-contained
// [stamp][MAVLink frame] records, so a cut on a record boundary is already a
// valid tlog. What a cut loses is state the stream only announced earlier —
// parameters, the flight plan, the mode in force — which is what gets carried in.

import { common, minimal } from 'mavlink-mappings';
import type { ByteRange, LogSource } from '../parsers/source.ts';
import type { ParseOptions } from '../parsers/dataflash.ts';
import { REGISTRY, scanTlog, type TlogFrame } from '../parsers/tlog.ts';
import type { TimeWindow } from '../model/log.ts';
import { copyBytes, countExpected, pushRange, type ExpectedRows, type SliceScan } from './sliceTypes.ts';

/**
 * Message ids, taken from the dialect rather than written out.
 *
 * They are frozen by the MAVLink spec, so hardcoding them would work — but the
 * worker that runs this already imports `parseTlog`, which pulls `mavlink-mappings`
 * into the same bundle (measured: the parser worker chunk is the only build output
 * containing it). There is nothing to save by hand-rolling the numbers, so take
 * them from the source of truth and let the field offsets come from there too.
 */
const MSG_HEARTBEAT = minimal.Heartbeat.MSG_ID;
const MSG_PARAM_VALUE = common.ParamValue.MSG_ID;
const MSG_MISSION_ITEM = common.MissionItem.MSG_ID;
const MSG_MISSION_COUNT = common.MissionCount.MSG_ID;
const MSG_MISSION_ITEM_INT = common.MissionItemInt.MSG_ID;

const MISSION_TRANSFER = new Set([MSG_MISSION_COUNT, MSG_MISSION_ITEM, MSG_MISSION_ITEM_INT]);

/** MAV_TYPE_GCS — a ground station announcing itself, not a vehicle. */
const MAV_TYPE_GCS = 6;

function fieldOffset(fields: { name: string; offset: number }[], name: string): number {
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error(`mavlink-mappings has no ${name} field`);
  return f.offset;
}

const PARAM_ID_OFFSET = fieldOffset(common.ParamValue.FIELDS, 'paramId');
const PARAM_ID_LENGTH = 16;
const HEARTBEAT_TYPE_OFFSET = fieldOffset(minimal.Heartbeat.FIELDS, 'type');

/** ASCII up to the first NUL, clamped to what the frame actually carries. */
function readParamId(bytes: Uint8Array, f: TlogFrame): string | null {
  const start = f.payloadStart + PARAM_ID_OFFSET;
  const end = Math.min(start + PARAM_ID_LENGTH, f.payloadStart + f.plen);
  if (end <= start) return null; // MAVLink 2 trims trailing zeros; too short to key on
  let s = '';
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0) break;
    s += String.fromCharCode(bytes[i]);
  }
  return s.length ? s : null;
}

interface Carried {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** Original stamp, used only to order the preamble. */
  ts: number;
}

/**
 * Copy a record and move its stamp to the window start.
 *
 * The 8-byte prefix is the logger's, not MAVLink's, and no CRC covers it, so the
 * frame stays valid. Leaving the original stamps in place instead would make the
 * slice's own start time the session start, and this viewer would then draw a
 * timeline spanning the whole original flight with the window crushed into one
 * end — the thing cutting a window is meant to avoid.
 */
function copyRestamped(bytes: Uint8Array, f: TlogFrame, name: string, t0: number): Carried {
  const out = copyBytes(bytes, f.start, f.end - f.start);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(0, BigInt(t0), false);
  return { name, bytes: out, ts: f.ts };
}

export async function planTlogSlice(
  source: LogSource,
  window: TimeWindow,
  opts: ParseOptions = {},
): Promise<SliceScan> {
  const { startUs: t0, endUs: t1 } = window;

  /**
   * The whole pre-window mission transfer, in file order and unfiltered.
   *
   * `MissionCollector.beginTransfer` treats MISSION_COUNT as the boundary between
   * transfers, so dropping or reordering any of these changes the plan the reader
   * derives. The fence/rally filter lives in the parser, so passing those frames
   * through reproduces its behaviour rather than second-guessing it.
   */
  const missionFrames: Carried[] = [];
  /** One frame per parameter name; see the .bin path for the same rule. */
  const params = new Map<string, { carried: Carried; fromBeforeWindow: boolean }>();
  /**
   * The last pre-window heartbeat from something that is not a ground station.
   *
   * Measured on a real session: four heartbeat sources, and the GCS at
   * (255,190) sends 7190 of them against the vehicle's 3603 — twice the rate. So
   * "the last heartbeat before the window" is the GCS's about three times in
   * four, and its customMode is 0, which would land the slice on a mode the
   * vehicle was never in. Only the vehicle's says anything about the flight.
   */
  let vehicleHeartbeat: Carried | null = null;

  const ranges: ByteRange[] = [];
  const expected = new Map<string, ExpectedRows>();
  let windowRecords = 0;
  let resyncBytes = 0;
  let prevEnd = 0;

  await scanTlog(
    source,
    (f, bytes) => {
      if (f.start > prevEnd) resyncBytes += f.start - prevEnd;
      prevEnd = f.end;
      const name = REGISTRY[f.msgid]?.MSG_NAME ?? `#${f.msgid}`;

      // The window first, so a frame already in view is never lifted out of it.
      if (f.ts >= t0 && f.ts <= t1) {
        pushRange(ranges, f.start, f.end);
        countExpected(expected, name, 'window');
        windowRecords++;
        return;
      }

      if (f.msgid === MSG_PARAM_VALUE) {
        const id = readParamId(bytes, f);
        if (!id) return;
        const cur = params.get(id);
        if (f.ts <= t0) params.set(id, { carried: copyRestamped(bytes, f, name, t0), fromBeforeWindow: true });
        else if (!cur) params.set(id, { carried: copyRestamped(bytes, f, name, t0), fromBeforeWindow: false });
        return;
      }

      // Everything below describes the state the window opens in.
      if (f.ts > t1) return;

      if (MISSION_TRANSFER.has(f.msgid)) {
        missionFrames.push(copyRestamped(bytes, f, name, t0));
        return;
      }
      if (f.msgid === MSG_HEARTBEAT) {
        // sysid/compid sit at different offsets per version, but the payload
        // field does not: v1 puts the payload at p+6, v2 at p+10, and
        // payloadStart already accounts for that.
        const at = f.payloadStart + HEARTBEAT_TYPE_OFFSET;
        const isGcs = at < f.payloadStart + f.plen && bytes[at] === MAV_TYPE_GCS;
        if (!isGcs) vehicleHeartbeat = copyRestamped(bytes, f, name, t0);
        return;
      }
    },
    opts,
  );

  // Mission frames keep their file order; the parameters and the heartbeat go
  // after them, ordered by the stamp they originally carried. The reader's mode
  // label is whichever heartbeat came last in the byte stream, so the newest one
  // has to be last here too.
  const carried: Carried[] = [
    ...missionFrames,
    ...[...params.values()].map((p) => p.carried).sort((a, b) => a.ts - b.ts),
  ];
  if (vehicleHeartbeat) carried.push(vehicleHeartbeat);

  const contextParts = carried.map((c) => {
    countExpected(expected, c.name, 'hoisted');
    return c.bytes;
  });

  return {
    kind: 'tlog',
    // A tlog needs no structural preamble at all: every record carries its own
    // framing, so a JSON export can be cut from the window and nothing else.
    structParts: [],
    contextParts,
    ranges,
    expected,
    stats: {
      windowRecords,
      hoistedRecords: contextParts.length,
      rangeCount: ranges.length,
      resyncBytes,
    },
  };
}

/** Exported for the guard test that pins these against the dialect. */
export const TLOG_SLICE_IDS = {
  MSG_HEARTBEAT,
  MSG_PARAM_VALUE,
  MSG_MISSION_ITEM,
  MSG_MISSION_COUNT,
  MSG_MISSION_ITEM_INT,
  PARAM_ID_OFFSET,
  HEARTBEAT_TYPE_OFFSET,
};
