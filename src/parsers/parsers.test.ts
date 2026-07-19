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
  const sizes: Record<string, number> = { Q: 8, L: 4, f: 4, B: 1, N: 16, n: 4, Z: 64, i: 4, I: 4, h: 2, H: 2 };
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

// A mission item in the shared log_Cmd layout. Lat/Lng use the `L` format char,
// i.e. int32 degE7 that formatChars scales back to degrees while decoding.
const CMD_FORMAT = 'QHHHffffLLfB';
const CMD_COLUMNS = 'TimeUS,CTot,CNum,CId,Prm1,Prm2,Prm3,Prm4,Lat,Lng,Alt,Frame';

function cmdMessage(
  type: number,
  opts: {
    seq: number; total?: number; id?: number; alt?: number; timeUS?: number;
    /** Degrees; written as degE7 the way the `L` format char expects. */
    lat?: number; lon?: number;
    /** Raw int32 written verbatim, for logs that declare Lat/Lng unscaled. */
    latRaw?: number; lonRaw?: number;
  },
): number[] {
  const buf = new ArrayBuffer(3 + sizeOf(CMD_FORMAT));
  const dv = new DataView(buf);
  const u = new Uint8Array(buf);
  u[0] = HEAD1;
  u[1] = HEAD2;
  u[2] = type;
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

  it('extracts the mission from CMD, dropping commands that are not path vertices', async () => {
    const CMD = 150;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(CMD, { seq: 0, total: 5, lat: 35.0, lon: 139.0, alt: 0 }),
      ...cmdMessage(CMD, { seq: 1, total: 5, id: 22, lat: 35.001, lon: 139.001, alt: 20 }),
      // RTL (20) carries no location at all — ArduPilot stores zeros.
      ...cmdMessage(CMD, { seq: 2, total: 5, id: 20, lat: 0, lon: 0 }),
      // DO_JUMP (177) is the dangerous one: its x/y are a target index and a
      // repeat count passed through unscaled, so they look like a position.
      ...cmdMessage(CMD, { seq: 3, total: 5, id: 177, lat: 4, lon: 2 }),
      ...cmdMessage(CMD, { seq: 4, total: 5, lat: 35.002, lon: 139.002, alt: 30 }),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1, 4]);
    expect(log.mission[1].command).toBe(22);
    expect(log.mission[1].lat).toBeCloseTo(35.001, 5);
    expect(log.mission[1].lon).toBeCloseTo(139.001, 5);
    expect(log.mission[1].alt).toBeCloseTo(20, 3);
    expect(log.mission[1].frame).toBe(3);
  });

  it('drops "here" placeholders that TAKEOFF and LAND store as a zero position', async () => {
    const CMD = 151;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(CMD, { seq: 0, id: 22, lat: 0, lon: 0, alt: 10 }), // takeoff here
      ...cmdMessage(CMD, { seq: 1, lat: 35.001, lon: 139.001 }),
      ...cmdMessage(CMD, { seq: 2, id: 21, lat: 0, lon: 0 }), // land here
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));
    expect(log.mission.map((w) => w.seq)).toEqual([1]);
  });

  it('keeps only the newest plan when the mission is re-dumped after a change', async () => {
    // CMD re-dumps the whole mission on every change, so a shorter second plan
    // must not leave the first plan's seq 2 behind.
    const CMD = 152;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(CMD, { seq: 0, total: 3, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(CMD, { seq: 1, total: 3, lat: 35.001, lon: 139.001 }),
      ...cmdMessage(CMD, { seq: 2, total: 3, lat: 35.002, lon: 139.002 }),
      ...cmdMessage(CMD, { seq: 0, total: 2, lat: 36.0, lon: 140.0 }),
      ...cmdMessage(CMD, { seq: 1, total: 2, lat: 36.001, lon: 140.001 }),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
    expect(log.mission[0].lat).toBeCloseTo(36.0, 5);
  });

  it('ignores MISE, which traces execution rather than listing the plan', async () => {
    // MISE shares CMD's layout but logs an item as it starts running, so a
    // DO_JUMP loop repeats indices and an aborted mission never reaches the end.
    const CMD = 153;
    const MISE = 154;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
      ...fmtMessage(MISE, 'MISE', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(CMD, { seq: 0, total: 3, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(CMD, { seq: 1, total: 3, lat: 35.001, lon: 139.001 }),
      ...cmdMessage(CMD, { seq: 2, total: 3, lat: 35.002, lon: 139.002 }),
      ...cmdMessage(MISE, { seq: 1, lat: 35.001, lon: 139.001 }),
      ...cmdMessage(MISE, { seq: 2, lat: 35.002, lon: 139.002 }),
      ...cmdMessage(MISE, { seq: 1, lat: 35.001, lon: 139.001 }),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1, 2]);
  });

  it('reports an empty mission for a log that carries no plan', async () => {
    const GPS = 155;
    const bytes = new Uint8Array([
      ...fmtMessage(GPS, 'GPS', 'QLLf', 'TimeUS,Lat,Lng,Alt'),
      ...gpsMessage(GPS, 1_000_000, 35.0, 139.0, 100),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));
    expect(log.mission).toEqual([]);
  });

  it('rejects mission coordinates that are off the globe', async () => {
    // A resync through damage can hand us a row with a plausible command id and
    // nonsense coordinates. One is enough to throw the route line and, on a log
    // with no trajectory, the initial camera.
    const CMD = 156;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(CMD, { seq: 0, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(CMD, { seq: 1, latRaw: 2147483647, lonRaw: 2147483647 }),
      ...cmdMessage(CMD, { seq: 2, lat: 35.002, lon: 139.002 }),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));
    expect(log.mission.map((w) => w.seq)).toEqual([0, 2]);
  });

  it('scales a lat/lon pair together, never one axis alone', async () => {
    // A log declaring Lat/Lng as raw integers arrives unscaled. Judging each
    // axis on its own magnitude would scale the latitude and leave a longitude
    // under 180 as-is, silently relocating the waypoint instead of failing.
    const CMD = 157;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', 'QHHHffffiifB', CMD_COLUMNS), // `i` = raw int32
      ...cmdMessage(CMD, { seq: 0, latRaw: 350000000, lonRaw: 1000000 }),
    ]);
    const log = await parseDataflash(new MemorySource('t.bin', bytes));
    expect(log.mission[0].lat).toBeCloseTo(35, 6);
    expect(log.mission[0].lon).toBeCloseTo(0.1, 6);
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

  it('extracts the mission from MISSION_ITEM_INT, undoing degE7 scaling', async () => {
    const MI = common.MissionItemInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const item = (seq: number, lat: number, lon: number, alt: number, command = 16) => ({
      seq, command, frame: 3, x: Math.round(lat * 1e7), y: Math.round(lon * 1e7), z: alt,
    });
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MI, item(0, 35.0, 139.0, 0)),
      ...tlogRecord(1_100_000, MI, item(1, 35.001, 139.001, 50, 22)),
      ...tlogRecord(1_200_000, MI, item(2, 35.002, 139.002, 50)),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1, 2]);
    expect(log.mission[1].lat).toBeCloseTo(35.001, 5);
    expect(log.mission[1].lon).toBeCloseTo(139.001, 5);
    expect(log.mission[1].alt).toBeCloseTo(50, 3);
    expect(log.mission[1].command).toBe(22);
    expect(log.mission[1].frame).toBe(3);
  });

  it('does not let a fence or rally download discard the mission', async () => {
    // Fence and rally transfers reuse MISSION_ITEM_INT with their own
    // mission_type, and restart at seq 0. Without the mission_type filter their
    // sequence numbers would read as a re-uploaded plan and wipe the real one.
    const MI = common.MissionItemInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const deg = (d: number) => Math.round(d * 1e7);
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MI, { seq: 0, command: 16, frame: 3, x: deg(35.0), y: deg(139.0), z: 0, missionType: 0 }),
      ...tlogRecord(1_100_000, MI, { seq: 1, command: 16, frame: 3, x: deg(35.001), y: deg(139.001), z: 50, missionType: 0 }),
      // MAV_MISSION_TYPE_FENCE = 1, MAV_MISSION_TYPE_RALLY = 2.
      ...tlogRecord(1_200_000, MI, { seq: 0, command: 5001, frame: 3, x: deg(36.0), y: deg(140.0), z: 0, missionType: 1 }),
      ...tlogRecord(1_300_000, MI, { seq: 1, command: 5001, frame: 3, x: deg(36.001), y: deg(140.001), z: 0, missionType: 1 }),
      ...tlogRecord(1_400_000, MI, { seq: 0, command: 5100, frame: 3, x: deg(37.0), y: deg(141.0), z: 0, missionType: 2 }),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
    expect(log.mission[0].lat).toBeCloseTo(35.0, 5);
    expect(log.mission[1].lat).toBeCloseTo(35.001, 5);
  });

  it('keeps the plan when an item repeats mid-transfer or only a range is rewritten', async () => {
    // Neither of these starts a new plan, though both repeat a sequence number:
    // seq 2 is retried during the download, then a partial-list write rewrites
    // seq 1 alone. Treating either as a new transfer would discard the rest.
    const MI = common.MissionItemInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const deg = (d: number) => Math.round(d * 1e7);
    const item = (seq: number, lat: number, lon: number) =>
      ({ seq, command: 16, frame: 3, x: deg(lat), y: deg(lon), z: 50, missionType: 0 });
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MI, item(0, 35.0, 139.0)),
      ...tlogRecord(1_100_000, MI, item(1, 35.001, 139.001)),
      ...tlogRecord(1_200_000, MI, item(2, 35.002, 139.002)),
      ...tlogRecord(1_300_000, MI, item(2, 35.002, 139.002)), // retry
      ...tlogRecord(1_400_000, MI, item(3, 35.003, 139.003)),
      ...tlogRecord(1_500_000, MI, item(1, 35.009, 139.009)), // partial rewrite
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1, 2, 3]);
    expect(log.mission[1].lat).toBeCloseTo(35.009, 5); // the rewrite won
  });

  it('takes MISSION_COUNT as the transfer boundary, so a partial rewrite merges', async () => {
    // Rewriting seq 0..1 of a longer plan has no MISSION_COUNT, so it must merge
    // rather than truncate — the case the seq-0 fallback on its own gets wrong.
    const MI = common.MissionItemInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const MC = common.MissionCount as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const deg = (d: number) => Math.round(d * 1e7);
    const item = (seq: number, lat: number) =>
      ({ seq, command: 16, frame: 3, x: deg(lat), y: deg(139.0), z: 50, missionType: 0 });
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MC, { count: 4, missionType: 0 }),
      ...tlogRecord(1_100_000, MI, item(0, 35.0)),
      ...tlogRecord(1_200_000, MI, item(1, 35.001)),
      ...tlogRecord(1_300_000, MI, item(2, 35.002)),
      ...tlogRecord(1_400_000, MI, item(3, 35.003)),
      // No MISSION_COUNT: a partial-list write of seq 0..1 only.
      ...tlogRecord(1_500_000, MI, item(0, 36.0)),
      ...tlogRecord(1_600_000, MI, item(1, 36.001)),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1, 2, 3]);
    expect(log.mission[0].lat).toBeCloseTo(36.0, 5); // rewritten
    expect(log.mission[3].lat).toBeCloseTo(35.003, 5); // survived
  });

  it('discards the previous plan when a new full transfer is announced', async () => {
    const MI = common.MissionItemInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const MC = common.MissionCount as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const deg = (d: number) => Math.round(d * 1e7);
    const item = (seq: number, lat: number) =>
      ({ seq, command: 16, frame: 3, x: deg(lat), y: deg(139.0), z: 50, missionType: 0 });
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MC, { count: 3, missionType: 0 }),
      ...tlogRecord(1_100_000, MI, item(0, 35.0)),
      ...tlogRecord(1_200_000, MI, item(1, 35.001)),
      ...tlogRecord(1_300_000, MI, item(2, 35.002)),
      // A shorter plan replaces it; the old tail must not survive.
      ...tlogRecord(1_400_000, MC, { count: 2, missionType: 0 }),
      ...tlogRecord(1_500_000, MI, item(0, 36.0)),
      ...tlogRecord(1_600_000, MI, item(1, 36.001)),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
    expect(log.mission[0].lat).toBeCloseTo(36.0, 5);
  });

  it('ignores a fence MISSION_COUNT, which must not clear the flight plan', async () => {
    const MI = common.MissionItemInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const MC = common.MissionCount as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const deg = (d: number) => Math.round(d * 1e7);
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MC, { count: 2, missionType: 0 }),
      ...tlogRecord(1_100_000, MI, { seq: 0, command: 16, frame: 3, x: deg(35.0), y: deg(139.0), z: 0, missionType: 0 }),
      ...tlogRecord(1_200_000, MI, { seq: 1, command: 16, frame: 3, x: deg(35.001), y: deg(139.001), z: 50, missionType: 0 }),
      ...tlogRecord(1_300_000, MC, { count: 4, missionType: 1 }), // fence transfer
      ...tlogRecord(1_400_000, MI, { seq: 0, command: 5001, frame: 3, x: deg(36.0), y: deg(140.0), z: 0, missionType: 1 }),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
  });

  it('prefers MISSION_ITEM_INT over the deprecated float form when both appear', async () => {
    const MI = common.MissionItemInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const MF = common.MissionItem as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MF, { seq: 0, command: 16, frame: 3, x: 10.0, y: 20.0, z: 5 }),
      ...tlogRecord(1_100_000, MI, {
        seq: 0, command: 16, frame: 3, x: Math.round(35.0 * 1e7), y: Math.round(139.0 * 1e7), z: 50, missionType: 0,
      }),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.length).toBe(1);
    expect(log.mission[0].lat).toBeCloseTo(35.0, 5); // the int form won
  });

  it('reads the deprecated float-degree MISSION_ITEM when that is all there is', async () => {
    const MI = common.MissionItem as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MI, { seq: 0, command: 16, frame: 3, x: 35.0, y: 139.0, z: 10 }),
      ...tlogRecord(1_100_000, MI, { seq: 1, command: 16, frame: 3, x: 35.001, y: 139.001, z: 20 }),
    ]);
    const log = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
    // x/y are float32 here, so 139.001 only survives to about six digits.
    expect(log.mission[1].lat).toBeCloseTo(35.001, 4);
    expect(log.mission[1].lon).toBeCloseTo(139.001, 4);
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
