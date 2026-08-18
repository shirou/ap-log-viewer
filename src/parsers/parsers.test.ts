import { describe, it, expect } from 'vitest';
import { common, minimal } from 'mavlink-mappings';
import { parseDataflash, type ParseOptions } from './dataflash.ts';
import { parseTlog } from './tlog.ts';
import { projectLog } from './project.ts';
import { ALL_SOURCES } from '../model/log.ts';
import {
  CMD_COLUMNS,
  CMD_FORMAT,
  HEAD1,
  HEAD2,
  MemorySource,
  cmdMessage,
  fmtMessage,
  gpsMessage,
  tlogRecord,
  type MavField,
} from './testFixtures.ts';

// Both parsers now hand back every MAVLink source separately. These tests were
// written before that split and are about framing, formats and extraction
// rather than about which vehicle said what, so they read the projection that
// keeps every source — which for a .bin is the only one there has ever been.
const parseBin = async (src: MemorySource, opts?: ParseOptions) =>
  projectLog(await parseDataflash(src, opts), ALL_SOURCES);
const parseTelemetry = async (src: MemorySource, opts?: ParseOptions) =>
  projectLog(await parseTlog(src, opts), ALL_SOURCES);

describe('parseDataflash', () => {
  it('parses a self-describing log and extracts trajectory', async () => {
    const GPS = 130;
    const bytes = new Uint8Array([
      ...fmtMessage(GPS, 'GPS', 'QLLf', 'TimeUS,Lat,Lng,Alt'),
      ...gpsMessage(GPS, 1_000_000, 35.0, 139.0, 100),
      ...gpsMessage(GPS, 2_000_000, 35.001, 139.001, 110),
      ...gpsMessage(GPS, 3_000_000, 35.002, 139.002, 120),
    ]);
    const log = await parseBin(new MemorySource('t.bin', bytes));

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
    const log = await parseBin(new MemorySource('t.bin', bytes));
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
    const log = await parseBin(new MemorySource('t.bin', bytes), { chunkBytes: 7 });
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
    const log = await parseBin(new MemorySource('t.bin', bytes));

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
    const log = await parseBin(new MemorySource('t.bin', bytes));
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
    const log = await parseBin(new MemorySource('t.bin', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
    expect(log.mission[0].lat).toBeCloseTo(36.0, 5);
  });

  // MISE shares CMD's layout but logs an item as it starts running, so a DO_JUMP
  // loop repeats indices and an aborted mission never reaches the end. That makes
  // it the wrong source for the plan and the right one for progress through it.
  it('reads MISE as mission progress and CMD as the plan', async () => {
    const CMD = 153;
    const MISE = 154;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
      ...fmtMessage(MISE, 'MISE', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(CMD, { seq: 0, total: 3, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(CMD, { seq: 1, total: 3, lat: 35.001, lon: 139.001 }),
      ...cmdMessage(CMD, { seq: 2, total: 3, lat: 35.002, lon: 139.002 }),
      ...cmdMessage(MISE, { seq: 1, timeUS: 2_000_000, lat: 35.001, lon: 139.001 }),
      ...cmdMessage(MISE, { seq: 2, timeUS: 3_000_000, lat: 35.002, lon: 139.002 }),
      // A DO_JUMP sends it back round; that is a step, not a duplicate.
      ...cmdMessage(MISE, { seq: 1, timeUS: 4_000_000, lat: 35.001, lon: 139.001 }),
    ]);
    const log = await parseBin(new MemorySource('t.bin', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1, 2]);
    expect(log.missionSteps).toEqual([
      { time: 2_000_000, seq: 1 },
      { time: 3_000_000, seq: 2 },
      { time: 4_000_000, seq: 1 },
    ]);
  });

  it('collapses a MISE the reader saw twice on one timestamp', async () => {
    // This parser resyncs through damage, so one record can be decoded twice.
    // A mission item cannot start twice within a microsecond.
    const MISE = 159;
    const bytes = new Uint8Array([
      ...fmtMessage(MISE, 'MISE', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(MISE, { seq: 2, timeUS: 5_000_000, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(MISE, { seq: 2, timeUS: 5_000_000, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(MISE, { seq: 3, timeUS: 6_000_000, lat: 35.001, lon: 139.001 }),
    ]);
    const log = await parseBin(new MemorySource('t.bin', bytes));

    expect(log.missionSteps).toEqual([
      { time: 5_000_000, seq: 2 },
      { time: 6_000_000, seq: 3 },
    ]);
  });

  it('collapses a MISE duplicated across an intervening record', async () => {
    // The resynced copy need not land next to the original.
    const MISE = 160;
    const bytes = new Uint8Array([
      ...fmtMessage(MISE, 'MISE', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(MISE, { seq: 2, timeUS: 5_000_000, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(MISE, { seq: 3, timeUS: 6_000_000, lat: 35.001, lon: 139.001 }),
      ...cmdMessage(MISE, { seq: 2, timeUS: 5_000_000, lat: 35.0, lon: 139.0 }),
    ]);
    const log = await parseBin(new MemorySource('t.bin', bytes));

    expect(log.missionSteps).toEqual([
      { time: 5_000_000, seq: 2 },
      { time: 6_000_000, seq: 3 },
    ]);
  });

  it('reports no mission progress for a log written before MISE existed', async () => {
    const CMD = 158;
    const bytes = new Uint8Array([
      ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
      ...cmdMessage(CMD, { seq: 0, total: 2, lat: 35.0, lon: 139.0 }),
      ...cmdMessage(CMD, { seq: 1, total: 2, lat: 35.001, lon: 139.001 }),
    ]);
    const log = await parseBin(new MemorySource('t.bin', bytes));

    // CMD is the plan being re-dumped, not the vehicle reaching anything, so it
    // must not be mistaken for progress.
    expect(log.missionSteps).toEqual([]);
    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
  });

  it('reports an empty mission for a log that carries no plan', async () => {
    const GPS = 155;
    const bytes = new Uint8Array([
      ...fmtMessage(GPS, 'GPS', 'QLLf', 'TimeUS,Lat,Lng,Alt'),
      ...gpsMessage(GPS, 1_000_000, 35.0, 139.0, 100),
    ]);
    const log = await parseBin(new MemorySource('t.bin', bytes));
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
    const log = await parseBin(new MemorySource('t.bin', bytes));
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
    const log = await parseBin(new MemorySource('t.bin', bytes));
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
    const log = await parseBin(new MemorySource('t.bin', bytes));
    expect(log.messages.GPS?.time.length).toBe(1);
  });
});

// ---- tlog (.tlog) ----

// Serialize a message payload using the class FIELDS metadata, then wrap it in a
// MAVLink v2 frame prefixed with an 8-byte big-endian timestamp (tlog format).
describe('parseTlog', () => {
  it('frames records, decodes messages and builds trajectory', async () => {
    const GPI = common.GlobalPositionInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, GPI, { lat: Math.round(35.0 * 1e7), lon: Math.round(139.0 * 1e7), relativeAlt: 50_000 }),
      ...tlogRecord(2_000_000, GPI, { lat: Math.round(35.01 * 1e7), lon: Math.round(139.01 * 1e7), relativeAlt: 60_000 }),
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

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
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

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
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

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
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

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
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

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
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

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
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

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
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.mission.length).toBe(1);
    expect(log.mission[0].lat).toBeCloseTo(35.0, 5); // the int form won
  });

  it('reads the deprecated float-degree MISSION_ITEM when that is all there is', async () => {
    const MI = common.MissionItem as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MI, { seq: 0, command: 16, frame: 3, x: 35.0, y: 139.0, z: 10 }),
      ...tlogRecord(1_100_000, MI, { seq: 1, command: 16, frame: 3, x: 35.001, y: 139.001, z: 20 }),
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.mission.map((w) => w.seq)).toEqual([0, 1]);
    // x/y are float32 here, so 139.001 only survives to about six digits.
    expect(log.mission[1].lat).toBeCloseTo(35.001, 4);
    expect(log.mission[1].lon).toBeCloseTo(139.001, 4);
  });

  it('collects COMMAND_LONG/COMMAND_INT as named command events', async () => {
    const CL = common.CommandLong as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const CI = common.CommandInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, CL, { command: 176 }), // DO_SET_MODE
      ...tlogRecord(1_500_000, CI, { command: 192, frame: 3 }), // DO_REPOSITION
      ...tlogRecord(2_000_000, CL, { command: 400 }), // COMPONENT_ARM_DISARM
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.commands.map((c) => [c.time, c.name])).toEqual([
      [1_000_000, 'DO_SET_MODE'],
      [1_500_000, 'DO_REPOSITION'],
      [2_000_000, 'COMPONENT_ARM_DISARM'],
    ]);
  });

  it('names a command the dialect does not know by its id', async () => {
    const CL = common.CommandLong as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([...tlogRecord(1_000_000, CL, { command: 64000 })]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    // Address included: the fixture's defaults are sysid/compid 1, and the
    // payload leaves target 0/0, which reads as a broadcast.
    expect(log.commands).toEqual([
      {
        time: 1_000_000,
        id: 64000,
        name: 'MAV_CMD 64000',
        source: { sysid: 1, compid: 1 },
        target: { sysid: 0, compid: 0 },
      },
    ]);
  });

  // A GCS polls with these all session long; on a real log they outnumber the
  // commands aimed at the vehicle several hundred to one.
  it('leaves out the commands that only set the telemetry link up', async () => {
    const CL = common.CommandLong as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, CL, { command: 511 }), // SET_MESSAGE_INTERVAL
      ...tlogRecord(1_100_000, CL, { command: 512 }), // REQUEST_MESSAGE
      ...tlogRecord(1_200_000, CL, { command: 520 }), // REQUEST_AUTOPILOT_CAPABILITIES
      ...tlogRecord(1_300_000, CL, { command: 176 }), // DO_SET_MODE
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.commands.map((c) => c.name)).toEqual(['DO_SET_MODE']);
  });

  it('collapses a command that arrives twice on one timestamp', async () => {
    const CL = common.CommandLong as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      // Two links delivering the same pair of commands at one instant.
      ...tlogRecord(1_000_000, CL, { command: 176 }),
      ...tlogRecord(1_000_000, CL, { command: 400 }),
      ...tlogRecord(1_000_000, CL, { command: 176 }),
      ...tlogRecord(1_000_000, CL, { command: 400 }),
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.commands.map((c) => c.name)).toEqual(['DO_SET_MODE', 'COMPONENT_ARM_DISARM']);
  });

  // Two links with unequal latency deliver the same frame either side of a
  // later one, so the copies are not adjacent in the stream even though they
  // share an instant.
  it('collapses a command duplicated across an intervening timestamp', async () => {
    const CL = common.CommandLong as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, CL, { command: 176 }),
      ...tlogRecord(2_000_000, CL, { command: 400 }),
      ...tlogRecord(1_000_000, CL, { command: 176 }), // the slow link's copy
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.commands.map((c) => [c.time, c.name])).toEqual([
      [1_000_000, 'DO_SET_MODE'],
      [2_000_000, 'COMPONENT_ARM_DISARM'],
    ]);
  });

  it('keeps only the first attempt when a GCS resends an unacknowledged command', async () => {
    const CL = common.CommandLong as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, CL, { command: 400, confirmation: 0 }),
      ...tlogRecord(1_050_000, CL, { command: 400, confirmation: 1 }),
      ...tlogRecord(1_100_000, CL, { command: 400, confirmation: 2 }),
      // A fresh send of the same command later is its own event, not a retry.
      ...tlogRecord(9_000_000, CL, { command: 400, confirmation: 0 }),
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.commands.map((c) => c.time)).toEqual([1_000_000, 9_000_000]);
  });

  // MISSION_CURRENT is streamed at the telemetry rate, so only the instants
  // where seq actually moves are events worth marking.
  it('records a mission step only where MISSION_CURRENT changes seq', async () => {
    const MC = common.MissionCurrent as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, MC, { seq: 1 }),
      ...tlogRecord(1_100_000, MC, { seq: 1 }),
      ...tlogRecord(1_200_000, MC, { seq: 2 }),
      ...tlogRecord(1_300_000, MC, { seq: 2 }),
      ...tlogRecord(1_400_000, MC, { seq: 3 }),
      // A restarted plan revisits an index it has already passed; that is a step
      // of its own, not a duplicate.
      ...tlogRecord(1_500_000, MC, { seq: 1 }),
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.missionSteps).toEqual([
      { time: 1_000_000, seq: 1 },
      { time: 1_200_000, seq: 2 },
      { time: 1_400_000, seq: 3 },
      { time: 1_500_000, seq: 1 },
    ]);
  });

  // The message series are sorted by the builder for this reason already; the
  // event lists have to keep the same promise, since the plot lays their labels
  // out left to right and drops any that arrives behind the last one placed.
  it('puts commands and mission steps in time order when the stream is not', async () => {
    const CL = common.CommandLong as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const MC = common.MissionCurrent as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    const bytes = new Uint8Array([
      ...tlogRecord(2_000_000, CL, { command: 176 }), // DO_SET_MODE
      ...tlogRecord(1_000_000, CL, { command: 400 }), // COMPONENT_ARM_DISARM, logged earlier
      ...tlogRecord(2_500_000, MC, { seq: 5 }),
      ...tlogRecord(1_500_000, MC, { seq: 2 }),
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));

    expect(log.commands.map((c) => c.time)).toEqual([1_000_000, 2_000_000]);
    expect(log.commands.map((c) => c.name)).toEqual(['COMPONENT_ARM_DISARM', 'DO_SET_MODE']);
    expect(log.missionSteps).toEqual([
      { time: 1_500_000, seq: 2 },
      { time: 2_500_000, seq: 5 },
    ]);
  });

  it('sorts a message series whose wall-clock timestamps arrive out of order', async () => {
    const GPI = common.GlobalPositionInt as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
    // Records written newest-first (e.g. after a clock step) must come out sorted.
    const bytes = new Uint8Array([
      ...tlogRecord(2_000_000, GPI, { lat: Math.round(35.02 * 1e7), lon: Math.round(139.02 * 1e7), relativeAlt: 20_000 }),
      ...tlogRecord(1_000_000, GPI, { lat: Math.round(35.01 * 1e7), lon: Math.round(139.01 * 1e7), relativeAlt: 10_000 }),
    ]);
    const log = await parseTelemetry(new MemorySource('t.tlog', bytes));
    const t = log.messages.GLOBAL_POSITION_INT.time;
    expect(Array.from(t)).toEqual([1_000_000, 2_000_000]);
    // The lat column must be reordered together with time.
    expect(log.messages.GLOBAL_POSITION_INT.fields.lat[0]).toBeCloseTo(35.01 * 1e7, 0);
    expect(log.trajectory.lat[0]).toBeCloseTo(35.01, 4);
    expect(log.trajectory.lat[1]).toBeCloseTo(35.02, 4);
  });
});

// ---- Splitting a tlog by MAVLink source ----
//
// A tlog is the whole link, not one vehicle: ground stations, sensor feeds and
// the autopilot all write into the same file. Everything below is about keeping
// them apart, and about the two message families that belong to both ends of an
// exchange rather than to their sender alone.

type Cls = { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
const HB = minimal.Heartbeat as unknown as Cls;
const CMD_LONG = common.CommandLong as unknown as Cls;
const MIS_COUNT = common.MissionCount as unknown as Cls;
const MIS_ITEM = common.MissionItemInt as unknown as Cls;

/** `n` distinct senders, one minimal heartbeat each. */
const flood = (n: number) => {
  const parts: number[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(...tlogRecord(1_000_000 + i, HB, { type: minimal.MavType.SURFACE_BOAT }, { sysid: i >> 8, compid: i & 0xff }));
  }
  return new Uint8Array(parts);
};

const VEHICLE = { sysid: 1, compid: 1 };
const GCS = { sysid: 255, compid: 190 };

/** MAV_TYPE_SURFACE_BOAT — a Rover, so its mode table is RoverMode. */
const BOAT = minimal.MavType.SURFACE_BOAT;
const GCS_TYPE = minimal.MavType.GCS;

describe('parseTlog: sources', () => {
  it('keeps each sender in its own series', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT, customMode: 0 }, VEHICLE),
      ...tlogRecord(1_100_000, HB, { type: GCS_TYPE, customMode: 0 }, GCS),
      ...tlogRecord(1_200_000, HB, { type: BOAT, customMode: 10 }, VEHICLE),
      ...tlogRecord(1_300_000, HB, { type: GCS_TYPE, customMode: 0 }, GCS),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));

    expect([...parsed.bySource.keys()].sort()).toEqual(['1/1', '255/190']);
    expect(parsed.bySource.get('1/1')!.messages.HEARTBEAT.time.length).toBe(2);
    expect(parsed.bySource.get('255/190')!.messages.HEARTBEAT.time.length).toBe(2);
    // Busiest first, and both are named from the dialect rather than guessed.
    expect(parsed.sources.map((s) => [s.sysid, s.compid, s.typeLabel])).toEqual([
      [1, 1, 'SURFACE_BOAT'],
      [255, 190, 'GCS'],
    ]);
  });

  // The regression this whole change exists for. Four sources send HEARTBEAT on
  // the sample log and the ground stations sit at customMode 0, so reading them
  // as one stream turns two real mode changes into 7,049 alternating ones.
  it('does not let a ground station\'s customMode pollute the vehicle\'s modes', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT, customMode: 0 }, VEHICLE),
      ...tlogRecord(1_050_000, HB, { type: GCS_TYPE, customMode: 0 }, GCS),
      ...tlogRecord(1_100_000, HB, { type: BOAT, customMode: 10 }, VEHICLE),
      ...tlogRecord(1_150_000, HB, { type: GCS_TYPE, customMode: 0 }, GCS),
      ...tlogRecord(1_200_000, HB, { type: BOAT, customMode: 10 }, VEHICLE),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));

    // Two changes, named against the Rover table the MAV_TYPE picked.
    expect(parsed.bySource.get('1/1')!.modes).toEqual([
      { time: 1_000_000, mode: 'MANUAL', modeNum: 0 },
      { time: 1_100_000, mode: 'AUTO', modeNum: 10 },
    ]);
    // The ground station has one mode of its own, and it stays there.
    expect(parsed.bySource.get('255/190')!.modes).toEqual([
      { time: 1_050_000, mode: 'Mode 0', modeNum: 0 },
    ]);
  });

  it('leaves modes numbered when the source never says what it is', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: minimal.MavType.GENERIC, customMode: 10 }, VEHICLE),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.bySource.get('1/1')!.modes).toEqual([{ time: 1_000_000, mode: 'Mode 10', modeNum: 10 }]);
  });

  // Coverage and exclusivity, checked apart: a total alone is satisfied by an
  // implementation that counts one frame twice and drops another.
  it('files every decoded frame under exactly one source', async () => {
    const stamps = [1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000];
    const bytes = new Uint8Array([
      ...tlogRecord(stamps[0], HB, { type: BOAT }, VEHICLE),
      ...tlogRecord(stamps[1], HB, { type: GCS_TYPE }, GCS),
      ...tlogRecord(stamps[2], HB, { type: BOAT }, VEHICLE),
      ...tlogRecord(stamps[3], HB, { type: GCS_TYPE }, GCS),
      ...tlogRecord(stamps[4], HB, { type: BOAT }, VEHICLE),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));

    const perSource = [...parsed.bySource.values()].map((d) =>
      Object.values(d.messages).flatMap((m) => Array.from(m.time)),
    );
    expect(perSource.flat().sort((a, b) => a - b)).toEqual(stamps); // covers everything, once
    const [a, b] = perSource;
    expect(a.filter((t) => b.includes(t))).toEqual([]); // and the sets are disjoint
  });

  // `records` counts framing, not decoding, so it must not depend on which of a
  // source's frames happened to arrive first. The sample log's vehicle sends
  // 250 frames of an msgid no dialect defines.
  it.each([
    ['unknown first', true],
    ['known first', false],
  ])('counts frames of an unknown msgid either way (%s)', async (_name, unknownFirst) => {
    const UNKNOWN: Cls = { MSG_ID: 0xfff0, PAYLOAD_LENGTH: 4, FIELDS: [] };
    const known = tlogRecord(2_000_000, HB, { type: BOAT }, VEHICLE);
    const unknown = tlogRecord(1_000_000, UNKNOWN, {}, VEHICLE);
    const bytes = new Uint8Array(unknownFirst ? [...unknown, ...known] : [...known, ...unknown]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));

    expect(parsed.sources.map((s) => s.records)).toEqual([2]);
    // Counted, but not turned into a series: nothing can decode it.
    expect(Object.keys(parsed.bySource.get('1/1')!.messages)).toEqual(['HEARTBEAT']);
  });

  // Framing hands back an address out of any stretch of damage the reader
  // resyncs through, and a file ending mid-header used to walk straight past
  // the truncation guard. Neither may put a vehicle in the selector.
  it('does not raise a source from frames that never decode', async () => {
    const UNKNOWN: Cls = { MSG_ID: 0xfff0, PAYLOAD_LENGTH: 4, FIELDS: [] };
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...tlogRecord(1_100_000, UNKNOWN, {}, { sysid: 9, compid: 9 }),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.sources.map((s) => `${s.sysid}/${s.compid}`)).toEqual(['1/1']);
  });

  it('stops at a stamp followed by a lone STX byte', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      0, 0, 0, 0, 0, 0, 0, 0, // an 8-byte stamp...
      0xfd,                    // ...and the STX of a frame that is not there
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    // Without the header bounds check, `plen` reads undefined, every derived
    // bound becomes NaN, `NaN > len` is false, and this decodes as a HEARTBEAT
    // from an "undefined/undefined" source.
    expect(parsed.sources.map((s) => `${s.sysid}/${s.compid}`)).toEqual(['1/1']);
    expect(parsed.bySource.get('1/1')!.messages.HEARTBEAT.time.length).toBe(1);
  });
});

describe('parseTlog: commands reach both ends', () => {
  // Measured: all 2,613 COMMAND_LONGs in the sample log come from the ground
  // station, so filing by sender alone leaves the vehicle with none — and the
  // six markers a reader actually looks at disappear.
  const cmd = (ts: number, target: { sysid: number; compid: number }, id = 176) =>
    tlogRecord(ts, CMD_LONG, {
      command: id,
      targetSystem: target.sysid,
      targetComponent: target.compid,
    }, GCS);

  it('files a command under its target as well as its sender', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...cmd(1_100_000, VEHICLE),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));

    for (const key of ['1/1', '255/190']) {
      const cmds = parsed.bySource.get(key)!.commands;
      expect(cmds.map((c) => c.name)).toEqual(['DO_SET_MODE']);
      // Whichever source it was filed under, it was sent by the ground station.
      expect(cmds[0].source).toEqual(GCS);
      expect(cmds[0].target).toEqual(VEHICLE);
    }
  });

  it('gives a broadcast to every source, including ones that appear later', async () => {
    const bytes = new Uint8Array([
      ...cmd(1_000_000, { sysid: 0, compid: 0 }),
      // The vehicle's first frame comes after the broadcast, so an
      // implementation that delivers while scanning would miss it.
      ...tlogRecord(1_100_000, HB, { type: BOAT }, VEHICLE),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.bySource.get('1/1')!.commands.map((c) => c.name)).toEqual(['DO_SET_MODE']);
    expect(parsed.bySource.get('255/190')!.commands.map((c) => c.name)).toEqual(['DO_SET_MODE']);
  });

  it('gives a component-wildcard command to every component of that system', async () => {
    const bytes = new Uint8Array([
      ...cmd(1_000_000, { sysid: 1, compid: 0 }),
      ...tlogRecord(1_100_000, HB, { type: BOAT }, { sysid: 1, compid: 1 }),
      ...tlogRecord(1_200_000, HB, { type: minimal.MavType.GIMBAL }, { sysid: 1, compid: 154 }),
      ...tlogRecord(1_300_000, HB, { type: BOAT }, { sysid: 2, compid: 1 }),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.bySource.get('1/1')!.commands.length).toBe(1);
    expect(parsed.bySource.get('1/154')!.commands.length).toBe(1);
    expect(parsed.bySource.get('2/1')!.commands.length).toBe(0); // a different system
  });

  // The sample log addresses 1,323 REQUEST_DATA_STREAMs to a 125/191 that never
  // speaks. Being talked at is not being present.
  it('does not raise a source that is only ever a target', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: GCS_TYPE }, GCS),
      ...cmd(1_100_000, { sysid: 125, compid: 191 }),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.sources.map((s) => `${s.sysid}/${s.compid}`)).toEqual(['255/190']);
    // The sender keeps it, so nothing is lost by the target not existing.
    expect(parsed.bySource.get('255/190')!.commands.length).toBe(1);
  });

  // Identity is the MAV_CMD *and* the target. Two vehicles told to do the same
  // thing in the same microsecond are two commands, and keying on the id alone
  // collapsed them — hiding one of the markers a reader came to look at.
  it('tells apart two commands sent to different vehicles at one instant', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...tlogRecord(1_000_001, HB, { type: BOAT }, { sysid: 2, compid: 1 }),
      ...cmd(2_000_000, VEHICLE),
      ...cmd(2_000_000, { sysid: 2, compid: 1 }),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));

    // The sender holds both; each vehicle holds only its own.
    expect(parsed.bySource.get('255/190')!.commands).toHaveLength(2);
    expect(parsed.bySource.get('1/1')!.commands).toHaveLength(1);
    expect(parsed.bySource.get('2/1')!.commands).toHaveLength(1);
    expect(projectLog(parsed, ALL_SOURCES).commands).toHaveLength(2);
  });

  // Filing under both ends means "all sources" sees the same command twice.
  // The merge has to put it back together, or every command marker doubles the
  // moment the reader stops filtering.
  it('collapses a delivered command back to one under every source', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...cmd(1_500_000, VEHICLE),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.bySource.get('1/1')!.commands).toHaveLength(1);
    expect(parsed.bySource.get('255/190')!.commands).toHaveLength(1);

    const all = projectLog(parsed, ALL_SOURCES);
    expect(all.commands.map((c) => [c.time, c.name])).toEqual([[1_500_000, 'DO_SET_MODE']]);
  });

  // The plot lays marker labels out left to right and drops any that arrives
  // behind the last one placed, so a delivered command that lands after the
  // list is sorted goes silently unlabelled.
  it('keeps a source that both sends and receives in time order', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...cmd(1_500_000, VEHICLE, 176), // GCS -> vehicle, filed under both
      ...tlogRecord(2_000_000, CMD_LONG, {
        command: 400, targetSystem: 255, targetComponent: 190,
      }, VEHICLE), // vehicle -> GCS
      ...cmd(2_500_000, VEHICLE, 245),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    for (const key of ['1/1', '255/190']) {
      const times = parsed.bySource.get(key)!.commands.map((c) => c.time);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });
});

describe('parseTlog: mission transfers reach both ends', () => {
  const transfer = (from: typeof GCS, to: typeof VEHICLE, at: number) => [
    ...tlogRecord(at, MIS_COUNT, { count: 2, targetSystem: to.sysid, targetComponent: to.compid }, from),
    ...tlogRecord(at + 1000, MIS_ITEM, {
      seq: 0, command: 16, x: Math.round(35.0 * 1e7), y: Math.round(139.0 * 1e7), z: 30,
      targetSystem: to.sysid, targetComponent: to.compid,
    }, from),
    ...tlogRecord(at + 2000, MIS_ITEM, {
      seq: 1, command: 16, x: Math.round(35.01 * 1e7), y: Math.round(139.01 * 1e7), z: 30,
      targetSystem: to.sysid, targetComponent: to.compid,
    }, from),
  ];

  // Upload runs GCS -> vehicle and download runs vehicle -> GCS, so a rule that
  // looked only at the sender would see half of the sessions in the wild.
  // Component 0 addresses every component of that system, exactly as it does
  // for a command. Reading it as "no target" left the plan with the ground
  // station and the vehicle showing none.
  it('delivers a plan addressed to every component of a system', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...tlogRecord(1_010_000, HB, { type: GCS_TYPE }, GCS),
      ...tlogRecord(2_000_000, MIS_COUNT, { count: 1, targetSystem: 1, targetComponent: 0 }, GCS),
      ...tlogRecord(2_001_000, MIS_ITEM, {
        seq: 0, command: 16, x: Math.round(35.0 * 1e7), y: Math.round(139.0 * 1e7), z: 30,
        targetSystem: 1, targetComponent: 0,
      }, GCS),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.bySource.get('1/1')!.mission.map((w) => w.seq)).toEqual([0]);
    expect(parsed.bySource.get('255/190')!.mission.map((w) => w.seq)).toEqual([0]);
  });

  it.each([
    ['upload', GCS, VEHICLE],
    ['download', VEHICLE, GCS],
  ])('gives both ends the same plan (%s)', async (_name, from, to) => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...tlogRecord(1_010_000, HB, { type: GCS_TYPE }, GCS),
      ...transfer(from as typeof GCS, to as typeof VEHICLE, 2_000_000),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    for (const key of ['1/1', '255/190']) {
      const plan = parsed.bySource.get(key)!.mission;
      expect(plan.map((w) => w.seq)).toEqual([0, 1]);
      expect(plan[1].lat).toBeCloseTo(35.01, 5);
    }
  });

  // MissionCollector reads a transfer as an ordered run: MISSION_COUNT clears,
  // then items arrive. Delivering the target's copy out of that order would
  // leave it holding a plan the sender never had.
  it('replaces an older plan on the target as well as the sender', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...transfer(GCS, VEHICLE, 2_000_000),
      // A second, shorter transfer: one item, not two.
      ...tlogRecord(3_000_000, MIS_COUNT, { count: 1, targetSystem: 1, targetComponent: 1 }, GCS),
      ...tlogRecord(3_001_000, MIS_ITEM, {
        seq: 0, command: 16, x: Math.round(36.0 * 1e7), y: Math.round(140.0 * 1e7), z: 10,
        targetSystem: 1, targetComponent: 1,
      }, GCS),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    for (const key of ['1/1', '255/190']) {
      const plan = parsed.bySource.get(key)!.mission;
      expect(plan.map((w) => w.seq)).toEqual([0]);
      expect(plan[0].lat).toBeCloseTo(36.0, 5);
    }
  });
});

describe('parseTlog: refusing an implausible number of sources', () => {
  // sysid and compid are a byte each, so a file can name 65,536 addresses and
  // each one that decodes gets its own column builders. Measured: 1.8 MiB of
  // one-heartbeat-per-address expands to 351 MB, which is how a worker gets
  // killed and takes the reader's loaded log with it.
  it('parses a plausible number of sources', async () => {
    const parsed = await parseTlog(new MemorySource('t.tlog', flood(200)));
    expect(parsed.sources).toHaveLength(200);
  });

  it('refuses a file that names more than the cap, saying why', async () => {
    await expect(parseTlog(new MemorySource('t.tlog', flood(300)))).rejects.toThrow(
      /more than 256 distinct MAVLink sources/,
    );
  });

  // The per-frame try/catch swallows a malformed frame on purpose, so the guard
  // has to sit outside it — inside, the refusal would be discarded and the scan
  // would carry on allocating.
  it('does not let the malformed-frame catch swallow the refusal', async () => {
    const bytes = new Uint8Array([...flood(300), 0xfd, 0x00]);
    await expect(parseTlog(new MemorySource('t.tlog', bytes))).rejects.toThrow(/distinct MAVLink sources/);
  });

  // The cap counts senders, not addresses. A ground station naming hundreds of
  // components it never hears back from is ordinary; refusing the next real
  // vehicle because those placeholders filled the budget is not.
  it('does not count addresses that were only ever spoken to', async () => {
    const parts: number[] = [
      ...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE),
      ...tlogRecord(1_000_001, HB, { type: GCS_TYPE }, GCS),
    ];
    for (let i = 0; i < 300; i++) {
      parts.push(...tlogRecord(2_000_000 + i, CMD_LONG, {
        command: 176, targetSystem: 10 + (i >> 8), targetComponent: (i & 0xff) + 1,
      }, GCS));
    }
    // A real vehicle arriving after 300 placeholders have been opened.
    parts.push(...tlogRecord(3_000_000, HB, { type: BOAT }, { sysid: 2, compid: 1 }));

    const parsed = await parseTlog(new MemorySource('t.tlog', new Uint8Array(parts)));
    expect(parsed.sources.map((s) => `${s.sysid}/${s.compid}`).sort()).toEqual(['1/1', '2/1', '255/190']);
  });

  // An address that only ever sends msgids no dialect defines builds nothing,
  // so it must not consume the budget either.
  it('does not count senders whose frames never decode', async () => {
    const UNKNOWN: Cls = { MSG_ID: 0xfff0, PAYLOAD_LENGTH: 4, FIELDS: [] };
    const parts: number[] = [...flood(200)];
    for (let i = 0; i < 300; i++) {
      parts.push(...tlogRecord(5_000_000 + i, UNKNOWN, {}, { sysid: 10 + (i >> 8), compid: i & 0xff }));
    }
    const parsed = await parseTlog(new MemorySource('t.tlog', new Uint8Array(parts)));
    expect(parsed.sources).toHaveLength(200);
  });

  // Targets are created lazily too, and cannot throw (they are reached from
  // inside that same catch). They stop being created instead, which loses
  // nothing: the sender keeps its own copy of every command.
  it('stops opening targets at the cap without failing the parse', async () => {
    const parts: number[] = [...tlogRecord(1_000_000, HB, { type: BOAT }, VEHICLE)];
    for (let i = 0; i < 400; i++) {
      parts.push(...tlogRecord(2_000_000 + i, CMD_LONG, {
        command: 176, targetSystem: (i >> 8) + 2, targetComponent: (i & 0xff) + 1,
      }, GCS));
    }
    const parsed = await parseTlog(new MemorySource('t.tlog', new Uint8Array(parts)));
    // Only the two that actually spoke survive the scan either way.
    expect(parsed.sources.map((s) => `${s.sysid}/${s.compid}`).sort()).toEqual(['1/1', '255/190']);
    expect(parsed.bySource.get('255/190')!.commands).toHaveLength(400);
  });
});
