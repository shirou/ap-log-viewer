import { describe, expect, it } from 'vitest';
import { getColumn, resampleLinear } from './signal.ts';
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
