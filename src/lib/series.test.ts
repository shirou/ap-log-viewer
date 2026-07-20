import { describe, expect, it } from 'vitest';
import { formatDuration, nearestSampleIndex, rangeValueAtX } from './series.ts';

// The rect is the track element itself, so the value spans it edge to edge.
const RECT = { left: 100, width: 600 };
const at = (x: number, step = 0) => rangeValueAtX(x, RECT, 0, 1000, step);

describe('rangeValueAtX', () => {
  it('maps the measured track edge to edge', () => {
    expect(at(100)).toBe(0);
    expect(at(400)).toBe(500);
    expect(at(700)).toBe(1000);
  });

  it('clamps outside the track instead of extrapolating', () => {
    expect(at(RECT.left)).toBe(0);
    expect(at(-5000)).toBe(0);
    expect(at(RECT.left + RECT.width)).toBe(1000);
    expect(at(5000)).toBe(1000);
  });

  it('snaps to step, matching what a click would commit', () => {
    expect(at(340, 250)).toBe(500); // raw 400 -> nearest 250 multiple
    expect(at(280, 250)).toBe(250); // raw 300 -> rounds down
  });

  it('stops at the last reachable step when one does not land on max', () => {
    // Stops are 0/300/600/900: the far right rests on 900, not 1000.
    expect(at(700, 300)).toBe(900);
    expect(at(100, 300)).toBe(0);
    // Stops are 0/400/800. Rounding 1000 up would give 1200; clamping that to
    // max would report 1000 — a value the input can never hold.
    expect(at(700, 400)).toBe(800);
  });

  it('does not divide by zero on a collapsed input', () => {
    expect(Number.isFinite(rangeValueAtX(50, { left: 0, width: 0 }, 0, 1000, 1))).toBe(true);
  });

  it('leaves the value unsnapped when step is not positive', () => {
    expect(at(400, 0)).toBe(500);
  });
});

describe('formatDuration', () => {
  const at = (sec: number) => formatDuration(sec * 1e6);

  it('formats minutes and tenths of a second', () => {
    expect(at(0)).toBe('0:00.0');
    expect(at(65.04)).toBe('1:05.0');
    expect(at(3599.94)).toBe('59:59.9');
  });

  // Regression: rounding the seconds after splitting let them reach 60 without
  // carrying, so the readout flashed "0:60.0" at every minute boundary.
  it('carries into the minute instead of showing 60 seconds', () => {
    expect(at(59.98)).toBe('1:00.0');
    expect(at(119.97)).toBe('2:00.0');
    expect(at(3599.98)).toBe('60:00.0');
  });

  it('clamps a negative duration to zero', () => {
    expect(at(-5)).toBe('0:00.0');
  });
});

describe('nearestSampleIndex', () => {
  const times = Float64Array.from([10, 20, 30, 40]);

  it('finds the sample either side of an instant it does not hold', () => {
    expect(nearestSampleIndex(times, 21)).toBe(1);
    expect(nearestSampleIndex(times, 29)).toBe(2);
  });

  it('takes the earlier sample when the instant sits exactly between two', () => {
    expect(nearestSampleIndex(times, 25)).toBe(1);
  });

  it('hits an exact timestamp', () => {
    expect(nearestSampleIndex(times, 10)).toBe(0);
    expect(nearestSampleIndex(times, 30)).toBe(2);
    expect(nearestSampleIndex(times, 40)).toBe(3);
  });

  // Outside its own samples the plot draws no line for the series, so there is
  // no value to report — clamping to an end would invent one.
  it('reports nothing outside the series', () => {
    expect(nearestSampleIndex(times, 9.9)).toBeNull();
    expect(nearestSampleIndex(times, 40.1)).toBeNull();
    expect(nearestSampleIndex(new Float64Array(0), 10)).toBeNull();
  });

  it('answers for a single-sample series only at its own instant', () => {
    const one = Float64Array.from([10]);
    expect(nearestSampleIndex(one, 10)).toBe(0);
    expect(nearestSampleIndex(one, 11)).toBeNull();
  });

  // A message with no time column inherits the last timestamp seen, so a run of
  // its samples can share one. A timestamp cannot pick between them, which is
  // why PlotPanel addresses them by index instead of calling this.
  it('cannot pick within a run sharing a timestamp, and says so by taking the last', () => {
    expect(nearestSampleIndex(Float64Array.from([10, 20, 20, 20, 30]), 20)).toBe(3);
  });

  // The bug this exists for: two messages at different rates share a plot, and
  // the cursor lands on a timestamp only the fast one logged. The slow series
  // must still report — it is drawn right there on the same plot.
  it('answers for a slow series at a fast series timestamp', () => {
    const slow = Float64Array.from([0, 200_000, 400_000]); // 5 Hz, in µs
    const fast = Float64Array.from(Array.from({ length: 161 }, (_, i) => i * 2500)); // 400 Hz
    for (const t of fast) {
      const i = nearestSampleIndex(slow, t);
      expect(i).not.toBeNull();
      expect(Math.abs(slow[i as number] - t)).toBeLessThanOrEqual(100_000);
    }
  });
});
