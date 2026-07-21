import { describe, expect, it } from 'vitest';
import { columnStats, linearFit, pearson } from './stats.ts';

describe('columnStats', () => {
  it('computes mean/min/max/std/rms over finite samples', () => {
    const s = columnStats(new Float64Array([2, 4, 4, 4, 5, 5, 7, 9]));
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.count).toBe(8);
    expect(s.mean).toBeCloseTo(5, 10);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.std).toBeCloseTo(2.13808993, 6); // sample stddev (n-1): sqrt(32/7)
    expect(s.rms).toBeCloseTo(Math.sqrt(232 / 8), 10);
  });

  it('skips NaN and honours the range', () => {
    const s = columnStats(new Float64Array([99, 1, NaN, 3, 99]), 1, 4);
    expect(s?.count).toBe(2);
    expect(s?.mean).toBeCloseTo(2, 10);
  });

  it('single sample: std 0, cv NaN when mean is 0', () => {
    expect(columnStats(new Float64Array([5]))).toMatchObject({ count: 1, std: 0 });
    expect(columnStats(new Float64Array([0]))?.cv).toBeNaN();
  });

  it('returns null when nothing is finite', () => {
    expect(columnStats(new Float64Array([NaN, NaN]))).toBeNull();
    expect(columnStats(new Float64Array(0))).toBeNull();
  });
});

describe('linearFit / pearson', () => {
  it('recovers a known line with r = 1', () => {
    const f = linearFit(new Float64Array([0, 1, 2, 3, 4]), new Float64Array([1, 3, 5, 7, 9])); // y = 2x + 1
    expect(f.slope).toBeCloseTo(2, 10);
    expect(f.intercept).toBeCloseTo(1, 10);
    expect(f.r).toBeCloseTo(1, 10);
    expect(f.count).toBe(5);
  });

  it('flat data: slope 0, r NaN (no y variance)', () => {
    const f = linearFit(new Float64Array([0, 1, 2]), new Float64Array([5, 5, 5]));
    expect(f.slope).toBeCloseTo(0, 10);
    expect(f.r).toBeNaN();
  });

  it('skips NaN pairs and needs >= 2', () => {
    const f = linearFit(new Float64Array([0, NaN, 2]), new Float64Array([1, 1, 5]));
    expect(f.count).toBe(2);
    expect(f.slope).toBeCloseTo(2, 10);
    expect(linearFit(new Float64Array([1]), new Float64Array([1])).slope).toBeNaN();
  });

  it('pearson is +/-1 for (anti)correlated, NaN for constant', () => {
    expect(pearson(new Float64Array([1, 2, 3]), new Float64Array([2, 4, 6]))).toBeCloseTo(1, 10);
    expect(pearson(new Float64Array([1, 2, 3]), new Float64Array([6, 4, 2]))).toBeCloseTo(-1, 10);
    expect(pearson(new Float64Array([1, 1, 1]), new Float64Array([1, 2, 3]))).toBeNaN();
  });
});
