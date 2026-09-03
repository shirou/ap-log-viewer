import { beforeEach, describe, expect, it } from 'vitest';
import { selectDisplayTime, selectExportWindow, useLogStore } from './logStore.ts';
import { ALL_SOURCES, type ParsedLog } from '../model/log.ts';
import { projectLog } from '../parsers/project.ts';

// No `log` is needed: with none loaded the time setters skip their clamping,
// which keeps these focused on which instant the views end up rendering.
beforeEach(() => {
  useLogStore.setState({ log: null, playing: false, cursorTime: 0, hoverTime: null });
});

describe('selectDisplayTime', () => {
  it('previews the hovered instant while paused', () => {
    useLogStore.getState().setHoverTime(10);
    expect(selectDisplayTime(useLogStore.getState())).toBe(10);
  });

  it('returns to the playhead once the pointer leaves the scrub', () => {
    const { setHoverTime } = useLogStore.getState();
    setHoverTime(10);
    setHoverTime(null);
    useLogStore.setState({ cursorTime: 45 });
    expect(selectDisplayTime(useLogStore.getState())).toBe(45);
  });

  it('renders the playhead even if a preview somehow survives into playback', () => {
    // The scrub records no preview while playing and setPlaying clears any
    // pending one, so this state should be unreachable — the selector still has
    // to be right on its own terms.
    useLogStore.setState({ playing: true, hoverTime: 10, cursorTime: 45 });
    expect(selectDisplayTime(useLogStore.getState())).toBe(45);
  });
});

describe('setPlaying', () => {
  // Regression: the pointer can still rest on the scrub when Play is reached by
  // keyboard, so no pointerleave arrives to clear the preview. Playback only
  // masks it, so pausing used to snap every view back to that stale instant.
  it('does not resurface a preview left behind when playback started', () => {
    const s = useLogStore.getState();
    s.setHoverTime(10);
    s.setPlaying(true);
    useLogStore.setState({ cursorTime: 45 }); // playback advances
    s.setPlaying(false);

    expect(useLogStore.getState().hoverTime).toBeNull();
    expect(selectDisplayTime(useLogStore.getState())).toBe(45);
  });

  it('clears a pending preview through togglePlaying too', () => {
    const s = useLogStore.getState();
    s.setHoverTime(10);
    s.togglePlaying();

    expect(useLogStore.getState().playing).toBe(true);
    expect(useLogStore.getState().hoverTime).toBeNull();
  });

  it('leaves the preview alone when pausing, so hover still previews', () => {
    const s = useLogStore.getState();
    s.setPlaying(false);
    s.setHoverTime(10);
    expect(selectDisplayTime(useLogStore.getState())).toBe(10);
  });
});

describe('axisOverride', () => {
  const ROLL = { message: 'ATT', field: 'Roll' };
  const ALT = { message: 'GPS', field: 'Alt' };
  const overrides = () => useLogStore.getState().axisOverride;

  beforeEach(() => {
    useLogStore.setState({ selectedFields: [ROLL, ALT], axisOverride: {} });
  });

  it('pins a field and hands it back to automatic', () => {
    const { setAxisOverride } = useLogStore.getState();
    setAxisOverride('ATT.Roll', 1);
    expect(overrides()).toEqual({ 'ATT.Roll': 1 });
    setAxisOverride('ATT.Roll', null);
    expect(overrides()).toEqual({});
  });

  it('keeps the same object when nothing changes, so the plot does not rebuild', () => {
    const { setAxisOverride } = useLogStore.getState();
    setAxisOverride('ATT.Roll', 1);
    const before = overrides();
    setAxisOverride('ATT.Roll', 1);
    setAxisOverride('GPS.Alt', null); // never pinned
    expect(overrides()).toBe(before);
  });

  it('drops the pin when the field is hidden', () => {
    const s = useLogStore.getState();
    s.setAxisOverride('ATT.Roll', 1);
    s.toggleField(ROLL);
    expect(overrides()).toEqual({});
  });

  // Regression: purgeMessage drops selected fields directly instead of going
  // through toggleField, so a pin used to survive it and spring back later.
  it('drops the pin when the whole message is purged', () => {
    // Purging now deletes from `parsed` — the projection holds references into
    // it, so removing a type from the view alone would free nothing — and
    // re-projects. Both halves have to be present for that to run at all.
    const messages = { ATT: {} as never, GPS: {} as never };
    useLogStore.setState({
      parsed: {
        source: 'bin',
        sources: [],
        startTime: 0,
        endTime: 1,
        bySource: new Map([[ALL_SOURCES, { messages, trajectory: {} } as never]]),
      } as never,
      selection: ALL_SOURCES,
      log: { messages, trajectory: {} as never, sources: [], selection: ALL_SOURCES, startTime: 0, endTime: 1 } as never,
    });
    const s = useLogStore.getState();
    s.setAxisOverride('ATT.Roll', 1);
    s.setAxisOverride('GPS.Alt', 1);
    s.purgeMessage('ATT');

    expect(overrides()).toEqual({ 'GPS.Alt': 1 });
    expect(useLogStore.getState().selectedFields).toEqual([ALT]);
  });
});

describe('viewRange', () => {
  const withLog = (startTime: number, endTime: number) =>
    useLogStore.setState({
      viewRange: null,
      log: { messages: {}, trajectory: {} as never, startTime, endTime } as never,
    });

  it('clamps a window to the log it belongs to', () => {
    withLog(1000, 5000);
    useLogStore.getState().setViewRange([-50, 99999]);
    expect(useLogStore.getState().viewRange).toEqual([1000, 5000]);
  });

  // Rebuilding the plot replays the carried zoom, so the same numbers arrive
  // again. A fresh tuple would re-render the download control for nothing, and
  // useSyncExternalStore compares selectExportWindow's result by identity.
  it('keeps the same array when the numbers have not moved', () => {
    withLog(0, 10_000);
    const { setViewRange } = useLogStore.getState();
    setViewRange([2000, 4000]);
    const first = useLogStore.getState().viewRange;
    setViewRange([2000, 4000]);
    expect(useLogStore.getState().viewRange).toBe(first);
  });

  // What the plot reports when a zoom is undone. reset() writes the field
  // directly, so it never exercises this path.
  it('takes null back when the plot stops being zoomed', () => {
    withLog(0, 10_000);
    const { setViewRange } = useLogStore.getState();
    setViewRange([2000, 4000]);
    setViewRange(null);
    expect(useLogStore.getState().viewRange).toBeNull();
  });

  it('is cleared when a different log is opened', () => {
    withLog(0, 10_000);
    useLogStore.getState().setViewRange([2000, 4000]);
    useLogStore.getState().reset();
    expect(useLogStore.getState().viewRange).toBeNull();
    expect(useLogStore.getState().file).toBeNull();
  });
});

describe('selectExportWindow', () => {
  it('offers nothing while the plot is showing everything it has', () => {
    useLogStore.setState({ viewRange: null });
    expect(selectExportWindow(useLogStore.getState())).toBeNull();
  });

  // The identity is the point: see the selector's comment.
  it('hands back the stored tuple itself, not a copy', () => {
    const range: [number, number] = [2000, 4000];
    useLogStore.setState({ viewRange: range });
    expect(selectExportWindow(useLogStore.getState())).toBe(range);
  });

  it('offers nothing for a window with no width', () => {
    useLogStore.setState({ viewRange: [2000, 2000] });
    expect(selectExportWindow(useLogStore.getState())).toBeNull();
    useLogStore.setState({ viewRange: [4000, 2000] });
    expect(selectExportWindow(useLogStore.getState())).toBeNull();
  });
});

// A plan file is read on the main thread, so these exercise the store directly.
const planFile = (name: string, body: string) => new File([body], name);
const WPL = ['QGC WPL 110', '0\t1\t0\t16\t0\t0\t0\t0\t35.0\t139.0\t0\t1'].join('\n');

describe('loadMissionFile', () => {
  beforeEach(() => {
    useLogStore.setState({ missionFile: null, missionFileError: null });
  });

  it('keeps the loaded plan when a later file fails to parse', async () => {
    const { loadMissionFile } = useLogStore.getState();
    await loadMissionFile(planFile('good.waypoints', WPL));
    expect(useLogStore.getState().missionFile?.name).toBe('good.waypoints');

    await loadMissionFile(planFile('junk.txt', 'not a mission file'));
    const s = useLogStore.getState();
    // Picking the wrong file reports why without discarding the right one.
    expect(s.missionFile?.name).toBe('good.waypoints');
    expect(s.missionFileError).toMatch(/not a mission file/i);
  });

  it('clears a stale error once a good file loads', async () => {
    const { loadMissionFile } = useLogStore.getState();
    await loadMissionFile(planFile('junk.txt', 'nope'));
    expect(useLogStore.getState().missionFileError).toBeTruthy();

    await loadMissionFile(planFile('good.waypoints', WPL));
    expect(useLogStore.getState().missionFileError).toBeNull();
  });

  it('lets a load already in flight be superseded rather than land late', async () => {
    const { loadMissionFile, clearMissionFile } = useLogStore.getState();
    const inFlight = loadMissionFile(planFile('slow.waypoints', WPL));
    // Dismissed before the read resolves: the result must not reinstate it.
    clearMissionFile();
    await inFlight;
    expect(useLogStore.getState().missionFile).toBeNull();
  });

  it('rejects a file too large to be a plan without reading it', async () => {
    const huge = planFile('log.txt', WPL);
    Object.defineProperty(huge, 'size', { value: 64 * 1024 * 1024 });
    await useLogStore.getState().loadMissionFile(huge);
    const s = useLogStore.getState();
    expect(s.missionFile).toBeNull();
    expect(s.missionFileError).toMatch(/too large/i);
  });

  it('drops the plan when a different log is opened', () => {
    useLogStore.setState({
      missionFile: { name: 'p.waypoints', waypoints: [], unreadable: 0 },
      missionFileError: 'stale',
    });
    // parseFile spawns a worker, which jsdom-less vitest cannot run; reset takes
    // the same clearing path and is what "Open another log" calls.
    useLogStore.getState().reset();
    const s = useLogStore.getState();
    expect(s.missionFile).toBeNull();
    expect(s.missionFileError).toBeNull();
  });
});

// ---- Switching between MAVLink sources ----

/** A parse with two sources, only one of which flies and carries a track. */
function loadTwoSources() {
  const col = (v: number[]) => Float64Array.from(v);
  const series = (name: string, time: number[], fields: Record<string, number[]>) => ({
    name, time: col(time), labels: Object.keys(fields),
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, col(v)])),
  });
  const track = {
    time: col([0, 1000]), lat: col([35, 36]), lon: col([139, 140]),
    alt: col([1, 2]), heading: col([90, 90]),
  };
  const empty = {
    time: col([]), lat: col([]), lon: col([]), alt: col([]), heading: col([]),
  };
  const vehicle = {
    messages: {
      ATTITUDE: series('ATTITUDE', [0, 1000], { roll: [0, 0.1] }),
      HEARTBEAT: series('HEARTBEAT', [0, 1000], { customMode: [0, 10] }),
    },
    params: {}, modes: [], texts: [], commands: [], missionSteps: [], mission: [],
    trajectory: track,
  };
  const gcs = {
    // Its only field is a clock, which is what the defaultFields fallback has
    // to refuse to plot.
    messages: {
      GPS_INPUT: series('GPS_INPUT', [0, 1000], { timeUsec: [1e15, 1e15 + 1] }),
      HEARTBEAT: series('HEARTBEAT', [500], { customMode: [0] }),
    },
    params: {}, modes: [], texts: [], commands: [], missionSteps: [], mission: [],
    trajectory: empty,
  };
  const parsed = {
    source: 'tlog',
    startTime: 0,
    endTime: 2000,
    sources: [
      { sysid: 1, compid: 1, mavType: 11, records: 4, startTime: 0, endTime: 1000 },
      { sysid: 255, compid: 190, mavType: 6, records: 3, startTime: 0, endTime: 1000 },
    ],
    bySource: new Map<string, unknown>([['1/1', vehicle], ['255/190', gcs]]),
  } as unknown as ParsedLog;

  const log = projectLog(parsed, '1/1');
  useLogStore.setState({
    parsed, selection: '1/1', log, loadId: 5, mapKey: 5,
    selectedFields: [{ message: 'ATTITUDE', field: 'roll' }],
    axisOverride: {}, viewRange: [100, 900], cursorTime: 400, playing: false,
  });
  return { parsed, vehicle, gcs };
}

/**
 * One aircraft of three components, beside a second aircraft of one.
 *
 * Every component sends HEARTBEAT, so purging it under the group has to reach
 * all three — and stop before the other aircraft.
 */
function loadGroupedSystem() {
  const col = (v: number[]) => Float64Array.from(v);
  const series = (name: string, time: number[], fields: Record<string, number[]>) => ({
    name, time: col(time), labels: Object.keys(fields),
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, col(v)])),
  });
  const empty = { time: col([]), lat: col([]), lon: col([]), alt: col([]), heading: col([]) };
  const track = { time: col([0, 1000]), lat: col([35, 36]), lon: col([139, 140]), alt: col([1, 2]), heading: col([90, 90]) };
  const bare = { params: {}, modes: [], texts: [], commands: [], missionSteps: [], mission: [] };

  const vehicle4 = {
    messages: {
      HEARTBEAT: series('HEARTBEAT', [0, 1000], { customMode: [0, 10] }),
      GLOBAL_POSITION_INT: series('GLOBAL_POSITION_INT', [0, 1000], { lat: [35e7, 36e7] }),
    },
    ...bare, trajectory: track,
  };
  const peripheral = (t: number[]) => ({
    messages: { HEARTBEAT: series('HEARTBEAT', t, { customMode: t.map(() => 0) }) },
    ...bare, trajectory: empty,
  });
  const other = {
    messages: { HEARTBEAT: series('HEARTBEAT', [500], { customMode: [0] }) },
    ...bare, trajectory: empty,
  };
  const parsed = {
    source: 'tlog', startTime: 0, endTime: 2000,
    sources: [
      { sysid: 4, compid: 128, mavType: 0, records: 6, startTime: 0, endTime: 1000 },
      { sysid: 4, compid: 158, mavType: 0, records: 5, startTime: 0, endTime: 1000 },
      { sysid: 4, compid: 1, mavType: 11, records: 4, startTime: 0, endTime: 1000 },
      { sysid: 1, compid: 1, mavType: 11, records: 1, startTime: 0, endTime: 1000 },
    ],
    bySource: new Map<string, unknown>([
      ['4/128', peripheral([100, 1100])],
      ['4/158', peripheral([200, 1200])],
      ['4/1', vehicle4],
      ['1/1', other],
    ]),
  } as unknown as ParsedLog;

  const log = projectLog(parsed, '4/*');
  useLogStore.setState({
    parsed, selection: '4/*', log, loadId: 5, mapKey: 5,
    selectedFields: [], axisOverride: {}, viewRange: null, cursorTime: 0, playing: false,
  });
  return { parsed, vehicle4 };
}

describe('setSelection', () => {
  it('shows the chosen source and drops fields it does not carry', () => {
    loadTwoSources();
    useLogStore.getState().setSelection('255/190');

    const s = useLogStore.getState();
    expect(s.selection).toBe('255/190');
    expect(Object.keys(s.log!.messages).sort()).toEqual(['GPS_INPUT', 'HEARTBEAT']);
    expect(s.selectedFields).not.toContainEqual({ message: 'ATTITUDE', field: 'roll' });
  });

  // Fields the new source does have are worth keeping: a reader comparing two
  // vehicles is looking at the same signal on each.
  it('keeps a field both sources carry', () => {
    loadTwoSources();
    const s = useLogStore.getState();
    s.toggleField({ message: 'ATTITUDE', field: 'roll' }); // clear
    s.toggleField({ message: 'HEARTBEAT', field: 'customMode' });
    s.setSelection('255/190');

    expect(useLogStore.getState().selectedFields).toEqual([
      { message: 'HEARTBEAT', field: 'customMode' },
    ]);
  });

  // The fallback picks the first numeric field of the first message, and
  // GPS_INPUT's is `timeUsec` — a UNIX timestamp in microseconds, which as a
  // plot is a straight line at 1e15.
  it('does not fall back onto a timestamp column', () => {
    loadTwoSources();
    useLogStore.getState().setSelection('255/190');
    // Pinned positively: a bare `not.toBe('timeUsec')` over the list would also
    // pass if the fallback picked nothing at all.
    expect(useLogStore.getState().selectedFields).toEqual([
      { message: 'HEARTBEAT', field: 'customMode' },
    ]);
  });

  // The timeline spans every source, so nothing about the reader's place in it
  // has stopped being true. `loadId` in particular tags PlotPanel's carried
  // zoom: bumping it would throw the window away, and uPlot would then report
  // an un-zoomed view and clear viewRange — taking the download control too.
  it('leaves the clock, the window and the plot identity alone', () => {
    loadTwoSources();
    const before = useLogStore.getState();
    useLogStore.getState().setSelection('255/190');
    const after = useLogStore.getState();

    expect(after.log!.startTime).toBe(before.log!.startTime);
    expect(after.log!.endTime).toBe(before.log!.endTime);
    expect(after.cursorTime).toBe(before.cursorTime);
    expect(after.viewRange).toBe(before.viewRange);
    expect(after.loadId).toBe(before.loadId);
    // The map is the one thing that has to start over: it is drawing a
    // different vehicle's track, or none.
    expect(after.mapKey).toBe(before.mapKey + 1);
  });

  it('stops playback, which was following a different vehicle', () => {
    loadTwoSources();
    useLogStore.setState({ playing: true });
    useLogStore.getState().setSelection('255/190');
    expect(useLogStore.getState().playing).toBe(false);
  });

  it('does nothing when the selection has not moved', () => {
    loadTwoSources();
    const before = useLogStore.getState().log;
    useLogStore.getState().setSelection('1/1');
    expect(useLogStore.getState().log).toBe(before);
  });
});

describe('purging with sources', () => {
  // The button says it reduces memory usage. Dropping a type from the
  // projection alone would free nothing, because the projection is references
  // into the parse.
  it('removes the columns from the parse, not just from the view', () => {
    const { parsed } = loadTwoSources();
    useLogStore.getState().purgeMessage('ATTITUDE');

    const after = useLogStore.getState();
    expect(after.log!.messages.ATTITUDE).toBeUndefined();
    expect(after.parsed!.bySource.get('1/1')!.messages.ATTITUDE).toBeUndefined();
    // And the original is left alone rather than mutated underneath anyone.
    expect(parsed.bySource.get('1/1')!.messages.ATTITUDE).toBeDefined();
  });

  it('does not bring a purged type back when the source is revisited', () => {
    loadTwoSources();
    const s = useLogStore.getState();
    s.purgeMessage('ATTITUDE');
    s.setSelection('255/190');
    useLogStore.getState().setSelection('1/1');

    expect(useLogStore.getState().log!.messages.ATTITUDE).toBeUndefined();
  });

  // Under a single source, only that source's copy goes: the other vehicle's
  // HEARTBEAT is not what the reader was looking at.
  it('leaves the other sources\' copies alone', () => {
    loadTwoSources();
    useLogStore.getState().purgeMessage('HEARTBEAT');

    const after = useLogStore.getState();
    expect(after.parsed!.bySource.get('1/1')!.messages.HEARTBEAT).toBeUndefined();
    expect(after.parsed!.bySource.get('255/190')!.messages.HEARTBEAT).toBeDefined();
  });

  // Regression for the map: `trajectory` is stored per source rather than
  // derived from whatever messages survive, so purging the position message
  // cannot take the track with it.
  it('keeps the map\'s track, by reference', () => {
    const { vehicle } = loadTwoSources();
    const before = useLogStore.getState().log!.trajectory;
    useLogStore.getState().purgeMessage('ATTITUDE');

    expect(useLogStore.getState().log!.trajectory).toBe(before);
    expect(useLogStore.getState().log!.trajectory).toBe(vehicle.trajectory);
  });

  // The pin test above reaches this branch too, but with a single source its two
  // arms are the same array. With two sources they differ, and a regression to
  // "always the selected source" turns ✕ into a silent no-op here: no tlog has a
  // source keyed ALL_SOURCES, so dropTypes would find nothing to drop.
  it('under all sources, clears the type from every sender', () => {
    loadTwoSources();
    useLogStore.getState().setSelection(ALL_SOURCES);
    useLogStore.getState().purgeMessage('HEARTBEAT');

    const after = useLogStore.getState();
    expect(after.parsed!.bySource.get('1/1')!.messages.HEARTBEAT).toBeUndefined();
    expect(after.parsed!.bySource.get('255/190')!.messages.HEARTBEAT).toBeUndefined();
    expect(after.log!.messages.HEARTBEAT).toBeUndefined();
  });

  // Unlike the per-message ✕, this one ignores the selection: "nothing plotted"
  // is a fact about the plot, and stopping at the selected source would leave
  // most of the memory it offers to free still allocated.
  it('clears unselected types from every source at once', () => {
    loadTwoSources();
    useLogStore.setState({ selectedFields: [{ message: 'ATTITUDE', field: 'roll' }] });
    useLogStore.getState().purgeUnselected();

    const after = useLogStore.getState();
    expect(after.parsed!.bySource.get('1/1')!.messages.ATTITUDE).toBeDefined();
    expect(after.parsed!.bySource.get('1/1')!.messages.HEARTBEAT).toBeUndefined();
    // The other source is cleared too, even though it was never on screen.
    expect(Object.keys(after.parsed!.bySource.get('255/190')!.messages)).toEqual([]);
  });

  // A SYSID group is one aircraft on screen, so ✕ takes the type off all of it —
  // and stops there. The other aircraft in the file keeps its copy.
  it('under a SYSID group, clears the type from every component of it', () => {
    loadGroupedSystem();
    useLogStore.getState().purgeMessage('HEARTBEAT');

    const after = useLogStore.getState();
    for (const key of ['4/1', '4/128', '4/158']) {
      expect(after.parsed!.bySource.get(key)!.messages.HEARTBEAT).toBeUndefined();
    }
    expect(after.parsed!.bySource.get('1/1')!.messages.HEARTBEAT).toBeDefined();
    expect(after.log!.messages.HEARTBEAT).toBeUndefined();
  });

  // The map's promise, restated for a group. Three assertions, not one: the
  // empty track is a module singleton, so "same reference before and after"
  // alone is also satisfied by a merge that hands back nothing at all.
  it('under a SYSID group, keeps the map\'s track by reference', () => {
    const { vehicle4 } = loadGroupedSystem();
    const before = useLogStore.getState().log!.trajectory;
    useLogStore.getState().purgeMessage('GLOBAL_POSITION_INT');

    const after = useLogStore.getState().log!.trajectory;
    expect(after).toBe(before);
    expect(after).toBe(vehicle4.trajectory);
    expect(after.lat.length).toBeGreaterThan(0);
  });

  // A .bin has no addresses: its one entry is keyed ALL_SOURCES and `sources` is
  // empty. Scoping the purge through `sources` would leave nothing to drop and
  // turn the button into a silent no-op — while every assertion about pins and
  // selected fields still passed.
  it('drops the columns of a .bin, which has no addresses at all', () => {
    const messages = {
      ATT: { name: 'ATT', time: Float64Array.from([0]), labels: ['Roll'], fields: { Roll: Float64Array.from([0]) } },
      GPS: { name: 'GPS', time: Float64Array.from([0]), labels: ['Alt'], fields: { Alt: Float64Array.from([1]) } },
    };
    const data = {
      messages, params: {}, modes: [], texts: [], commands: [], missionSteps: [], mission: [],
      trajectory: { time: Float64Array.from([]), lat: Float64Array.from([]), lon: Float64Array.from([]), alt: Float64Array.from([]), heading: Float64Array.from([]) },
    };
    const parsed = {
      source: 'bin', startTime: 0, endTime: 1, sources: [],
      bySource: new Map<string, unknown>([[ALL_SOURCES, data]]),
    } as unknown as ParsedLog;
    useLogStore.setState({
      parsed, selection: ALL_SOURCES, log: projectLog(parsed, ALL_SOURCES),
      selectedFields: [{ message: 'GPS', field: 'Alt' }], axisOverride: {},
    });

    useLogStore.getState().purgeMessage('ATT');

    const after = useLogStore.getState();
    expect(after.parsed!.bySource.get(ALL_SOURCES)!.messages.ATT).toBeUndefined();
    expect(after.parsed!.bySource.get(ALL_SOURCES)!.messages.GPS).toBeDefined();
    expect(after.log!.messages.ATT).toBeUndefined();
  });
});
