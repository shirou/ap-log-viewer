// Hand-built log fixtures shared by the parser tests and the slicer tests.
//
// One source of truth on purpose: the slicer's whole claim is that it frames
// records exactly the way the reader does, and two sets of fixtures drifting
// apart would hide the first place that stopped being true.
//
// Not a `.test.ts` file, so vitest's default glob leaves it alone.

import type { LogSource } from './source.ts';
import { HEAD1, HEAD2 } from './dataflash.ts';
import { formatSize } from './formatChars.ts';

export { HEAD1, HEAD2 };

/** An in-memory LogSource, so tests need no browser Blob/File. */
export class MemorySource implements LogSource {
  constructor(
    readonly name: string,
    private readonly bytes: Uint8Array,
  ) {}
  get size() {
    return this.bytes.byteLength;
  }
  async read(range?: { start: number; end: number }) {
    return range ? this.bytes.subarray(range.start, range.end) : this.bytes;
  }
}

// ---- DataFlash (.bin) ----

export function strBytes(s: string, len: number): number[] {
  const out = new Array(len).fill(0);
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Byte size of a format string, via the reader's own table. */
export const sizeOf = formatSize;

export function fmtMessage(type: number, name: string, format: string, columns: string): number[] {
  // FMT body layout: BBnNZ = Type, Length, Name(4), Format(16), Columns(64)
  const length = 3 + sizeOf(format);
  return [
    HEAD1, HEAD2, 0x80,
    type,
    length,
    ...strBytes(name, 4),
    ...strBytes(format, 16),
    ...strBytes(columns, 64),
  ];
}

/** The FMT record every real log opens with: the format table describing itself. */
export function fmtForFmtMessage(): number[] {
  return fmtMessage(0x80, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns');
}

/** A record header plus a body the caller fills in. */
function record(type: number, bodySize: number): { u: Uint8Array; dv: DataView } {
  const buf = new ArrayBuffer(3 + bodySize);
  const u = new Uint8Array(buf);
  u[0] = HEAD1;
  u[1] = HEAD2;
  u[2] = type;
  return { u, dv: new DataView(buf) };
}

export const GPS_FORMAT = 'QLLf';
export const GPS_COLUMNS = 'TimeUS,Lat,Lng,Alt';

export function gpsMessage(type: number, timeUS: number, lat: number, lon: number, alt: number): number[] {
  const { u, dv } = record(type, sizeOf(GPS_FORMAT));
  dv.setBigUint64(3, BigInt(timeUS), true);
  dv.setInt32(11, Math.round(lat * 1e7), true);
  dv.setInt32(15, Math.round(lon * 1e7), true);
  dv.setFloat32(19, alt, true);
  return [...u];
}

export const PARM_FORMAT = 'QNf';
export const PARM_COLUMNS = 'TimeUS,Name,Value';

export function parmMessage(type: number, timeUS: number, name: string, value: number): number[] {
  const { u, dv } = record(type, sizeOf(PARM_FORMAT));
  dv.setBigUint64(3, BigInt(timeUS), true);
  u.set(strBytes(name, 16), 11);
  dv.setFloat32(27, value, true);
  return [...u];
}

/**
 * A parameter record with no TimeUS column.
 *
 * The reader stamps these with the last time it saw, so they are how a slice's
 * time anchoring gets tested. `dataflash.ts` calls out "some PARM" as really
 * being written this way.
 */
export const PARM_NOTIME_FORMAT = 'Nf';
export const PARM_NOTIME_COLUMNS = 'Name,Value';

export function parmNoTimeMessage(type: number, name: string, value: number): number[] {
  const { u, dv } = record(type, sizeOf(PARM_NOTIME_FORMAT));
  u.set(strBytes(name, 16), 3);
  dv.setFloat32(19, value, true);
  return [...u];
}

export const UNIT_FORMAT = 'QbZ';
export const UNIT_COLUMNS = 'TimeUS,Id,Label';

export function unitMessage(type: number, timeUS: number, id: number, label: string): number[] {
  const { u, dv } = record(type, sizeOf(UNIT_FORMAT));
  dv.setBigUint64(3, BigInt(timeUS), true);
  dv.setInt8(11, id);
  u.set(strBytes(label, 64), 12);
  return [...u];
}

export const MODE_FORMAT = 'QMBB';
export const MODE_COLUMNS = 'TimeUS,Mode,ModeNum,Rsn';

export function modeMessage(type: number, timeUS: number, mode: number): number[] {
  const { u, dv } = record(type, sizeOf(MODE_FORMAT));
  dv.setBigUint64(3, BigInt(timeUS), true);
  dv.setUint8(11, mode);
  dv.setUint8(12, mode);
  dv.setUint8(13, 0);
  return [...u];
}

/** The firmware banner lines. `QZ` is the real MSG layout. */
export const MSG_FORMAT = 'QZ';
export const MSG_COLUMNS = 'TimeUS,Message';

export function msgMessage(type: number, timeUS: number, text: string): number[] {
  const { u, dv } = record(type, sizeOf(MSG_FORMAT));
  dv.setBigUint64(3, BigInt(timeUS), true);
  u.set(strBytes(text, 64), 11);
  return [...u];
}

/** A firmware version record. Simplified, but the reader only reads its name. */
export const VER_FORMAT = 'QBBHH';
export const VER_COLUMNS = 'TimeUS,BT,BST,Maj,Min';

export function verMessage(type: number, timeUS: number, major: number, minor: number): number[] {
  const { u, dv } = record(type, sizeOf(VER_FORMAT));
  dv.setBigUint64(3, BigInt(timeUS), true);
  dv.setUint8(11, 0);
  dv.setUint8(12, 0);
  dv.setUint16(13, major, true);
  dv.setUint16(15, minor, true);
  return [...u];
}

// A mission item in the shared log_Cmd layout. Lat/Lng use the `L` format char,
// i.e. int32 degE7 that formatChars scales back to degrees while decoding.
export const CMD_FORMAT = 'QHHHffffLLfB';
export const CMD_COLUMNS = 'TimeUS,CTot,CNum,CId,Prm1,Prm2,Prm3,Prm4,Lat,Lng,Alt,Frame';

export function cmdMessage(
  type: number,
  opts: {
    seq: number; total?: number; id?: number; alt?: number; timeUS?: number;
    /** Degrees; written as degE7 the way the `L` format char expects. */
    lat?: number; lon?: number;
    /** Raw int32 written verbatim, for logs that declare Lat/Lng unscaled. */
    latRaw?: number; lonRaw?: number;
  },
): number[] {
  const { u, dv } = record(type, sizeOf(CMD_FORMAT));
  dv.setBigUint64(3, BigInt(opts.timeUS ?? 1_000_000), true);
  dv.setUint16(11, opts.total ?? 0, true); // CTot
  dv.setUint16(13, opts.seq, true); // CNum
  dv.setUint16(15, opts.id ?? 16, true); // CId (16 = NAV_WAYPOINT)
  dv.setInt32(33, opts.latRaw ?? Math.round((opts.lat ?? 0) * 1e7), true); // Lat (after Prm1..Prm4)
  dv.setInt32(37, opts.lonRaw ?? Math.round((opts.lon ?? 0) * 1e7), true); // Lng
  dv.setFloat32(41, opts.alt ?? 0, true); // Alt
  dv.setUint8(45, 3); // Frame = MAV_FRAME_GLOBAL_RELATIVE_ALT
  return [...u];
}

// ---- Telemetry (.tlog) ----

/** The shape of a mavlink-mappings FIELDS entry, as much as fixtures need. */
export type MavField = { name: string; type: string; offset: number; size: number; length: number };

export interface MavClassLike {
  MSG_ID: number;
  PAYLOAD_LENGTH: number;
  FIELDS: MavField[];
}

export function writeField(dv: DataView, off: number, type: string, value: number): void {
  switch (type) {
    case 'uint8_t': case 'char': dv.setUint8(off, value); break;
    case 'int8_t': dv.setInt8(off, value); break;
    case 'uint16_t': dv.setUint16(off, value, true); break;
    case 'int16_t': dv.setInt16(off, value, true); break;
    case 'uint32_t': dv.setUint32(off, value >>> 0, true); break;
    case 'int32_t': dv.setInt32(off, value, true); break;
    case 'float': dv.setFloat32(off, value, true); break;
    default: break;
  }
}

export interface TlogRecordOptions {
  /** MAVLink 1 framing (0xFE) instead of 2 (0xFD). */
  v1?: boolean;
  /** Set the signed incompat flag and append the 13-byte signature. */
  signed?: boolean;
  sysid?: number;
  compid?: number;
  /** ASCII fields written verbatim, e.g. PARAM_VALUE's paramId. */
  strings?: Record<string, string>;
  /**
   * Cut the payload to this many bytes and shorten `plen` to match.
   *
   * MAVLink 2 trims trailing zeros off the wire, so a real frame routinely
   * carries fewer bytes than the message declares — which is exactly the case a
   * reader clamping into a payload has to survive.
   */
  truncateTo?: number;
}

/**
 * One `[8-byte BE stamp][MAVLink frame]` record.
 *
 * The CRC is left at zero: neither this reader nor the slicer checks it, which
 * is worth knowing — these fixtures are valid input here but would not satisfy a
 * reader that does verify.
 */
export function tlogRecord(
  timestampUs: number,
  clazz: MavClassLike,
  values: Record<string, number>,
  opts: TlogRecordOptions = {},
): number[] {
  const plen = clazz.PAYLOAD_LENGTH;
  const payload = new ArrayBuffer(plen);
  const dv = new DataView(payload);
  const bytes = new Uint8Array(payload);
  for (const f of clazz.FIELDS) {
    if (f.name in values) writeField(dv, f.offset, f.type, values[f.name]);
    const s = opts.strings?.[f.name];
    if (s !== undefined) bytes.set(strBytes(s, 16).slice(0, plen - f.offset), f.offset);
  }
  const msgid = clazz.MSG_ID;
  const sysid = opts.sysid ?? 1;
  const compid = opts.compid ?? 1;
  // Written at full length, then cut: the fields land where the message declares
  // them, and the trim takes off whatever the wire would have dropped.
  const wire = opts.truncateTo == null ? bytes : bytes.subarray(0, opts.truncateTo);
  const wlen = wire.length;
  const frame = opts.v1
    ? [0xfe, wlen, 0, sysid, compid, msgid & 0xff, ...wire, 0x00, 0x00]
    : [
        0xfd, wlen, opts.signed ? 1 : 0, 0, 0, sysid, compid,
        msgid & 0xff, (msgid >> 8) & 0xff, (msgid >> 16) & 0xff,
        ...wire,
        0x00, 0x00,
        ...(opts.signed ? new Array(13).fill(0) : []),
      ];
  const ts = new ArrayBuffer(8);
  new DataView(ts).setBigUint64(0, BigInt(timestampUs), false);
  return [...new Uint8Array(ts), ...frame];
}
