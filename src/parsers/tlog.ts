// Telemetry log (.tlog) parser. A tlog is a flat sequence of records:
//   [8-byte big-endian uint64 timestamp, microseconds since UNIX epoch]
//   [one MAVLink v1 (0xFE) or v2 (0xFD) frame]
//
// We do the framing ourselves (so we keep each frame's timestamp) and decode the
// payload with mavlink-mappings message classes. We deliberately avoid importing
// `node-mavlink`'s top-level entry because it pulls in Node's stream/net/crypto;
// instead we reuse only the pure DESERIALIZERS table plus a tiny re-implementation
// of its field-decode loop.

import { Buffer } from 'buffer';
import { minimal, common, ardupilotmega } from 'mavlink-mappings';
import { DESERIALIZERS } from 'node-mavlink/dist/lib/serialization.js';
import type { LogData, ModeChange, TextMessage } from '../model/log.ts';
import type { LogSource } from './source.ts';
import type { ParseOptions } from './dataflash.ts';
import { LogBuilder, extractTrajectory, type ColumnDef } from './columnar.ts';
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

const REGISTRY: Registry = {
  ...(minimal.REGISTRY as unknown as Registry),
  ...(common.REGISTRY as unknown as Registry),
  ...(ardupilotmega.REGISTRY as unknown as Registry),
};

const V1_STX = 0xfe;
const V2_STX = 0xfd;
const V2_IFLAG_SIGNED = 0x01;

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
  const bytes = await source.read();
  const len = bytes.byteLength;

  const builder = new LogBuilder();
  const columnsCache = new Map<number, ColumnDef[]>();
  const params: Record<string, number> = {};
  const modes: ModeChange[] = [];
  const texts: TextMessage[] = [];
  // MISSION_ITEM_INT is the current form and MISSION_ITEM the deprecated one;
  // a session can carry both, so collect them apart and prefer the int form.
  const missionInt = new MissionCollector();
  const missionFloat = new MissionCollector();
  let minTime = Infinity;
  let maxTime = -Infinity;
  let lastMode = '';

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let lastProgress = 0;

  while (offset + 8 <= len) {
    const ts = Number(dv.getBigUint64(offset, false)); // microseconds, UNIX
    let p = offset + 8;
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

    const clazz = REGISTRY[msgid];
    if (clazz) {
      const payload = Buffer.from(bytes.subarray(payloadStart, payloadStart + plen));
      try {
        const msg = deserialize(payload, clazz);
        if (ts < minTime) minTime = ts;
        if (ts > maxTime) maxTime = ts;
        let columns = columnsCache.get(msgid);
        if (!columns) {
          columns = columnsFor(clazz, msg);
          columnsCache.set(msgid, columns);
        }
        builder.push(msgid, clazz.MSG_NAME, columns, msg, ts);
        lastMode = extractSpecial(clazz.MSG_NAME, msg, ts, params, modes, texts, lastMode);
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
    }

    offset = frameEnd;

    if (opts.onProgress) {
      const ratio = offset / len;
      if (ratio - lastProgress > 0.02) {
        lastProgress = ratio;
        opts.onProgress(ratio);
      }
    }
  }

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

  return {
    source: 'tlog',
    messages,
    params,
    modes,
    texts,
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

function extractSpecial(
  name: string,
  msg: Record<string, unknown>,
  time: number,
  params: Record<string, number>,
  modes: ModeChange[],
  texts: TextMessage[],
  lastMode: string,
): string {
  switch (name) {
    case 'PARAM_VALUE': {
      const id = msg['paramId'];
      const val = msg['paramValue'];
      if (typeof id === 'string' && typeof val === 'number') params[id] = val;
      break;
    }
    case 'STATUSTEXT': {
      const text = msg['text'];
      if (typeof text === 'string' && text.length) {
        texts.push({ time, text, severity: typeof msg['severity'] === 'number' ? (msg['severity'] as number) : undefined });
      }
      break;
    }
    case 'HEARTBEAT': {
      const custom = msg['customMode'];
      if (typeof custom === 'number') {
        const label = `Mode ${custom}`;
        if (label !== lastMode) {
          modes.push({ time, mode: label });
          return label;
        }
      }
      break;
    }
  }
  return lastMode;
}
