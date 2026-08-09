// Telemetry log (.tlog) parser. A tlog is a flat sequence of records:
//   [8-byte big-endian uint64 timestamp, microseconds since UNIX epoch]
//   [one MAVLink v1 (0xFE) or v2 (0xFD) frame]
//
// We do the framing ourselves (so we keep each frame's timestamp) and decode the
// payload with mavlink-mappings message classes. We deliberately avoid importing
// `node-mavlink`'s top-level entry because it pulls in Node's stream/net/crypto;
// instead we reuse only the pure DESERIALIZERS table plus a tiny re-implementation
// of its field-decode loop.
//
// As in the DataFlash reader, the framing loop is exposed on its own as
// `scanTlog` and `parseTlog` is one of its consumers; the other is the window
// slicer (src/export). Sharing the loop is what keeps the two byte-for-byte in
// agreement about where a frame ends and where the reader resyncs.

import { Buffer } from 'buffer';
import { minimal, common, ardupilotmega } from 'mavlink-mappings';
import { DESERIALIZERS } from 'node-mavlink/dist/lib/serialization.js';
import type { CommandEvent, LogData, MissionStep, ModeChange, TextMessage } from '../model/log.ts';
import type { LogSource } from './source.ts';
import type { ParseOptions } from './dataflash.ts';
import { LogBuilder, extractTrajectory, normalizeEvents, type ColumnDef } from './columnar.ts';
import { MissionCollector } from './mission.ts';

// mavlink-mappings references the Node global `Buffer`; provide the polyfill.
const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;

interface MavField {
  name: string;
  type: string;
  length: number;
  offset: number;
  size: number;
}
interface MavClass {
  new (): Record<string, unknown>;
  MSG_ID: number;
  MSG_NAME: string;
  FIELDS: MavField[];
}
type Registry = Record<number, MavClass>;

export const REGISTRY: Registry = {
  ...(minimal.REGISTRY as unknown as Registry),
  ...(common.REGISTRY as unknown as Registry),
  ...(ardupilotmega.REGISTRY as unknown as Registry),
};

export const V1_STX = 0xfe;
export const V2_STX = 0xfd;
const V2_IFLAG_SIGNED = 0x01;

/**
 * One record as the reader framed it: the 8-byte stamp plus the MAVLink frame.
 *
 * Offsets are into the buffer handed to the visitor, which for a tlog is the
 * whole file, so they double as absolute file offsets.
 */
export interface TlogFrame {
  /** [start, end) is every byte of the record, stamp included. */
  start: number;
  end: number;
  /** Microseconds since the UNIX epoch, from the 8-byte prefix. */
  ts: number;
  msgid: number;
  payloadStart: number;
  plen: number;
}

/**
 * Called once per framed record, for every msgid — including ones the registry
 * has no class for, which `parseTlog` skips but a byte slicer must still copy.
 *
 * The frame object is REUSED between calls; copy anything you need to keep.
 */
export type TlogVisitor = (f: TlogFrame, bytes: Uint8Array) => void;

/**
 * Frame every record in the source and hand each one to `visit`.
 *
 * Reads the whole file, as this parser always has. Chunking it would need the
 * loop's bounds tightened first — the guard below admits `offset + 8 === len`
 * and then reads the STX byte one past the end, which is harmless at EOF
 * (undefined fails the test and the loop resyncs) but would eat the first byte
 * of a stamp whose frame is in the next chunk.
 */
export async function scanTlog(source: LogSource, visit: TlogVisitor, opts: ParseOptions = {}): Promise<void> {
  const bytes = await source.read();
  const len = bytes.byteLength;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Reused across records; see TlogVisitor.
  const f: TlogFrame = { start: 0, end: 0, ts: 0, msgid: 0, payloadStart: 0, plen: 0 };
  let offset = 0;
  let lastProgress = 0;

  while (offset + 8 <= len) {
    const ts = Number(dv.getBigUint64(offset, false)); // microseconds, UNIX
    const p = offset + 8;
    const stx = bytes[p];
    if (stx !== V1_STX && stx !== V2_STX) {
      offset++; // resync
      continue;
    }
    const plen = bytes[p + 1];
    let payloadStart: number;
    let msgid: number;
    let frameEnd: number;
    if (stx === V1_STX) {
      payloadStart = p + 6;
      msgid = bytes[p + 5];
      frameEnd = p + 6 + plen + 2; // header + payload + crc
    } else {
      const incompat = bytes[p + 2];
      payloadStart = p + 10;
      msgid = bytes[p + 7] | (bytes[p + 8] << 8) | (bytes[p + 9] << 16);
      frameEnd = p + 10 + plen + 2 + (incompat & V2_IFLAG_SIGNED ? 13 : 0);
    }
    if (frameEnd > len || payloadStart + plen > len) break; // truncated tail

    f.start = offset;
    f.end = frameEnd;
    f.ts = ts;
    f.msgid = msgid;
    f.payloadStart = payloadStart;
    f.plen = plen;
    visit(f, bytes);

    offset = frameEnd;

    if (opts.onProgress) {
      const ratio = offset / len;
      if (ratio - lastProgress > 0.02) {
        lastProgress = ratio;
        opts.onProgress(ratio);
      }
    }
  }
}

// Re-implementation of node-mavlink's MavLinkProtocol.data() field loop, using
// the pure DESERIALIZERS table. Pads truncated MAVLink 2 payloads with zeros.
function deserialize(payload: Buffer, clazz: MavClass): Record<string, unknown> {
  const instance = new clazz();
  let buf = payload;
  let remaining = buf.length;
  for (const field of clazz.FIELDS) {
    const fieldLength = field.length === 0 ? field.size : field.length * field.size;
    const de = DESERIALIZERS[field.type as keyof typeof DESERIALIZERS];
    if (!de) continue;
    if (fieldLength > remaining) {
      const padded = Buffer.alloc(buf.length + (fieldLength - remaining));
      buf.copy(padded, 0, 0, buf.length);
      buf = padded;
    }
    instance[field.name] = de(buf, field.offset, field.length);
    remaining -= fieldLength;
  }
  return instance;
}

export async function parseTlog(source: LogSource, opts: ParseOptions = {}): Promise<LogData> {
  const builder = new LogBuilder();
  const columnsCache = new Map<number, ColumnDef[]>();
  // Everything pulled out of the stream that is not just another column, kept in
  // one bag so `extractSpecial` needs a single parameter rather than one per
  // collection (mirrors ParseState in the DataFlash parser).
  const special: Special = {
    params: {},
    modes: [],
    texts: [],
    commands: [],
    missionSteps: [],
    lastMode: '',
    lastSeq: null,
  };
  const { params, modes, texts } = special;
  // MISSION_ITEM_INT is the current form and MISSION_ITEM the deprecated one;
  // a session can carry both, so collect them apart and prefer the int form.
  const missionInt = new MissionCollector();
  const missionFloat = new MissionCollector();
  let minTime = Infinity;
  let maxTime = -Infinity;

  await scanTlog(
    source,
    (f, bytes) => {
      const clazz = REGISTRY[f.msgid];
      if (!clazz) return;
      const payload = Buffer.from(bytes.subarray(f.payloadStart, f.payloadStart + f.plen));
      try {
        const msg = deserialize(payload, clazz);
        if (f.ts < minTime) minTime = f.ts;
        if (f.ts > maxTime) maxTime = f.ts;
        let columns = columnsCache.get(f.msgid);
        if (!columns) {
          columns = columnsFor(clazz, msg);
          columnsCache.set(f.msgid, columns);
        }
        builder.push(f.msgid, clazz.MSG_NAME, columns, msg, f.ts);
        extractSpecial(special, clazz.MSG_NAME, msg, f.ts);
        if (clazz.MSG_NAME === 'MISSION_ITEM_INT') addMissionItem(missionInt, msg, 1e-7);
        else if (clazz.MSG_NAME === 'MISSION_ITEM') addMissionItem(missionFloat, msg, 1);
        else if (clazz.MSG_NAME === 'MISSION_COUNT' && isFlightPlan(msg)) {
          // MISSION_COUNT opens every full transfer, up- or download, so it is
          // the one unambiguous "a new plan starts here" marker in the stream.
          missionInt.beginTransfer();
          missionFloat.beginTransfer();
        }
      } catch {
        // ignore a malformed frame, keep scanning
      }
    },
    opts,
  );

  const messages = builder.finalize();
  // GLOBAL_POSITION_INT/GPS_RAW_INT: lat/lon in degE7, alt in mm.
  const trajectory = extractTrajectory(
    messages,
    [
      { msg: 'GLOBAL_POSITION_INT', lat: 'lat', lon: 'lon', alt: 'relativeAlt', latScale: 1e-7, altScale: 1e-3 },
      { msg: 'GPS_RAW_INT', lat: 'lat', lon: 'lon', alt: 'alt', latScale: 1e-7, altScale: 1e-3 },
    ],
    // Heading (degrees): hdg is cdeg (65535 = unknown); ATTITUDE.yaw is radians.
    [
      { msg: 'GLOBAL_POSITION_INT', field: 'hdg', scale: 0.01, unknown: 65535 },
      { msg: 'VFR_HUD', field: 'heading', scale: 1 },
      { msg: 'ATTITUDE', field: 'yaw', scale: 180 / Math.PI },
      { msg: 'GPS_RAW_INT', field: 'cog', scale: 0.01, unknown: 65535 },
    ],
  );

  if (!Number.isFinite(minTime)) {
    minTime = 0;
    maxTime = 0;
  }

  const mission = missionInt.finalize();

  // Consumers are promised time order, and the plot's marker labels are laid out
  // left to right and silently drop any that arrives behind the last one placed.
  // Two commands sent together are separate events, so the same instant is only
  // a repeat when the MAV_CMD matches too.
  const commands = normalizeEvents(special.commands, (c) => c.id);
  const missionSteps = normalizeEvents(special.missionSteps, (s) => s.seq);

  return {
    source: 'tlog',
    messages,
    params,
    modes,
    texts,
    commands,
    missionSteps,
    trajectory,
    mission: mission.length ? mission : missionFloat.finalize(),
    startTime: minTime,
    endTime: maxTime,
  };
}

/** MAV_MISSION_TYPE.MISSION — the flight plan. 1 is a geofence, 2 a rally point. */
const MAV_MISSION_TYPE_MISSION = 0;

function numberFrom(msg: Record<string, unknown>, name: string): number {
  const v = msg[name];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN;
}

/**
 * True for messages belonging to the flight plan rather than a fence or rally
 * transfer, which reuse these same message ids.
 *
 * missionType is a MAVLink 2 extension field, but `deserialize` zero-fills a
 * payload that stops short of it, so it reads as 0 — MISSION — on the v1 frames
 * and older senders that omit it entirely. That is the right default, and it is
 * why this is a plain equality test with no absent-field case.
 */
function isFlightPlan(msg: Record<string, unknown>): boolean {
  return numberFrom(msg, 'missionType') === MAV_MISSION_TYPE_MISSION;
}

// x/y are latitude/longitude and z is metres. The message id fixes the unit, so
// unlike the DataFlash path there is nothing to infer: MISSION_ITEM_INT is
// degE7, and the deprecated MISSION_ITEM is already plain degrees.
function addMissionItem(into: MissionCollector, msg: Record<string, unknown>, scale: number): void {
  if (!isFlightPlan(msg)) return;
  const seq = numberFrom(msg, 'seq');
  if (!Number.isFinite(seq)) return;
  into.add({
    seq,
    command: numberFrom(msg, 'command'),
    lat: numberFrom(msg, 'x') * scale,
    lon: numberFrom(msg, 'y') * scale,
    alt: numberFrom(msg, 'z'),
    frame: numberFrom(msg, 'frame'),
  });
}

// Column layout for a message type, derived from the first decoded instance.
// Array/object fields are dropped from the columnar (scalar) model.
function columnsFor(clazz: MavClass, msg: Record<string, unknown>): ColumnDef[] {
  const cols: ColumnDef[] = [];
  for (const field of clazz.FIELDS) {
    const v = msg[field.name];
    if (typeof v === 'number' || typeof v === 'bigint') cols.push({ label: field.name, kind: 'number' });
    else if (typeof v === 'string') cols.push({ label: field.name, kind: 'string' });
  }
  return cols;
}

interface Special {
  params: Record<string, number>;
  modes: ModeChange[];
  texts: TextMessage[];
  commands: CommandEvent[];
  missionSteps: MissionStep[];
  /** Last mode label pushed, so a repeated HEARTBEAT does not log a change. */
  lastMode: string;
  /** Last MISSION_CURRENT seq seen; null before the first one. */
  lastSeq: number | null;
}

/**
 * MAV_CMD id -> name, for labelling command markers.
 *
 * The enum object carries both directions (name -> id and id -> name), so the
 * numeric keys are the reverse map. ArduPilot's dialect adds vendor commands on
 * top of the common set, and its own table repeats the common entries, so
 * layering them cannot lose one.
 */
const MAV_CMD_NAMES: Record<number, string> = (() => {
  const out: Record<number, string> = {};
  for (const table of [common.MavCmd, ardupilotmega.MavCmd] as unknown as Record<string, unknown>[]) {
    for (const [key, value] of Object.entries(table ?? {})) {
      const id = Number(key);
      if (Number.isInteger(id) && typeof value === 'string') out[id] = value;
    }
  }
  return out;
})();

/**
 * True for commands that negotiate the telemetry link rather than ask the
 * vehicle to do something.
 *
 * A GCS polls constantly — REQUEST_MESSAGE and SET_MESSAGE_INTERVAL are how it
 * sets up and tops up its streams — and on a real session they outnumber the
 * commands a reader cares about by a couple of orders of magnitude. One hour of
 * a survey boat's log holds 2030 commands, of which six were aimed at the
 * vehicle; marking all of them would bury those six under a wall of lines.
 *
 * Matched by name rather than by a list of ids so the whole REQUEST_* family is
 * covered, including any the dialect gains later.
 */
function isLinkSetup(name: string): boolean {
  return name.startsWith('REQUEST_') || name.endsWith('MESSAGE_INTERVAL');
}

function extractSpecial(st: Special, name: string, msg: Record<string, unknown>, time: number): void {
  switch (name) {
    case 'PARAM_VALUE': {
      const id = msg['paramId'];
      const val = msg['paramValue'];
      if (typeof id === 'string' && typeof val === 'number') st.params[id] = val;
      break;
    }
    case 'STATUSTEXT': {
      const text = msg['text'];
      if (typeof text === 'string' && text.length) {
        st.texts.push({ time, text, severity: typeof msg['severity'] === 'number' ? (msg['severity'] as number) : undefined });
      }
      break;
    }
    case 'HEARTBEAT': {
      const custom = msg['customMode'];
      if (typeof custom === 'number') {
        const label = `Mode ${custom}`;
        if (label !== st.lastMode) {
          st.modes.push({ time, mode: label });
          st.lastMode = label;
        }
      }
      break;
    }
    // A command as it was sent to the vehicle. COMMAND_ACK is deliberately not
    // collected: the request is the event a reader is looking for, and pairing
    // each one with its reply would double every marker on the plot.
    case 'COMMAND_LONG':
    case 'COMMAND_INT': {
      const id = numberFrom(msg, 'command');
      if (!Number.isFinite(id)) break;
      // Not `name`: that parameter holds the *message* type, and shadowing it
      // here would leave two different names one word apart.
      const cmdName = MAV_CMD_NAMES[id] ?? `MAV_CMD ${id}`;
      if (isLinkSetup(cmdName)) break;
      // A GCS resends an unacknowledged COMMAND_LONG with a rising
      // `confirmation`, so a lost ack shows up here as a burst of identical
      // commands microseconds apart. Only the first attempt is the event.
      // (COMMAND_INT has no such field, so this reads NaN and does not apply.)
      const retry = numberFrom(msg, 'confirmation');
      if (Number.isFinite(retry) && retry > 0) break;
      // A frame arriving twice over a dual link is collapsed by normalizeEvents
      // once the list is sorted, not here: the copies need not be adjacent in
      // the stream, so nothing at this point can reliably see them as a pair.
      st.commands.push({ time, id, name: cmdName });
      break;
    }
    // Where the vehicle has got to in its plan. This is streamed at the
    // telemetry rate — 14400 records over an hour on a real log — so only the
    // instants where `seq` actually moves are events. The first one is kept:
    // it is where the plan started running.
    case 'MISSION_CURRENT': {
      const seq = numberFrom(msg, 'seq');
      if (!Number.isFinite(seq) || seq === st.lastSeq) break;
      st.lastSeq = seq;
      st.missionSteps.push({ time, seq });
      break;
    }
  }
}
