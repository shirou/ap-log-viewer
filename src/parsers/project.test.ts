import { describe, expect, it } from 'vitest';
import { common, minimal } from 'mavlink-mappings';
import { parseDataflash } from './dataflash.ts';
import { parseTlog } from './tlog.ts';
import { defaultSelection, primaryOf, projectLog, sourceOptions } from './project.ts';
import { MemorySource, tlogRecord, type MavField } from './testFixtures.ts';
import { GOLDEN_BIN_CASES } from './goldenFixtures.ts';
import { ALL_SOURCES, groupKey, parseGroupKey, sourceKey } from '../model/log.ts';
import golden from './__golden__/dataflash.json' with { type: 'json' };

type Cls = { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
const HB = minimal.Heartbeat as unknown as Cls;
const GPI = common.GlobalPositionInt as unknown as Cls;
const STATUSTEXT = common.StatusText as unknown as Cls;
const MIS_CUR = common.MissionCurrent as unknown as Cls;
const CMD_LONG = common.CommandLong as unknown as Cls;

const BOAT = minimal.MavType.SURFACE_BOAT;
const GCS = minimal.MavType.GCS;

const V = { sysid: 1, compid: 1 };
const G = { sysid: 255, compid: 190 };

// One aircraft made of three components: the autopilot and two peripherals.
const V4 = { sysid: 4, compid: 1 };
const P128 = { sysid: 4, compid: 128 };
const P158 = { sysid: 4, compid: 158 };
const GENERIC = minimal.MavType.GENERIC;

/**
 * A three-component aircraft, plus the station that commands it.
 *
 * Deliberately lopsided: the peripherals out-talk the autopilot, so anything
 * that reached for the busiest component rather than for the one that names a
 * vehicle would pick wrong. Only 4/1 sends a position, only 4/158 sends text,
 * and both 4/1 and 4/128 report mission progress, so each merge rule has one
 * source that can be traced back to it.
 */
async function vehicleWithPeripherals() {
  const hb = (t: number, type: number, customMode: number, who: typeof V4) =>
    tlogRecord(t, HB, { type, customMode }, who);
  const bytes = new Uint8Array([
    // 4/128 — six frames, the busiest component of the system.
    ...hb(1_000_000, GENERIC, 0, P128),
    ...hb(1_100_000, GENERIC, 0, P128),
    ...hb(1_200_000, GENERIC, 0, P128),
    ...hb(1_300_000, GENERIC, 0, P128),
    ...hb(1_400_000, GENERIC, 0, P128),
    ...tlogRecord(1_450_000, MIS_CUR, { seq: 7 }, P128),
    // 4/158 — five.
    ...hb(1_500_000, GENERIC, 0, P158),
    ...hb(1_600_000, GENERIC, 0, P158),
    ...hb(1_700_000, GENERIC, 0, P158),
    ...hb(1_800_000, GENERIC, 0, P158),
    ...tlogRecord(1_850_000, STATUSTEXT, { severity: 4 }, { ...P158, strings: { text: 'gimbal stuck' } }),
    // 4/1 — four, and the only one whose HEARTBEAT names a vehicle.
    ...hb(2_000_000, BOAT, 0, V4),
    ...tlogRecord(2_100_000, GPI, { lat: 350_000_000, lon: 1_390_000_000, relativeAlt: 10_000, hdg: 9000 }, V4),
    ...hb(2_200_000, BOAT, 10, V4),
    ...tlogRecord(2_300_000, MIS_CUR, { seq: 2 }, V4),
    // One command to the autopilot, one to the whole system. The second is
    // filed under all three components, which is what the merge has to collapse.
    ...tlogRecord(2_400_000, CMD_LONG, { command: 400, targetSystem: 4, targetComponent: 1 }, G),
    ...tlogRecord(2_500_000, CMD_LONG, { command: 176, targetSystem: 4, targetComponent: 0 }, G),
  ]);
  return parseTlog(new MemorySource('t.tlog', bytes));
}

/** Two ground stations under one SYSID — a group with no vehicle in it. */
async function twoGroundStations() {
  const bytes = new Uint8Array([
    ...tlogRecord(1_000_000, HB, { type: GCS, customMode: 0 }, { sysid: 255, compid: 1 }),
    ...tlogRecord(1_100_000, HB, { type: GCS, customMode: 0 }, G),
  ]);
  return parseTlog(new MemorySource('t.tlog', bytes));
}

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
  //
  // A gimbal rides on the aircraft, so it shares its SYSID — which makes this
  // the shape the group row exists for. The opening selection is the whole
  // system, and the component the system is *named* by is still the boat, not
  // the busier gimbal.
  it('skips components that are not vehicles', async () => {
    const bytes = new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: minimal.MavType.GIMBAL }, { sysid: 1, compid: 154 }),
      ...tlogRecord(1_100_000, HB, { type: minimal.MavType.GIMBAL }, { sysid: 1, compid: 154 }),
      ...tlogRecord(1_200_000, HB, { type: BOAT }, V),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    expect(defaultSelection(parsed)).toBe('1/*');
    expect(primaryOf(parsed.sources)).toMatchObject({ sysid: 1, compid: 1 });
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

  // The merge's `preferred` has to come from the three-pass test, not from
  // whichever source the parser met first. Every fixture above happens to put
  // the vehicle in both positions, so none of them can tell the two apart —
  // this one puts a busier ground station ahead of the aircraft in `sources`
  // *and* in `bySource`'s insertion order, so the two disagree.
  //
  // The trap this exists for: `mergeSources` used to resolve its preferred
  // source through `defaultSelection`, which now answers with a group key that
  // `bySource` does not hold. That would fall through to `all[0]` and hand the
  // ground station's parameters, plan and (empty) track to "all sources".
  it('lets the vehicle win a collision even when it speaks first-last and least', async () => {
    const chatty = Array.from({ length: 5 }, (_, i) =>
      tlogRecord(1_000_000 + i * 1000, HB, { type: GCS, customMode: 0 }, G),
    ).flat();
    const bytes = new Uint8Array([
      ...chatty,
      ...tlogRecord(1_300_000, HB, { type: BOAT, customMode: 0 }, V),
      ...tlogRecord(1_400_000, GPI, { lat: 350_000_000, lon: 1_390_000_000, relativeAlt: 10_000, hdg: 9000 }, V),
      ...tlogRecord(1_500_000, GPI, { lat: 360_000_000, lon: 1_400_000_000, relativeAlt: 20_000, hdg: 18000 }, V),
    ]);
    const parsed = await parseTlog(new MemorySource('t.tlog', bytes));
    // Both orders put the ground station first, which is what makes this a test.
    expect([...parsed.bySource.keys()][0]).toBe('255/190');
    expect(parsed.sources[0]).toMatchObject({ sysid: 255, compid: 190 });

    const gcs = parsed.bySource.get('255/190')!;
    const vehicle = parsed.bySource.get('1/1')!;
    gcs.params = { SHARED: 99, ONLY_ON_GCS: 7 };
    vehicle.params = { SHARED: 1 };
    gcs.mission = [{ seq: 0, command: 16, lat: 40, lon: 145, alt: 20, frame: 3 }];
    vehicle.mission = [{ seq: 0, command: 16, lat: 35, lon: 139, alt: 10, frame: 3 }];

    const all = projectLog(parsed, ALL_SOURCES);
    expect(all.params.SHARED).toBe(1);
    expect(all.params.ONLY_ON_GCS).toBe(7); // still nothing is lost
    expect(all.mission).toBe(vehicle.mission);
    expect(all.trajectory).toBe(vehicle.trajectory);
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

// A SYSID is one aircraft and its COMPIDs are the boxes on it, so the selector
// offers both grains: the system, and each component under it.
describe('a SYSID group', () => {
  it('lists the system above its components, busiest system first', async () => {
    const rows = sourceOptions(await vehicleWithPeripherals());
    expect(rows.map((r) => r.key)).toEqual(['4/*', '4/128', '4/158', '4/1', '255/190']);
    expect(rows.map((r) => [r.group, r.indented])).toEqual([
      [true, false],   // the system
      [false, true],   // its components, in the parsers' records order
      [false, true],
      [false, true],
      [false, false],  // a system with one component gets no group row
    ]);
  });

  it('counts a group by its members and leaves a lone component alone', async () => {
    const rows = sourceOptions(await vehicleWithPeripherals());
    const group = rows[0];
    expect(group.records).toBe(6 + 5 + 4);
    expect(group.members.map(sourceKey)).toEqual(['4/128', '4/158', '4/1']);
    // A component row still covers exactly itself, so one code path counts both.
    expect(rows[4].members).toHaveLength(1);
    expect(rows[4].records).toBe(rows[4].primary.records);
  });

  // The whole point of the group: it is named by the vehicle on it, not by
  // whichever box happens to talk most.
  it('is named by the component that names a vehicle', async () => {
    const rows = sourceOptions(await vehicleWithPeripherals());
    expect(rows[0].primary).toMatchObject({ sysid: 4, compid: 1 });
    expect(rows[0].members[0]).toMatchObject({ sysid: 4, compid: 128 }); // not the primary
  });

  it('opens on the system rather than on its autopilot', async () => {
    expect(defaultSelection(await vehicleWithPeripherals())).toBe('4/*');
    // A vehicle with one component has no group to open on.
    expect(defaultSelection(await twoVehicles())).toBe('1/1');
  });

  // The failure this exists for: every component sends HEARTBEAT and a
  // peripheral's customMode is always 0, so a plain union would open the
  // aircraft's mode history with a mode it never entered.
  it('takes its mode history from the vehicle alone', async () => {
    const log = projectLog(await vehicleWithPeripherals(), '4/*');
    expect(log.modes.map((m) => [m.time, m.mode])).toEqual([
      [2_000_000, 'MANUAL'],
      [2_200_000, 'AUTO'],
    ]);
  });

  // ...but only where there is a vehicle to prefer. Two ground stations under
  // one SYSID have no autopilot between them, and dropping half of them would
  // lose a source's history for no reason.
  it('keeps every component\'s modes when none names a vehicle', async () => {
    const log = projectLog(await twoGroundStations(), '255/*');
    expect(log.modes.map((m) => [m.time, m.mode])).toEqual([
      [1_000_000, 'Mode 0'],
      [1_100_000, 'Mode 0'],
    ]);
  });

  // The filter is "names a vehicle", not "is the primary". Two components of one
  // system both announcing a vehicle type is odd wiring, but their customMode
  // means something in a way a peripheral's zero does not, so both are kept and
  // each is named by its own mode table. Picking one would be the viewer
  // deciding which of two real histories to hide.
  it('keeps every component that names a vehicle, dropping only the peripherals', async () => {
    const parsed = await parseTlog(new MemorySource('t.tlog', new Uint8Array([
      ...tlogRecord(1_000_000, HB, { type: BOAT, customMode: 0 }, V4),
      ...tlogRecord(2_000_000, HB, { type: minimal.MavType.QUADROTOR, customMode: 0 }, { sysid: 4, compid: 191 }),
      ...tlogRecord(3_000_000, HB, { type: GENERIC, customMode: 0 }, P128),
    ])));
    const log = projectLog(parsed, '4/*');
    expect(log.modes.map((m) => m.time)).toEqual([1_000_000, 2_000_000]);
    // Each read through its own vehicle's table, and neither is the peripheral's.
    expect(log.modes.map((m) => m.mode)).toEqual(['MANUAL', 'STABILIZE']);
  });

  it('interleaves a type more than one component sent', async () => {
    const parsed = await vehicleWithPeripherals();
    const log = projectLog(parsed, '4/*');
    expect([...log.messages.HEARTBEAT.time]).toEqual([
      1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000,
      1_500_000, 1_600_000, 1_700_000, 1_800_000,
      2_000_000, 2_200_000,
    ]);
  });

  // The merge runs through a heap, and a heap is only equivalent to the scan it
  // replaced if it breaks ties the same way. Three components stamped to the
  // same microsecond: the rows come out in the order the components are listed,
  // which for a group is `parsed.sources` — most frames first.
  it('breaks a timestamp tie by the order the components are listed', async () => {
    const at = (t: number, who: typeof V4, custom: number) =>
      tlogRecord(t, HB, { type: GENERIC, customMode: custom }, who);
    const parsed = await parseTlog(new MemorySource('t.tlog', new Uint8Array([
      ...at(1_000_000, P128, 11),
      ...at(1_000_000, P158, 22),
      ...at(1_000_000, V4, 33),
      ...at(1_500_000, P128, 44),
      ...at(1_600_000, P128, 55),
      ...at(1_700_000, P158, 66),
    ])));
    // 4/128 sends three frames, 4/158 two, 4/1 one, so that is the listed order
    // — and it is deliberately not the order they first spoke in.
    expect(parsed.sources.map(sourceKey)).toEqual(['4/128', '4/158', '4/1']);

    const log = projectLog(parsed, '4/*');
    expect([...log.messages.HEARTBEAT.time]).toEqual([1e6, 1e6, 1e6, 1.5e6, 1.6e6, 1.7e6]);
    expect([...log.messages.HEARTBEAT.fields.customMode]).toEqual([11, 22, 33, 44, 55, 66]);
  });

  // The heap has a second half the tie test cannot reach. Inputs enter it in the
  // order the selection lists them — records-descending for a group — and if
  // that order happens to be non-decreasing by first timestamp, the array is
  // already a valid heap and nothing ever sifts up. Every other fixture here is
  // that shape by accident, so a broken sift-up passes them all.
  //
  // A quiet box that powered up first is enough to break the coincidence: the
  // busiest component is listed first but starts talking last.
  it('orders the merge when the busiest component starts talking last', async () => {
    const at = (t: number, who: typeof V4, custom: number) =>
      tlogRecord(t, HB, { type: GENERIC, customMode: custom }, who);
    const parsed = await parseTlog(new MemorySource('t.tlog', new Uint8Array([
      ...at(1_000_000, V4, 11),                        // fewest frames, speaks first
      ...at(2_000_000, P158, 21), ...at(2_100_000, P158, 22),
      ...at(3_000_000, P128, 31), ...at(3_100_000, P128, 32), ...at(3_200_000, P128, 33),
    ])));
    // Listed most-frames-first, which is the reverse of who started when.
    expect(parsed.sources.map(sourceKey)).toEqual(['4/128', '4/158', '4/1']);

    const log = projectLog(parsed, '4/*');
    expect([...log.messages.HEARTBEAT.time]).toEqual([1e6, 2e6, 2.1e6, 3e6, 3.1e6, 3.2e6]);
    expect([...log.messages.HEARTBEAT.fields.customMode]).toEqual([11, 21, 22, 31, 32, 33]);
  });

  // Invariant: the merge only builds what actually collides. Everything else is
  // the parser's own array, which is what keeps a group from doubling the model.
  it('hands back the parser\'s arrays for types only one component sent', async () => {
    const parsed = await vehicleWithPeripherals();
    const log = projectLog(parsed, '4/*');
    expect(log.messages.STATUSTEXT).toBe(parsed.bySource.get('4/158')!.messages.STATUSTEXT);
    expect(log.messages.GLOBAL_POSITION_INT).toBe(parsed.bySource.get('4/1')!.messages.GLOBAL_POSITION_INT);
    expect(log.trajectory).toBe(parsed.bySource.get('4/1')!.trajectory);
    expect(log.trajectory.lat.length).toBe(1);
  });

  it('lets the vehicle win a parameter collision, losing nothing', async () => {
    const parsed = await vehicleWithPeripherals();
    parsed.bySource.get('4/1')!.params = { SHARED: 1 };
    parsed.bySource.get('4/128')!.params = { SHARED: 99, ONLY_ON_PERIPHERAL: 7 };

    const log = projectLog(parsed, '4/*');
    expect(log.params.SHARED).toBe(1);
    expect(log.params.ONLY_ON_PERIPHERAL).toBe(7);
  });

  it('takes the vehicle\'s plan whole', async () => {
    const parsed = await vehicleWithPeripherals();
    const vehicle = parsed.bySource.get('4/1')!;
    vehicle.mission = [{ seq: 0, command: 16, lat: 35, lon: 139, alt: 10, frame: 3 }];
    parsed.bySource.get('4/128')!.mission = [{ seq: 0, command: 16, lat: 40, lon: 145, alt: 20, frame: 3 }];

    expect(projectLog(parsed, '4/*').mission).toBe(vehicle.mission);
  });

  it('unions the events every component contributes', async () => {
    const log = projectLog(await vehicleWithPeripherals(), '4/*');
    expect(log.texts.map((t) => t.text)).toEqual(['gimbal stuck']);
    expect(log.missionSteps).toEqual([
      { time: 1_450_000, seq: 7 },
      { time: 2_300_000, seq: 2 },
    ]);
  });

  // A command aimed at the system lands under all three components, so a group
  // sees three copies of one order. Identity is the command and both ends of
  // the exchange, so the copies collapse and the two distinct orders survive.
  it('collapses a system-wide command back into one event', async () => {
    const parsed = await vehicleWithPeripherals();
    expect(parsed.bySource.get('4/128')!.commands).toHaveLength(1); // its share of the broadcast
    const log = projectLog(parsed, '4/*');
    expect(log.commands.map((c) => [c.time, c.name])).toEqual([
      [2_400_000, 'COMPONENT_ARM_DISARM'],
      [2_500_000, 'DO_SET_MODE'],
    ]);
  });

  // A group is a view, never a source. Letting one into `sources` would put an
  // address that was never on the link into the JSON export's source list.
  it('never becomes a source of its own', async () => {
    const parsed = await vehicleWithPeripherals();
    const log = projectLog(parsed, '4/*');
    expect(log.sources).toBe(parsed.sources);
    expect(log.sources.map(sourceKey)).toEqual(['4/128', '4/158', '4/1', '255/190']);
  });

  it('does not move the clock', async () => {
    const parsed = await vehicleWithPeripherals();
    for (const key of ['4/*', '4/1', '255/190', ALL_SOURCES]) {
      const log = projectLog(parsed, key);
      expect(log.startTime).toBe(parsed.startTime);
      expect(log.endTime).toBe(parsed.endTime);
    }
  });

  it('falls back to everything when the key names no group worth showing', async () => {
    const parsed = await vehicleWithPeripherals();
    expect(projectLog(parsed, '9/*').selection).toBe(ALL_SOURCES);   // no such system
    expect(projectLog(parsed, '255/*').selection).toBe(ALL_SOURCES); // one component only
    expect(projectLog(parsed, '4/*').selection).toBe('4/*');
  });

  // The only place a string from outside becomes a number. `Number('')` is 0,
  // so a lax test would read a bare '/*' as system 0.
  it('reads a group key strictly', () => {
    expect(parseGroupKey('4/*')).toBe(4);
    expect(parseGroupKey(groupKey(255))).toBe(255);
    expect(parseGroupKey('/*')).toBeNull();
    expect(parseGroupKey(ALL_SOURCES)).toBeNull();
    expect(parseGroupKey('4/1')).toBeNull();
    expect(parseGroupKey('-4/*')).toBeNull();
  });

  // The parser admits 256 senders, and nothing stops them all sharing a SYSID —
  // `parsers.test.ts`'s own flood fixture is exactly that shape. That makes a
  // 256-member group the widest merge the default selection can walk into.
  it('resolves a system holding every source the parser admits', async () => {
    const parts: number[] = [];
    for (let compid = 0; compid < 256; compid++) {
      parts.push(...tlogRecord(1_000_000 + compid, HB, { type: BOAT, customMode: 0 }, { sysid: 7, compid }));
      parts.push(...tlogRecord(2_000_000 + compid, HB, { type: BOAT, customMode: 0 }, { sysid: 7, compid }));
    }
    const parsed = await parseTlog(new MemorySource('t.tlog', new Uint8Array(parts)));
    expect(parsed.sources).toHaveLength(256);

    expect(defaultSelection(parsed)).toBe('7/*');
    const log = projectLog(parsed, '7/*');
    expect(log.selection).toBe('7/*'); // resolved, not fallen back to everything
    expect(log.messages.HEARTBEAT.time.length).toBe(512);
    expect(sourceOptions(parsed)).toHaveLength(257); // the system plus its members
    expect(log.sources).toBe(parsed.sources);
  });
});
