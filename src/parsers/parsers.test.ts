import { describe, it, expect } from 'vitest';
import { common } from 'mavlink-mappings';
import type { LogSource } from './source.ts';
import { parseDataflash } from './dataflash.ts';
import { parseTlog } from './tlog.ts';

// An in-memory LogSource so tests don't depend on the browser Blob/File APIs.
class MemorySource implements LogSource {
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

const HEAD1 = 0xa3;
const HEAD2 = 0x95;

function strBytes(s: string, len: number): number[] {
  const out = new Array(len).fill(0);
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i);
  return out;
}

function fmtMessage(type: number, name: string, format: string, columns: string): number[] {
  // FMT body layout: BBnNZ = Type, Length, Name(4), Format(16), Columns(64)
  const bodySize = format.length === 0 ? 0 : sizeOf(format);
  const length = 3 + bodySize;
  return [
    HEAD1, HEAD2, 0x80,
    type,
    length,
    ...strBytes(name, 4),
    ...strBytes(format, 16),
    ...strBytes(columns, 64),
  ];
}

function sizeOf(format: string): number {
  const sizes: Record<string, number> = { Q: 8, L: 4, f: 4, B: 1, N: 16, n: 4, Z: 64, i: 4, I: 4, h: 2 };
  return [...format].reduce((a, c) => a + sizes[c], 0);
}

function gpsMessage(type: number, timeUS: number, lat: number, lon: number, alt: number): number[] {
  const buf = new ArrayBuffer(3 + 20);
  const dv = new DataView(buf);
  const u = new Uint8Array(buf);
  u[0] = HEAD1;
  u[1] = HEAD2;
  u[2] = type;
  dv.setBigUint64(3, BigInt(timeUS), true);
  dv.setInt32(11, Math.round(lat * 1e7), true);
  dv.setInt32(15, Math.round(lon * 1e7), true);
  dv.setFloat32(19, alt, true);
  return [...u];
}

describe('parseDataflash', () => {
  it('parses a self-describing log and extracts trajectory', async () => {
    const GPS = 130;
    const bytes = new Uint8Array([
      ...fmtMessage(GPS, 'GPS', 'QLLf', 'TimeUS,Lat,Lng,Alt'),
      ...gpsMessage(GPS, 1_000_000, 35.0, 139.0, 100),
      ...gpsMessage(GPS, 2_000_000, 35.001, 139.001, 110),
      ...gpsMessage(GPS, 3_000_000, 35.002, 139.002, 120),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));

    expect(log.source).toBe('bin');
    expect(log.messages.GPS).toBeDefined();
    expect(log.messages.GPS.time.length).toBe(3);
    expect(Array.from(log.messages.GPS.fields.Alt)).toEqual([100, 110, 120]);
    expect(log.startTime).toBe(1_000_000);
    expect(log.endTime).toBe(3_000_000);

    expect(log.trajectory.lat.length).toBe(3);
    expect(log.trajectory.lat[0]).toBeCloseTo(35.0, 5);
    expect(log.trajectory.lon[2]).toBeCloseTo(139.002, 5);
    expect(log.trajectory.alt[1]).toBeCloseTo(110, 3);
  });

  it('stamps time-less messages with surrounding log time (no NaN axis)', async () => {
    // A message type with no TimeUS column must still get a finite time axis.
    const GPS = 140;
    const STAT = 141;
    const statBody = (val: number) => {
      const buf = new ArrayBuffer(3 + 4);
      const dv = new DataView(buf);
      const u = new Uint8Array(buf);
      u[0] = HEAD1; u[1] = HEAD2; u[2] = STAT;
      dv.setFloat32(3, val, true);
      return [...u];
    };
    const bytes = new Uint8Array([
      ...fmtMessage(GPS, 'GPS', 'QLLf', 'TimeUS,Lat,Lng,Alt'),
      ...fmtMessage(STAT, 'STAT', 'f', 'Val'),
      ...gpsMessage(GPS, 5_000_000, 1, 2, 3),
      ...statBody(42),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));
    expect(log.messages.STAT.time.length).toBe(1);
    expect(Number.isFinite(log.messages.STAT.time[0])).toBe(true);
    expect(log.messages.STAT.time[0]).toBe(5_000_000); // last seen TimeUS
  });

  it('produces identical results when streamed in tiny chunks (boundary spanning)', async () => {
    const GPS = 142;
    const bytes = new Uint8Array([
      ...fmtMessage(GPS, 'GPS', 'QLLf', 'TimeUS,Lat,Lng,Alt'),
      ...gpsMessage(GPS, 1_000_000, 35.0, 139.0, 100),
      ...gpsMessage(GPS, 2_000_000, 35.001, 139.001, 110),
      ...gpsMessage(GPS, 3_000_000, 35.002, 139.002, 120),
    ]);
    // chunkBytes:7 forces messages (and the FMT) to span chunk boundaries.
    const log = await parseDataflash(new MemorySource('t.bin', bytes), { chunkBytes: 7 });
    expect(log.messages.GPS.time.length).toBe(3);
    expect(Array.from(log.messages.GPS.fields.Alt)).toEqual([100, 110, 120]);
    expect(Array.from(log.messages.GPS.time)).toEqual([1_000_000, 2_000_000, 3_000_000]);
    expect(log.trajectory.lat.length).toBe(3);
    expect(log.trajectory.lon[2]).toBeCloseTo(139.002, 5);
  });

  it('resyncs past corrupt bytes', async () => {
    const GPS = 131;
    const bytes = new Uint8Array([
      0x00, 0xff, // junk
      ...fmtMessage(GPS, 'GPS', 'QLLf', 'TimeUS,Lat,Lng,Alt'),
      0x12, // junk between messages
      ...gpsMessage(GPS, 1_000_000, 1, 2, 3),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));
    expect(log.messages.GPS?.time.length).toBe(1);
  });
});

// ---- tlog (.tlog) ----

// Serialize a message payload using the class FIELDS metadata, then wrap it in a
// MAVLink v2 frame prefixed with an 8-byte big-endian timestamp (tlog format).
type MavField = { name: string; type: string; offset: number; size: number; length: number };

function writeField(dv: DataView, off: number, type: string, value: number): void {
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

function tlogRecord(timestampUs: number, clazz: { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] }, values: Record<string, number>): number[] {
  const plen = clazz.PAYLOAD_LENGTH;
  const payload = new ArrayBuffer(plen);
  const dv = new DataView(payload);
  for (const f of clazz.FIELDS) {
    if (f.name in values) writeField(dv, f.offset, f.type, values[f.name]);
  }
  const msgid = clazz.MSG_ID;
  const frame = [
    0xfd, plen, 0, 0, 0, 1, 1, msgid & 0xff, (msgid >> 8) & 0xff, (msgid >> 16) & 0xff,
    ...new Uint8Array(payload),
    0x00, 0x00, // crc (not validated by our parser)
  ];
  const ts = new ArrayBuffer(8);
  new DataView(ts).setBigUint64(0, BigInt(timestampUs), false);
  return [...new Uint8Array(ts), ...frame];
}

describe('parseTlog', () => {
  it('frames records, decodes messages and builds trajectory', async () => {
    const GPI = common.GlobalPositionInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, GPI, { lat: Math.round(35.0 * 1e7), lon: Math.round(139.0 * 1e7), relativeAlt: 50_000 }),
      ...tlogRecord(2_000_000, GPI, { lat: Math.round(35.01 * 1e7), lon: Math.round(139.01 * 1e7), relativeAlt: 60_000 }),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.source).toBe('tlog');
    expect(log.messages.GLOBAL_POSITION_INT).toBeDefined();
    expect(log.messages.GLOBAL_POSITION_INT.time.length).toBe(2);
    expect(log.trajectory.lat.length).toBe(2);
    expect(log.trajectory.lat[0]).toBeCloseTo(35.0, 4);
    expect(log.trajectory.lon[1]).toBeCloseTo(139.01, 4);
    expect(log.trajectory.alt[0]).toBeCloseTo(50, 2); // mm -> m
  });

  it('sorts a message series whose wall-clock timestamps arrive out of order', async () => {
    const GPI = common.GlobalPositionInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    // Records written newest-first (e.g. after a clock step) must come out sorted.
    const bytes = new Uint8Array([
      ...tlogRecord(2_000_000, GPI, { lat: Math.round(35.02 * 1e7), lon: Math.round(139.02 * 1e7), relativeAlt: 20_000 }),
      ...tlogRecord(1_000_000, GPI, { lat: Math.round(35.01 * 1e7), lon: Math.round(139.01 * 1e7), relativeAlt: 10_000 }),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));
    const t = log.messages.GLOBAL_POSITION_INT.time;
    expect(Array.from(t)).toEqual([1_000_000, 2_000_000]);
    // The lat column must be reordered together with time.
    expect(log.messages.GLOBAL_POSITION_INT.fields.lat[0]).toBeCloseTo(35.01 * 1e7, 0);
    expect(log.trajectory.lat[0]).toBeCloseTo(35.01, 4);
    expect(log.trajectory.lat[1]).toBeCloseTo(35.02, 4);
  });
});
