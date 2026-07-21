import { describe, expect, it } from 'vitest';
import { alignAngles, detrend, getColumn, medianStep, resampleLinear, toUniform, unwrapAngle } from './signal.ts';
import { rangeIndices } from './series.ts';
import type { LogData, MessageSeries } from '../model/log.ts';

function logOf(messages: Record<string, MessageSeries>): LogData {
  return {
    source: 'bin',
    messages,
    params: {},
    modes: [],
    texts: [],
    trajectory: {
      time: new Float64Array(0),
      lat: new Float64Array(0),
      lon: new Float64Array(0),
      alt: new Float64Array(0),
      heading: new Float64Array(0),
    },
    mission: [],
    startTime: 0,
    endTime: 0,
  };
}

describe('rangeIndices', () => {
  const t = new Float64Array([0, 10, 20, 30, 40]);
  it('returns the inclusive index window', () => {
    expect(rangeIndices(t, 10, 30)).toEqual([1, 4]);
    expect(rangeIndices(t, 0, 40)).toEqual([0, 5]);
  });
  it('snaps to first at-or-after and last at-or-before', () => {
    expect(rangeIndices(t, 5, 35)).toEqual([1, 4]); // 10,20,30
    expect(rangeIndices(t, 15, 25)).toEqual([2, 3]); // just 20
  });
  it('is empty for out-of-range, inverted, between-samples, or empty input', () => {
    expect(rangeIndices(t, 50, 60)).toEqual([0, 0]);
    expect(rangeIndices(t, -20, -10)).toEqual([0, 0]);
    expect(rangeIndices(t, 30, 10)).toEqual([0, 0]);
    expect(rangeIndices(t, 12, 18)).toEqual([0, 0]);
    expect(rangeIndices(new Float64Array(0), 0, 10)).toEqual([0, 0]);
  });
  it('includes every sample of an interior duplicate-timestamp run', () => {
    // A message with no time column inherits the last stamp, so runs are real.
    const dup = new Float64Array([0, 10, 10, 10, 20]);
    expect(rangeIndices(dup, 10, 10)).toEqual([1, 4]);
    expect(rangeIndices(dup, 10, 20)).toEqual([1, 5]);
    expect(rangeIndices(dup, 5, 15)).toEqual([1, 4]);
  });
});

describe('getColumn', () => {
  const l = logOf({
    MAG: { name: 'MAG', fields: { MagX: new Float64Array([1, 2]) }, labels: ['MagX'], time: new Float64Array([0, 1]) },
  });
  it('returns the column for a present field, null otherwise', () => {
    expect(getColumn(l, { message: 'MAG', field: 'MagX' })?.values[1]).toBe(2);
    expect(getColumn(l, { message: 'MAG', field: 'MagY' })).toBeNull();
    expect(getColumn(l, { message: 'NOPE', field: 'X' })).toBeNull();
  });
});

describe('resampleLinear', () => {
  const st = new Float64Array([0, 10, 20]);
  const sv = new Float64Array([0, 10, 30]);
  it('interpolates linearly within range', () => {
    const out = resampleLinear(st, sv, new Float64Array([0, 5, 10, 15, 20]));
    expect(Array.from(out)).toEqual([0, 5, 10, 20, 30]);
  });
  it('is NaN outside the source range on both ends', () => {
    const out = resampleLinear(st, sv, new Float64Array([-1, 21]));
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
  });
  it('empty source yields all NaN', () => {
    const out = resampleLinear(new Float64Array(0), new Float64Array(0), new Float64Array([1, 2]));
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
  });
});

describe('unwrapAngle', () => {
  it('turns a wrap into a small step', () => {
    const out = unwrapAngle(new Float64Array([350, 355, 359, 3, 8]));
    expect(Array.from(out)).toEqual([350, 355, 359, 363, 368]);
  });

  it('unwraps downwards too', () => {
    const out = unwrapAngle(new Float64Array([5, 1, 357, 353]));
    expect(Array.from(out)).toEqual([5, 1, -3, -7]);
  });

  it('accumulates across several turns', () => {
    // Steady -20°/sample rotation crossing zero twice.
    const out = unwrapAngle(new Float64Array([10, 350, 330, 310, 290, 270]));
    expect(Array.from(out)).toEqual([10, -10, -30, -50, -70, -90]);
  });

  it('reads a jitter across the wrap as jitter, not as turns', () => {
    const out = unwrapAngle(new Float64Array([0, 359, 0, 359, 0]));
    expect(Array.from(out)).toEqual([0, -1, 0, -1, 0]);
  });

  it('honours a non-360 period', () => {
    const out = unwrapAngle(new Float64Array([3.1, -3.1]), 2 * Math.PI);
    expect(out[1]).toBeCloseTo(3.1832, 3);
  });

  it('passes NaN through without disturbing the offset', () => {
    const out = unwrapAngle(new Float64Array([358, NaN, 2]));
    expect(out[0]).toBe(358);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(362);
  });
});

describe('alignAngles', () => {
  it('cancels a whole-turn offset between two series', () => {
    const a = new Float64Array([10, 20, 30]);
    const b = new Float64Array([372, 381, 391]); // same headings, one turn out
    expect(Array.from(alignAngles(a, b))).toEqual([12, 21, 31]);
  });

  it('leaves an already-aligned pair alone', () => {
    const a = new Float64Array([100, 110]);
    const b = new Float64Array([103, 108]);
    expect(Array.from(alignAngles(a, b))).toEqual([103, 108]);
  });

  // The failure this exists for: a demand that jumps at a waypoint change is
  // unwrapped as a turn, and every later sample of the pair is then a circle
  // apart, which reads as an enormous tracking error.
  it('holds the error bounded even as the branches diverge', () => {
    const n = 50;
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = i * 5;
      b[i] = i * 5 + 3 - 360 * Math.floor(i / 10); // drifts a turn every 10 samples
    }
    const aligned = alignAngles(a, b);
    for (let i = 0; i < n; i++) expect(aligned[i] - a[i]).toBeCloseTo(3, 9);
  });

  it('passes NaN through', () => {
    expect(alignAngles(new Float64Array([0]), new Float64Array([NaN]))[0]).toBeNaN();
  });
});

describe('medianStep', () => {
  it('is the median spacing, robust to one gap', () => {
    expect(medianStep(new Float64Array([0, 10, 20, 500, 510]))).toBe(10);
  });
  it('is NaN with fewer than two samples', () => {
    expect(medianStep(new Float64Array([5]))).toBeNaN();
  });
});

describe('toUniform', () => {
  it('grids an unevenly-sampled window at the median spacing', () => {
    // Spacings 10, 9, 11, 11, 9 -> median 10.
    const time = new Float64Array([0, 10, 19, 30, 41, 50]);
    const values = Float64Array.from(time);
    const u = toUniform(time, values, 0, 6)!;
    expect(u.dtSec).toBeCloseTo(10e-6, 12);
    expect(Array.from(u.times)).toEqual([0, 10, 20, 30, 40, 50]);
    // Values track time here, so the interpolated grid reproduces the ramp.
    for (let i = 0; i < u.values.length; i++) expect(u.values[i]).toBeCloseTo(u.times[i], 6);
    expect(u.nanCount).toBe(0);
  });

  // Stretching a uniform grid across a dropout would move every later sample,
  // which reads as a frequency shift.
  it('uses only the longest gap-free run and says what it dropped', () => {
    const time = new Float64Array([0, 10, 20, 5000, 5010, 5020, 5030, 5040]);
    const values = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const u = toUniform(time, values, 0, 8)!;
    expect(u.times[0]).toBe(5000);
    expect(u.times[u.times.length - 1]).toBe(5040);
    expect(u.droppedSamples).toBe(3);
  });

  it('respects the window bounds it is given', () => {
    const time = new Float64Array([0, 10, 20, 30, 40, 50, 60]);
    const values = new Float64Array([0, 1, 2, 3, 4, 5, 6]);
    const u = toUniform(time, values, 2, 7)!;
    expect(u.times[0]).toBe(20);
    expect(u.times[u.times.length - 1]).toBe(60);
  });

  it('returns null when the window is too short or has no time span', () => {
    const time = new Float64Array([0, 10, 20]);
    expect(toUniform(time, new Float64Array([1, 2, 3]), 0, 3)).toBeNull();
    const flat = new Float64Array([5, 5, 5, 5, 5]);
    expect(toUniform(flat, flat, 0, 5)).toBeNull();
  });

  it('counts non-finite samples so a caller can refuse them', () => {
    const time = new Float64Array([0, 10, 20, 30, 40]);
    const values = new Float64Array([1, NaN, 3, 4, 5]);
    expect(toUniform(time, values, 0, 5)!.nanCount).toBeGreaterThan(0);
  });
});

describe('detrend', () => {
  it('reduces a pure ramp to zero', () => {
    const out = detrend(new Float64Array([1, 2, 3, 4, 5]));
    for (const v of out) expect(v).toBeCloseTo(0, 9);
  });

  // What it must remove is the ramp and only the ramp: the oscillation a
  // spectrum is after has to come through untouched.
  it('removes the ramp a signal rides on and nothing else', () => {
    const n = 64;
    const wave = new Float64Array(n);
    const withRamp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      wave[i] = Math.sin((2 * Math.PI * i) / 16);
      withRamp[i] = 100 + 0.5 * i + wave[i];
    }
    const a = detrend(wave);
    const b = detrend(withRamp);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      mean += b[i];
      expect(b[i]).toBeCloseTo(a[i], 8);
    }
    expect(mean / n).toBeCloseTo(0, 9);
  });

  it('excludes NaN from the fit and passes it through', () => {
    // The finite samples lie exactly on i+1, so a fit that ignored the hole
    // leaves no residual; one that folded NaN in would return all NaN.
    const out = detrend(new Float64Array([1, 2, NaN, 4, 5]));
    expect(out[2]).toBeNaN();
    expect(out[0]).toBeCloseTo(0, 9);
    expect(out[4]).toBeCloseTo(0, 9);
  });
});
