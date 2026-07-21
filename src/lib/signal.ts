// Accessors and resampling over the columnar log model, shared by the analysis
// modules. Kept apart from the React components so they stay pure and testable.

import type { FieldRef, LogData } from '../model/log.ts';
import { searchSortedLE } from './series.ts';

export interface Column {
  /** Timestamps, microseconds, sorted ascending. Held by reference (no copy). */
  time: Float64Array;
  /** Values aligned index-for-index with `time`. */
  values: Float64Array;
}

/**
 * The column a FieldRef points at, or null when the log has no such field.
 *
 * Mirrors the access in PlotPanel.buildData: a ref the log carries no column for
 * yields null rather than throwing, so callers can map over a selection and drop
 * the misses.
 */
export function getColumn(log: LogData, ref: FieldRef): Column | null {
  const m = log.messages[ref.message];
  const values = m?.fields[ref.field];
  return values ? { time: m.time, values } : null;
}

/**
 * Linearly interpolate a source series onto `targetTime`.
 *
 * For pairing two smoothly-varying signals logged at different rates (e.g. |B|
 * against battery current). Targets outside the source's [t_first, t_last] are
 * NaN on both ends — a sample-and-hold there would fabricate data the source
 * never carried, and downstream fits skip NaN pairs. `srcTime` must be sorted.
 */
export function resampleLinear(
  srcTime: ArrayLike<number>,
  srcVals: ArrayLike<number>,
  targetTime: ArrayLike<number>,
): Float64Array {
  const out = new Float64Array(targetTime.length);
  const n = srcTime.length;
  if (n === 0) {
    out.fill(NaN);
    return out;
  }
  const first = srcTime[0];
  const last = srcTime[n - 1];
  for (let k = 0; k < targetTime.length; k++) {
    const t = targetTime[k];
    if (t < first || t > last) {
      out[k] = NaN;
      continue;
    }
    const i = searchSortedLE(srcTime, t);
    const t0 = srcTime[i];
    if (t0 === t || i + 1 >= n) {
      out[k] = srcVals[i];
      continue;
    }
    const t1 = srcTime[i + 1];
    const w = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    out[k] = srcVals[i] + w * (srcVals[i + 1] - srcVals[i]);
  }
  return out;
}
