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
import type {
  CommandEvent,
  MissionStep,
  ModeChange,
  ParsedLog,
  SourceData,
  SourceId,
  SourceInfo,
  TextMessage,
} from '../model/log.ts';
import type { LogSource } from './source.ts';
import type { ParseOptions } from './dataflash.ts';
import {
  LogBuilder,
  extractTrajectory,
  normalizeEvents,
  type ColumnDef,
  type HeadingSource,
  type TrajCandidate,
} from './columnar.ts';
import { MissionCollector } from './mission.ts';
import { kindFromMavType, modeLabel, reverseMap } from '../lib/vehicleModes.ts';

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
  /** Sender's MAVLink address. Both versions carry it, at different offsets. */
  sysid: number;
  compid: number;
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
 * loop's bounds tightened further — the header check below is against `len`, so
 * a frame straddling a chunk boundary would read as a truncated tail.
 */
export async function scanTlog(source: LogSource, visit: TlogVisitor, opts: ParseOptions = {}): Promise<void> {
  const bytes = await source.read();
  const len = bytes.byteLength;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Reused across records; see TlogVisitor.
  const f: TlogFrame = { start: 0, end: 0, ts: 0, msgid: 0, payloadStart: 0, plen: 0, sysid: 0, compid: 0 };
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
    // The header has to be there before any of it is read. Without this a file
    // whose last byte is an STX gets `plen === undefined`, which makes every
    // bound below NaN — and `NaN > len` is false, so the truncation check waves
    // the frame through with an undefined sysid/compid and a msgid of 0.
    const headerEnd = stx === V1_STX ? p + 6 : p + 10;
    if (headerEnd > len) break; // truncated tail
    const plen = bytes[p + 1];
    let payloadStart: number;
    let msgid: number;
    let frameEnd: number;
    let sysid: number;
    let compid: number;
    if (stx === V1_STX) {
      payloadStart = p + 6;
      msgid = bytes[p + 5];
      sysid = bytes[p + 3];
      compid = bytes[p + 4];
      frameEnd = p + 6 + plen + 2; // header + payload + crc
    } else {
      const incompat = bytes[p + 2];
      payloadStart = p + 10;
      msgid = bytes[p + 7] | (bytes[p + 8] << 8) | (bytes[p + 9] << 16);
      sysid = bytes[p + 5];
      compid = bytes[p + 6];
      frameEnd = p + 10 + plen + 2 + (incompat & V2_IFLAG_SIGNED ? 13 : 0);
    }
    if (frameEnd > len || payloadStart + plen > len) break; // truncated tail

    f.start = offset;
    f.end = frameEnd;
    f.ts = ts;
    f.msgid = msgid;
    f.payloadStart = payloadStart;
    f.plen = plen;
    f.sysid = sysid;
    f.compid = compid;
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

/**
 * Distinct senders past which a file is not a telemetry log any more.
 *
 * `sysid` and `compid` are one byte each, so a crafted or badly damaged file can
 * name 65,536 addresses — and each one that decodes a frame gets a `LogBuilder`,
 * whose columns start at 256 slots apiece. Measured: 1.8 MiB of minimal
 * heartbeats, one per address, expands to 351 MB. A worker killed for running
 * out of memory takes the tab and the log the reader already had open with it,
 * usually without raising anything catchable, which is why the slicer refuses
 * oversized cuts up front rather than discovering them (see MAX_SLICE_BYTES).
 * Parsing needs the same guard.
 *
 * 256 is far above anything real: a busy survey session runs four sources, and
 * a vehicle carrying a gimbal, a camera and a companion computer is still under
 * ten. Nothing legitimate approaches this.
 */
const MAX_SOURCES = 256;

/**
 * Raised past `MAX_SOURCES`.
 *
 * A class of its own so the per-frame `catch` can tell it from the malformed
 * frames that catch exists to swallow, and re-raise it.
 */
class TooManySources extends Error {}

export async function parseTlog(source: LogSource, opts: ParseOptions = {}): Promise<ParsedLog> {
  const builds = new Map<string, SourceBuild>();
  /**
   * Frames per sender, counted whatever became of them.
   *
   * Kept apart from the builds because a build is only created once a frame
   * decodes: counting inside that branch would drop every frame a source sent
   * before its first decodable one, so the total would depend on arrival order.
   * The sample log's vehicle sends 250 frames of an msgid no dialect defines.
   */
  const frameCounts = new Map<string, number>();
  const columnsCache = new Map<number, ColumnDef[]>();

  // Commands aimed at everyone, or at every component of one system, cannot be
  // filed while scanning: the source they belong to may not have sent a frame
  // yet. Everything with a concrete target is delivered on the spot, which is
  // what keeps MissionCollector's arrival order intact.
  const broadcastCommands: CommandEvent[] = [];
  const bySystemCommands = new Map<number, CommandEvent[]>();

  let minTime = Infinity;
  let maxTime = -Infinity;
  /**
   * Sources that have actually decoded a frame.
   *
   * Counted apart from `builds.size`, which also holds the placeholders
   * `targetBuild` opens for an address that has only been *sent to*. Those cost
   * almost nothing (no columns are ever pushed into them) and are dropped after
   * the scan, so letting them consume the budget would refuse a perfectly
   * ordinary log: a ground station addressing 256 components it never hears
   * back from would lock out the next real vehicle.
   */
  let decodedSources = 0;

  await scanTlog(
    source,
    (f, bytes) => {
      const key = `${f.sysid}/${f.compid}`;
      frameCounts.set(key, (frameCounts.get(key) ?? 0) + 1);

      const clazz = REGISTRY[f.msgid];
      if (!clazz) return;
      const payload = Buffer.from(bytes.subarray(f.payloadStart, f.payloadStart + f.plen));
      try {
        const msg = deserialize(payload, clazz);

        // Only once the frame is known to be real. Refusing earlier would let a
        // msgid no dialect defines — or one that fails to decode — turn away a
        // log with room to spare, since neither builds anything. And `decoded`
        // rather than `builds.has`, because an address can already have a build
        // from being the target of a command without having spoken itself.
        const seen = builds.get(key);
        if (!seen?.decoded && decodedSources >= MAX_SOURCES) {
          throw new TooManySources(
            `This file names more than ${MAX_SOURCES} distinct MAVLink sources, which no real ` +
              'session does — it is most likely corrupt or not a telemetry log.',
          );
        }

        if (f.ts < minTime) minTime = f.ts;
        if (f.ts > maxTime) maxTime = f.ts;

        // Only now, with a frame that decoded. Framing alone will hand back an
        // address out of any stretch of damage the reader resyncs through, and
        // a source list built from that offers the reader vehicles that never
        // flew.
        const build = buildFor(builds, key, f.sysid, f.compid);
        if (!build.decoded) {
          build.decoded = true;
          decodedSources++;
        }
        if (f.ts < build.minTime) build.minTime = f.ts;
        if (f.ts > build.maxTime) build.maxTime = f.ts;

        let columns = columnsCache.get(f.msgid);
        if (!columns) {
          columns = columnsFor(clazz, msg);
          columnsCache.set(f.msgid, columns);
        }
        build.builder.push(f.msgid, clazz.MSG_NAME, columns, msg, f.ts);

        const name = clazz.MSG_NAME;
        if (name === 'HEARTBEAT' && build.mavType === undefined) {
          const t = numberFrom(msg, 'type');
          if (Number.isFinite(t)) build.mavType = t;
        }

        const command = extractSpecial(build.special, name, msg, f.ts, { sysid: f.sysid, compid: f.compid });
        if (command) deliverCommand(builds, broadcastCommands, bySystemCommands, command);

        if (name === 'MISSION_ITEM_INT') forEachMissionTarget(builds, build, msg, (b) => addMissionItem(b.missionInt, msg, 1e-7));
        else if (name === 'MISSION_ITEM') forEachMissionTarget(builds, build, msg, (b) => addMissionItem(b.missionFloat, msg, 1));
        else if (name === 'MISSION_COUNT' && isFlightPlan(msg)) {
          // MISSION_COUNT opens every full transfer, up- or download, so it is
          // the one unambiguous "a new plan starts here" marker in the stream.
          forEachMissionTarget(builds, build, msg, (b) => {
            b.missionInt.beginTransfer();
            b.missionFloat.beginTransfer();
          });
        }
      } catch (err) {
        // The cap is the one thing this catch must not eat: it exists so a
        // single bad frame cannot end the scan, and refusing the file is the
        // opposite intent.
        if (err instanceof TooManySources) throw err;
        // ignore a malformed frame, keep scanning
      }
    },
    opts,
  );

  // Addresses that only ever appeared as a target, or out of a stretch of
  // damage, go before anything is delivered to them. The sample log addresses
  // 1,323 REQUEST_DATA_STREAMs to a 125/191 that never speaks; being talked at
  // is not being present, and offering it in the selector would invent a
  // vehicle. Whoever sent to it keeps its own copy either way.
  for (const [key, build] of [...builds]) if (!build.decoded) builds.delete(key);

  // Deferred commands land before anything is normalized, so every list is
  // sorted with its full contents. Delivering afterwards would leave the target
  // side out of time order, and the plot drops a marker's label the moment one
  // arrives behind the last one placed.
  for (const build of builds.values()) {
    build.special.commands.push(...broadcastCommands);
    const forSystem = bySystemCommands.get(build.sysid);
    if (forSystem) build.special.commands.push(...forSystem);
  }

  const sources: SourceInfo[] = [];
  const bySource = new Map<string, SourceData>();
  for (const [key, build] of builds) {
    const messages = build.builder.finalize();
    const mission = build.missionInt.finalize();
    bySource.set(key, {
      messages,
      params: build.special.params,
      // Labelled here rather than while scanning: the vehicle kind arrives with
      // the source's first HEARTBEAT, which need not precede its first mode.
      modes: build.special.modes.map((m) => ({
        ...m,
        mode: modeLabel(build.mavType === undefined ? null : kindFromMavType(build.mavType), m.modeNum),
      })),
      texts: build.special.texts,
      // Consumers are promised time order, and the plot's marker labels are laid
      // out left to right and silently drop any that arrives behind the last one
      // placed. What makes two entries at one instant the same event is the
      // MAV_CMD *and* who it was aimed at: a ground station telling two vehicles
      // to do the same thing in the same microsecond sent two commands, and
      // keying on the id alone would show only one of them.
      commands: normalizeEvents(build.special.commands, commandKey),
      missionSteps: normalizeEvents(build.special.missionSteps, (s) => s.seq),
      mission: mission.length ? mission : build.missionFloat.finalize(),
      // GLOBAL_POSITION_INT/GPS_RAW_INT: lat/lon in degE7, alt in mm.
      trajectory: extractTrajectory(messages, TRAJECTORY_SOURCES, HEADING_SOURCES),
    });
    sources.push({
      sysid: build.sysid,
      compid: build.compid,
      ...(build.mavType === undefined ? {} : { mavType: build.mavType }),
      ...(build.mavType === undefined ? {} : labelsFor(build.mavType, build.compid)),
      records: frameCounts.get(key) ?? 0,
      startTime: Number.isFinite(build.minTime) ? build.minTime : 0,
      endTime: Number.isFinite(build.maxTime) ? build.maxTime : 0,
    });
  }
  // Most talkative first: the vehicle is nearly always the busiest source, and
  // a reader scanning the list should meet it before the ground stations.
  sources.sort((a, b) => b.records - a.records);

  if (!Number.isFinite(minTime)) {
    minTime = 0;
    maxTime = 0;
  }

  return { source: 'tlog', sources, bySource, startTime: minTime, endTime: maxTime };
}

const TRAJECTORY_SOURCES: TrajCandidate[] = [
  { msg: 'GLOBAL_POSITION_INT', lat: 'lat', lon: 'lon', alt: 'relativeAlt', latScale: 1e-7, altScale: 1e-3 },
  { msg: 'GPS_RAW_INT', lat: 'lat', lon: 'lon', alt: 'alt', latScale: 1e-7, altScale: 1e-3 },
];

// Heading (degrees): hdg is cdeg (65535 = unknown); ATTITUDE.yaw is radians.
const HEADING_SOURCES: HeadingSource[] = [
  { msg: 'GLOBAL_POSITION_INT', field: 'hdg', scale: 0.01, unknown: 65535 },
  { msg: 'VFR_HUD', field: 'heading', scale: 1 },
  { msg: 'ATTITUDE', field: 'yaw', scale: 180 / Math.PI },
  { msg: 'GPS_RAW_INT', field: 'cog', scale: 0.01, unknown: 65535 },
];

/**
 * What makes two commands at the same instant the same command.
 *
 * All three parts are needed. One command is filed under both its sender and
 * its recipient, so a repeat is only a repeat when the MAV_CMD, who sent it and
 * who it was for all match. Two vehicles told to do the same thing in one
 * microsecond are two events; so are two ground stations telling one vehicle,
 * which a recipient's list holds side by side. What still collapses is the case
 * this exists for: the same frame reaching the same list twice.
 */
export function commandKey(c: CommandEvent): string {
  const from = `${c.source.sysid}/${c.source.compid}`;
  const to = c.target ? `${c.target.sysid}/${c.target.compid}` : '';
  return `${c.id}:${from}:${to}`;
}

/** One source mid-parse. Becomes a `SourceData` once the scan finishes. */
interface SourceBuild {
  sysid: number;
  compid: number;
  /** From this source's first HEARTBEAT; picks the mode table for its modes. */
  mavType?: number;
  /**
   * True once a frame from this address decoded.
   *
   * A build is also created for the target of a command or a mission transfer,
   * before anything is known about whether that address exists. This is what
   * separates "spoke" from "was spoken to", and it is the condition for
   * appearing in the source list at all.
   */
  decoded: boolean;
  minTime: number;
  maxTime: number;
  builder: LogBuilder;
  special: Special;
  /** MISSION_ITEM_INT is the current form and MISSION_ITEM the deprecated one;
   *  a session can carry both, so collect them apart and prefer the int form. */
  missionInt: MissionCollector;
  missionFloat: MissionCollector;
}

/**
 * `buildFor`, but declines to open a source once the cap is reached.
 *
 * Used by the two paths that create a build for an address that has not spoken
 * — the target of a command or a mission transfer. Those cannot raise the error
 * `parseTlog` throws for senders, because they run inside the per-frame `try`
 * that swallows a malformed frame. Declining instead keeps memory bounded and
 * loses nothing a reader can see: the sender always keeps its own copy, and a
 * target that never speaks is dropped after the scan regardless.
 */
function targetBuild(
  builds: Map<string, SourceBuild>,
  key: string,
  sysid: number,
  compid: number,
): SourceBuild | null {
  if (builds.size >= MAX_SOURCES && !builds.has(key)) return null;
  return buildFor(builds, key, sysid, compid);
}

function buildFor(builds: Map<string, SourceBuild>, key: string, sysid: number, compid: number): SourceBuild {
  let b = builds.get(key);
  if (!b) {
    b = {
      sysid,
      compid,
      decoded: false,
      minTime: Infinity,
      maxTime: -Infinity,
      builder: new LogBuilder(),
      special: {
        params: {},
        modes: [],
        texts: [],
        commands: [],
        missionSteps: [],
        lastModeNum: null,
        lastSeq: null,
      },
      missionInt: new MissionCollector(),
      missionFloat: new MissionCollector(),
    };
    builds.set(key, b);
  }
  return b;
}

const MAV_TYPE_NAMES: Record<number, string> = reverseMap(minimal.MavType);
const MAV_COMPONENT_NAMES: Record<number, string> = reverseMap(
  (common as unknown as Record<string, unknown>).MavComponent ??
    (minimal as unknown as Record<string, unknown>).MavComponent,
);

function labelsFor(mavType: number, compid: number): { typeLabel?: string; compLabel?: string } {
  const typeLabel = MAV_TYPE_NAMES[mavType];
  const compLabel = MAV_COMPONENT_NAMES[compid];
  return { ...(typeLabel ? { typeLabel } : {}), ...(compLabel ? { compLabel } : {}) };
}

/**
 * File a command under every source it involves, sender aside.
 *
 * The sender already has it — `extractSpecial` put it there — so this only adds
 * the receiving end. A target that never sends anything of its own is dropped
 * with its build at the end of the scan, which is how the sample log's 1,323
 * REQUEST_DATA_STREAMs addressed to a 125/191 that never speaks stay out of the
 * source list without a special case.
 */
function deliverCommand(
  builds: Map<string, SourceBuild>,
  broadcast: CommandEvent[],
  bySystem: Map<number, CommandEvent[]>,
  command: CommandEvent,
): void {
  const target = command.target;
  if (!target) return;
  if (target.sysid === 0) return void broadcast.push(command);
  if (!target.compid) {
    // compid 0 addresses every component of that system, and a missing field
    // (SET_MODE has no targetComponent) reads as NaN, which means the same.
    let list = bySystem.get(target.sysid);
    if (!list) bySystem.set(target.sysid, (list = []));
    return void list.push(command);
  }
  const key = `${target.sysid}/${target.compid}`;
  if (key === `${command.source.sysid}/${command.source.compid}`) return; // already filed
  targetBuild(builds, key, target.sysid, target.compid)?.special.commands.push(command);
}

/**
 * Run `apply` on the sender's collectors and on whoever the message is for.
 *
 * Immediate rather than deferred, unlike commands: `MissionCollector` reads a
 * transfer as an ordered run — `beginTransfer` clears, then items arrive — so
 * anything that reorders MISSION_COUNT against its items changes the plan.
 *
 * A component of 0 addresses every component of that system, the same as it
 * does for a command. Those go only to sources already seen, since a plan
 * cannot be delivered to an address that has not appeared yet without deferring
 * it — and deferring is exactly what the ordering above forbids. In a real
 * transfer both ends have been heartbeating for a while by the time a plan
 * moves, so the set is settled.
 */
function forEachMissionTarget(
  builds: Map<string, SourceBuild>,
  sender: SourceBuild,
  msg: Record<string, unknown>,
  apply: (b: SourceBuild) => void,
): void {
  apply(sender);
  const sys = numberFrom(msg, 'targetSystem');
  const comp = numberFrom(msg, 'targetComponent');
  if (!Number.isFinite(sys) || sys === 0) return;
  const senderKey = `${sender.sysid}/${sender.compid}`;

  if (!Number.isFinite(comp) || comp === 0) {
    for (const [key, b] of [...builds]) {
      if (b.sysid === sys && key !== senderKey) apply(b);
    }
    return;
  }
  const key = `${sys}/${comp}`;
  if (key === senderKey) return;
  const target = targetBuild(builds, key, sys, comp);
  if (target) apply(target);
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
  /** Collected with `mode` left empty; labelled once the source's MAV_TYPE is
   *  known, which its first HEARTBEAT need not have delivered by then. */
  modes: ModeChange[];
  texts: TextMessage[];
  commands: CommandEvent[];
  missionSteps: MissionStep[];
  /** Last mode number pushed, so a repeated HEARTBEAT does not log a change. */
  lastModeNum: number | null;
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

/**
 * Pull everything that is not just another column out of one message.
 *
 * Returns the `CommandEvent` it filed, when it filed one, so the caller can put
 * a copy under the source the command was aimed at as well — the sender is
 * always a ground station, so filing by sender alone would leave every vehicle
 * with no commands at all.
 */
function extractSpecial(
  st: Special,
  name: string,
  msg: Record<string, unknown>,
  time: number,
  src: SourceId,
): CommandEvent | null {
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
      if (typeof custom === 'number' && custom !== st.lastModeNum) {
        // `mode` is filled in after the scan, once this source's MAV_TYPE has
        // picked a table: 10 is AUTO on a Rover and AUTOTUNE on a Copter.
        st.modes.push({ time, mode: '', modeNum: custom });
        st.lastModeNum = custom;
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
      const targetSys = numberFrom(msg, 'targetSystem');
      const targetComp = numberFrom(msg, 'targetComponent');
      const event: CommandEvent = {
        time,
        id,
        name: cmdName,
        source: src,
        ...(Number.isFinite(targetSys)
          ? { target: { sysid: targetSys, compid: Number.isFinite(targetComp) ? targetComp : 0 } }
          : {}),
      };
      st.commands.push(event);
      return event;
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
  return null;
}
