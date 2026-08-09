import { beforeEach, describe, expect, it } from 'vitest';
import { selectDisplayTime, selectExportWindow, useLogStore } from './logStore.ts';

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
    useLogStore.setState({
      log: {
        messages: { ATT: {} as never, GPS: {} as never },
        trajectory: {} as never,
        startTime: 0,
        endTime: 1,
      } as never,
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
