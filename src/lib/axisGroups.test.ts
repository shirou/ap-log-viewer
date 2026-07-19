import { describe, expect, it } from 'vitest';
import { assignAxes, extentOf, minFraction, type AxisSide, type Col } from './axisGroups.ts';

// Only the extremes matter, so a two-sample column stands in for a real one.
const band = (lo: number, hi: number): Col => [lo, hi];

// The plot scans columns once and re-runs assignAxes on the extents; go through
// the same pair here so the tests exercise what PlotPanel actually calls.
const assign = (cols: Col[], overrides?: (AxisSide | undefined)[]) => assignAxes(cols.map(extentOf), overrides);
const sides = (cols: Col[], overrides?: (AxisSide | undefined)[]) => assign(cols, overrides).side.join('');

// Ranges taken from real ArduPilot / MAVLink logs.
const ROLL = band(-30, 30);
const PITCH = band(-15, 15);
const ALT = band(0, 520);
const VOLT = band(12.2, 12.6);
const CURR = band(0, 40);
const RCOU = band(1000, 2000);
const DES_ROLL = band(-45, 40);
const GYR_X = band(-0.4, 0.5);
const ROLL2 = band(-40, 45);

describe('extentOf', () => {
  it('takes the true min and max', () => {
    expect(extentOf([3, -1, 7, 0])).toEqual({ lo: -1, hi: 7 });
  });

  it('ignores the union path nulls and the fast path NaNs', () => {
    expect(extentOf([null, 5, undefined, -2, null])).toEqual({ lo: -2, hi: 5 });
    expect(extentOf(new Float64Array([NaN, 4, NaN, 1]))).toEqual({ lo: 1, hi: 4 });
  });

  it('is null when nothing is finite', () => {
    expect(extentOf([])).toBeNull();
    expect(extentOf([null, null])).toBeNull();
    expect(extentOf([NaN, Infinity, -Infinity])).toBeNull();
  });
});

describe('minFraction', () => {
  // The denominator is uPlot's own range, so these are what actually renders.
  it('measures against uPlot padded range, not the raw union', () => {
    // [-30,30] -> uPlot [-36,36], span 72. Roll fills 60/72, Pitch 30/72.
    expect(minFraction([{ lo: -30, hi: 30 }, { lo: -15, hi: 15 }])).toBeCloseTo(30 / 72, 6);
  });

  it('reports Infinity when nothing present can be crushed', () => {
    expect(minFraction([])).toBe(Infinity);
    // All flat, at different values: no axis makes any of them worse.
    expect(minFraction([{ lo: 5, hi: 5 }, { lo: 900, hi: 900 }])).toBe(Infinity);
  });

  it('leaves constants out of the numerator but not the union', () => {
    // The constant at 520 stretches the axis and crushes the ±30 series.
    expect(minFraction([{ lo: -30, hi: 30 }, { lo: 520, hi: 520 }])).toBeLessThan(1 / 8);
  });
});

describe('assignAxes', () => {
  it('never splits fewer than two rankable series', () => {
    expect(assign([])).toEqual({ side: [], split: false });
    expect(assign([ALT])).toEqual({ side: [0], split: false });
    // One rankable series plus one with no finite samples is still not a pair.
    expect(assign([ALT, [null, NaN]])).toEqual({ side: [0, 0], split: false });
  });

  it('keeps comparable series on one axis', () => {
    expect(assign([ROLL, PITCH])).toEqual({ side: [0, 0], split: false });
  });

  it('splits series that would render flat together', () => {
    expect(assign([ROLL, ALT])).toEqual({ side: [0, 1], split: true });
    // Same order of magnitude, but 12.2-12.6 on a 0-40 axis is a flat line.
    expect(assign([VOLT, CURR])).toEqual({ side: [0, 1], split: true });
  });

  it('groups three ranges onto two axes', () => {
    expect(sides([ROLL, ALT, RCOU])).toBe('011');
  });

  // Regression for the reason every partition is enumerated: a cut through any
  // sorted order cannot isolate the middle series, so it would strand GyrX on
  // an axis reaching ±45 degrees.
  it('isolates a small centred series from a near-mirror pair', () => {
    expect(sides([DES_ROLL, GYR_X, ROLL2])).toBe('010');
  });

  it('separates equal-sized bands of opposite sign', () => {
    expect(sides([band(400, 500), band(-500, -400)])).toBe('01');
  });

  it('leaves flat series alone', () => {
    // Nothing here can be crushed, so there is nothing to fix by splitting.
    expect(assign([band(5, 5), band(900, 900)])).toEqual({ side: [0, 0], split: false });
    expect(assign([band(0, 0), band(0, 0)])).toEqual({ side: [0, 0], split: false });
    // A constant that stretches the axis does get moved off it.
    expect(sides([ROLL, band(520, 520)])).toBe('01');
  });

  it('parks unrankable columns on the left', () => {
    expect(sides([ROLL, [null, null], ALT])).toBe('001');
  });

  it('handles negative-only ranges', () => {
    expect(sides([band(-520, -1), band(-30, 30)])).toBe('01');
  });

  it('applies an override even when the automatic pass found one axis', () => {
    // Roll and Pitch sit together happily; pinning Pitch right must still work,
    // otherwise the manual control is unreachable in the case that needs it.
    expect(assign([ROLL, PITCH], [undefined, 1])).toEqual({ side: [0, 1], split: true });
  });

  it('applies an override on top of a split', () => {
    expect(assign([ROLL, ALT], [undefined, 0])).toEqual({ side: [0, 0], split: false });
    expect(assign([ROLL, ALT], [1, undefined])).toEqual({ side: [1, 1], split: true });
  });

  it('ignores gaps when ranking', () => {
    const gappy: Col = [null, -30, NaN, 30, null];
    expect(assign([gappy, PITCH])).toEqual({ side: [0, 0], split: false });
    expect(assign([gappy, ALT])).toEqual({ side: [0, 1], split: true });
  });
});
