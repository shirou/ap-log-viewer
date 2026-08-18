import { describe, expect, it } from 'vitest';
import { common, minimal } from 'mavlink-mappings';
import { parseDataflash } from './dataflash.ts';
import { parseTlog } from './tlog.ts';
import { defaultSelection, projectLog } from './project.ts';
import { MemorySource, tlogRecord, type MavField } from './testFixtures.ts';
import { GOLDEN_BIN_CASES } from './goldenFixtures.ts';
import { ALL_SOURCES } from '../model/log.ts';
import golden from './__golden__/dataflash.json' with { type: 'json' };

type Cls = { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
const HB = minimal.Heartbeat as unknown as Cls;
const GPI = common.GlobalPositionInt as unknown as Cls;
const STATUSTEXT = common.StatusText as unknown as Cls;

const BOAT = minimal.MavType.SURFACE_BOAT;
const GCS = minimal.MavType.GCS;

const V = { sysid: 1, compid: 1 };
const G = { sysid: 255, compid: 190 };

/** Two vehicles and a ground station, all sending the same message types. */
async function twoVehicles() {
  const bytes = new Uint8Array([
    ...tlogRecord(1_000_000, HB, { type: BOAT, customMode: 0 }, V),
    ...tlogRecord(1_100_000, HB, { type: GCS, customMode: 0 }, G),
    ...tlogRecord(1_200_000, HB, { type: BOAT, customMode: 3 }, { sysid: 2, compid: 1 }),
    ...tlogRecord(1_300_000, HB, { type: BOAT, customMode: 10 }, V),
    ...tlogRecord(1_400_000, GPI, { lat: 350_000_000, lon: 1_390_000_000, relativeAlt: 10_000, hdg: 9000 }, V),
    ...tlogRecord(1_500_000, GPI, { lat: 360_000_000, lon: 1_400_000_000, relativeAlt: 20_000, hdg: 18000 }, V),
  ]);
  return parseTlog(new MemorySource('t.tlog', bytes));
}

describe('defaultSelection', () => {
  it('prefers a source whose heartbeat names a vehicle', async () => {
    const parsed = await twoVehicles();
    // 1/1 sends four frames to 2/1's one, so it wins among the vehicles.
    expect(defaultSelection(parsed)).toBe('1/1');
  });

  // The measured trap: the sample log's external GPS injector sends 36,720
  // frames against the autopilot's 351,256, and a quieter autopilot would lose
  // a plain "busiest source" contest.
  it('picks the vehicle even when a ground station is busier', async () => {
    const chatty = Array.from({ length: 5 }, (_, i) =>
      tlogRecord(1_000_000 + i * 1000, HB, { type: GCS, customMode: 0 }, G),
    ).flat();
    const bytes = new Uint8Array([
      ...chatty,
      ...tlogRecord(2_000_000, HB, { type: BOAT, customMode: 0 }, V),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(parsed.sources[0].records).toBe(5); // the ground station is first in the list
    expect(defaultSelection(parsed)).toBe('1/1');
  });

  // Stricter than "not a ground station", so that a gimbal cannot win either.
  it('skips components that are not vehicles', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: minimal.MavType.GIMBAL }, { sysid: 1, compid: 154 }),
      ...tlogRecord(1_100_000, HB, { type: minimal.MavType.GIMBAL }, { sysid: 1, compid: 154 }),
      ...tlogRecord(1_200_000, HB, { type: BOAT }, V),
    ]);
    expect(defaultSelection(await parseTlog(new MemorySource('t.tlog', bytes)))).toBe('1/1');
  });

  // A vehicle can announce MAV_TYPE_GENERIC, which passes neither of the tests
  // above; falling through to nothing would leave the reader on a mixture.
  it('falls back past the ground stations when nothing names a vehicle', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: GCS }, G),
      ...tlogRecord(1_100_000, HB, { type: GCS }, G),
      ...tlogRecord(1_200_000, HB, { type: minimal.MavType.GENERIC }, V),
    ]);
    expect(defaultSelection(await parseTlog(new MemorySource('t.tlog', bytes)))).toBe('1/1');
  });

  it('is ALL_SOURCES for a log with no addresses at all', async () => {
    const parsed = await parseDataflash(new MemorySource('t.bin', GOLDEN_BIN_CASES[0].bytes));
    expect(defaultSelection(parsed)).toBe(ALL_SOURCES);
  });
});

describe('projectLog', () => {
  // Invariant 1. This is the whole memory argument: the model is 33.5 MB on the
  // sample log, and a projection that copied would put a second one beside it.
  it('hands back the parser\'s own arrays, never copies', async () => {
    const parsed = await twoVehicles();
    const data = parsed.bySource.get('1/1')!;
    const log = projectLog(parsed, '1/1');

    expect(log.messages.HEARTBEAT).toBe(data.messages.HEARTBEAT);
    expect(log.messages.HEARTBEAT.time).toBe(data.messages.HEARTBEAT.time);
    expect(log.messages.HEARTBEAT.fields.customMode).toBe(data.messages.HEARTBEAT.fields.customMode);
    expect(log.trajectory).toBe(data.trajectory);
    expect(log.params).toBe(data.params);
    expect(log.mission).toBe(data.mission);
  });

  // Invariant 2. Three of the sample log's thirty-six types collide; the other
  // thirty-three have to cost nothing to show under "all sources".
  it('shares columns for types only one source sent, even when merging', async () => {
    const parsed = await twoVehicles();
    const all = projectLog(parsed, ALL_SOURCES);
    // GLOBAL_POSITION_INT comes from 1/1 alone.
    expect(all.messages.GLOBAL_POSITION_INT).toBe(parsed.bySource.get('1/1')!.messages.GLOBAL_POSITION_INT);
    // HEARTBEAT comes from three, so it has to be built.
    expect(all.messages.HEARTBEAT).not.toBe(parsed.bySource.get('1/1')!.messages.HEARTBEAT);
  });

  it('merges a colliding type into one time-ordered series', async () => {
    const parsed = await twoVehicles();
    const all = projectLog(parsed, ALL_SOURCES);
    const hb = all.messages.HEARTBEAT;

    const perSource = [...parsed.bySource.values()].reduce(
      (n, d) => n + (d.messages.HEARTBEAT?.time.length ?? 0), 0);
    expect(hb.time.length).toBe(perSource);
    expect(Array.from(hb.time)).toEqual([...hb.time].sort((a, b) => a - b));
    expect(Array.from(hb.time)).toEqual([1_000_000, 1_100_000, 1_200_000, 1_300_000]);
  });

  // String columns are reordered alongside the numeric ones inside a series, so
  // a merge that forgot them would misalign every text against its timestamp.
  it('carries string columns through a merge', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT }, V),
      ...tlogRecord(1_100_000, HB, { type: GCS }, G),
      ...tlogRecord(1_200_000, STATUSTEXT, { severity: 6 }, { ...V, strings: { text: 'from vehicle' } }),
      ...tlogRecord(1_300_000, STATUSTEXT, { severity: 4 }, { ...G, strings: { text: 'from gcs' } }),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    const all = projectLog(parsed, ALL_SOURCES);

    expect(Array.from(all.messages.STATUSTEXT.time)).toEqual([1_200_000, 1_300_000]);
    expect(all.messages.STATUSTEXT.textFields!.text).toEqual(['from vehicle', 'from gcs']);
    expect(Array.from(all.messages.STATUSTEXT.fields.severity)).toEqual([6, 4]);
  });

  // Modes are filed by sender only, so the merge is a union rather than a dedup.
  // The distinction only shows up when two sources collide on both time and
  // mode number — anywhere else the two behave identically, which is why the
  // fixture puts both vehicles into mode 10 at the same instant.
  it('keeps both sources\' modes when they coincide exactly', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT, customMode: 0 }, V),
      ...tlogRecord(1_000_000, HB, { type: BOAT, customMode: 0 }, { sysid: 2, compid: 1 }),
      ...tlogRecord(2_000_000, HB, { type: BOAT, customMode: 10 }, V),
      ...tlogRecord(2_000_000, HB, { type: BOAT, customMode: 10 }, { sysid: 2, compid: 1 }),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    const all = projectLog(parsed, ALL_SOURCES);

    // Two vehicles, two mode changes each. Deduplicating by (time, modeNum)
    // would halve this and hide one of the aircraft entirely.
    expect(all.modes.map((m) => [m.time, m.mode])).toEqual([
      [1_000_000, 'MANUAL'],
      [1_000_000, 'MANUAL'],
      [2_000_000, 'AUTO'],
      [2_000_000, 'AUTO'],
    ]);
  });

  it('keeps each source\'s modes named by its own vehicle kind', async () => {
    const all = projectLog(await twoVehicles(), ALL_SOURCES);
    expect(all.modes.map((m) => m.time)).toEqual([...all.modes.map((m) => m.time)].sort((a, b) => a - b));
    expect(all.modes.map((m) => m.mode)).toContain('MANUAL'); // a Rover's
    expect(all.modes.map((m) => m.mode)).toContain('Mode 0'); // the ground station's
  });

  // Invariant 4. The timeline's ends and every relative time printed against
  // them have to hold still, or switching source moves the clock underfoot.
  it('spans every source whatever is selected', async () => {
    const parsed = await twoVehicles();
    for (const key of [ALL_SOURCES, '1/1', '255/190', '2/1']) {
      const log = projectLog(parsed, key);
      expect(log.startTime).toBe(parsed.startTime);
      expect(log.endTime).toBe(parsed.endTime);
    }
  });

  it('falls back to every source when the selection no longer exists', async () => {
    const parsed = await twoVehicles();
    const log = projectLog(parsed, '9/9');
    expect(log.selection).toBe(ALL_SOURCES);
    expect(Object.keys(log.messages)).toContain('HEARTBEAT');
  });

  // Two vehicles hold two plans; interleaving them by seq builds a route
  // neither ever had — the failure MissionCollector refuses to make when a
  // shorter plan replaces a longer one.
  it('takes one plan whole rather than merging two by index', async () => {
    const parsed = await twoVehicles();
    const a = parsed.bySource.get('1/1')!;
    const b = parsed.bySource.get('2/1')!;
    a.mission = [{ seq: 0, command: 16, lat: 35, lon: 139, alt: 10, frame: 3 },
                 { seq: 1, command: 16, lat: 35.1, lon: 139.1, alt: 10, frame: 3 }];
    b.mission = [{ seq: 0, command: 16, lat: 40, lon: 145, alt: 20, frame: 3 }];

    const all = projectLog(parsed, ALL_SOURCES);
    expect(all.mission).toBe(a.mission); // the default source's plan, by reference
  });

  it('lets the default source win a parameter collision', async () => {
    const parsed = await twoVehicles();
    parsed.bySource.get('1/1')!.params = { WP_SPEED: 2.5, SHARED: 1 };
    parsed.bySource.get('2/1')!.params = { SHARED: 99, ONLY_ON_TWO: 7 };

    const all = projectLog(parsed, ALL_SOURCES);
    expect(all.params.SHARED).toBe(1); // 1/1 is the default selection
    expect(all.params.ONLY_ON_TWO).toBe(7); // but nothing is lost
  });

  it('takes the track from a source that has one', async () => {
    const parsed = await twoVehicles();
    const all = projectLog(parsed, ALL_SOURCES);
    expect(all.trajectory).toBe(parsed.bySource.get('1/1')!.trajectory);
    expect(all.trajectory.lat.length).toBe(2);
    // A ground station sends no position, and says so by being empty rather
    // than by borrowing the vehicle's.
    expect(projectLog(parsed, '255/190').trajectory.lat.length).toBe(0);
  });
});

// Invariant 5, against a golden recorded before any of this existed. A .bin has
// no addresses, so splitting must not have moved it at all.
describe('a .bin parses to what it always did', () => {
  const norm = (a: ArrayLike<number>) => Array.from(a).map((v) => (Number.isFinite(v) ? v : null));

  it.each(GOLDEN_BIN_CASES.map((c) => [c.name, c] as const))('%s', async (name, c) => {
    const log = projectLog(await parseDataflash(new MemorySource(`${name}.bin`, c.bytes)), ALL_SOURCES);
    const want = (golden as Record<string, Record<string, unknown>>)[name];

    expect(log.source).toEqual(want.source);
    // Includes the ends: the timeless fixture reaches parseDataflash's fallback,
    // which reads them off the trajectory — the one thing that would break if
    // the trajectory moved out of the parser.
    expect(log.startTime).toEqual(want.startTime);
    expect(log.endTime).toEqual(want.endTime);
    expect(log.params).toEqual(want.params);
    expect(log.texts).toEqual(want.texts);
    expect(log.commands).toEqual(want.commands);
    expect(log.missionSteps).toEqual(want.missionSteps);
    expect(log.mission).toEqual(want.mission);

    const messages = Object.fromEntries(
      Object.entries(log.messages).map(([n, m]) => [n, {
        labels: m.labels,
        time: norm(m.time),
        fields: Object.fromEntries(Object.entries(m.fields).map(([k, v]) => [k, norm(v)])),
        ...(m.textFields ? { textFields: m.textFields } : {}),
      }]),
    );
    expect(messages).toEqual(want.messages);
    expect({
      time: norm(log.trajectory.time), lat: norm(log.trajectory.lat), lon: norm(log.trajectory.lon),
      alt: norm(log.trajectory.alt), heading: norm(log.trajectory.heading),
    }).toEqual(want.trajectory);
  });

  // The one thing that is meant to have changed, stated outright so the golden's
  // exclusion of it is not mistaken for an oversight.
  it('names its modes now, from the firmware banner', async () => {
    const log = projectLog(
      await parseDataflash(new MemorySource('typical.bin', GOLDEN_BIN_CASES[0].bytes)),
      ALL_SOURCES,
    );
    expect((golden as Record<string, { modesBeforeModeNames: unknown }>).typical.modesBeforeModeNames)
      .toEqual([{ time: 1_050_000, mode: 'Mode 0' }, { time: 4_500_000, mode: 'Mode 10' }]);
    expect(log.modes).toEqual([
      { time: 1_050_000, mode: 'MANUAL', modeNum: 0 },
      { time: 4_500_000, mode: 'AUTO', modeNum: 10 },
    ]);
  });
});
