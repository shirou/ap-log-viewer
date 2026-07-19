import { beforeEach, describe, expect, it } from 'vitest';
import { selectDisplayTime, useLogStore } from './logStore.ts';

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
