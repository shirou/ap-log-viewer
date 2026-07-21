// Accessors and resampling over the columnar log model, shared by the analysis
// modules. Kept apart from the React components so they stay pure and testable.

import type { FieldRef, LogData } from '../model/log.ts';
import { rangeIndices, searchSortedLE } from './series.ts';

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

export interface PairedColumns {
  /** Shared timestamps, microseconds. */
  times: Float64Array;
  a: Float64Array;
  b: Float64Array;
}

/**
 * Sample two columns onto shared timestamps over [t0, t1], for plotting one
 * against the other.
 *
 * The sparser series' own timestamps become the target and the denser one is
 * interpolated onto them. Choosing it the other way round would mint a sample
 * of the sparse signal everywhere the dense one has a row — a 4 Hz current
 * reading would arrive 400 times a second — and every one of those invented
 * points would then carry equal weight in the fit.
 *
 * Returns null when either column has no samples in the window.
 */
export function pairOnCommonTime(a: Column, b: Column, t0: number, t1: number): PairedColumns | null {
  const [a0, a1] = rangeIndices(a.time, t0, t1);
  const [b0, b1] = rangeIndices(b.time, t0, t1);
  const aCount = a1 - a0;
  const bCount = b1 - b0;
  if (aCount === 0 || bCount === 0) return null;
  if (aCount <= bCount) {
    const times = a.time.subarray(a0, a1);
    return { times, a: a.values.subarray(a0, a1), b: resampleLinear(b.time, b.values, times) };
  }
  const times = b.time.subarray(b0, b1);
  return { times, a: resampleLinear(a.time, a.values, times), b: b.values.subarray(b0, b1) };
}

/** A copy of `v` with every element multiplied by `scale` (identity when 1). */
export function scaled(v: Float64Array, scale: number): Float64Array {
  return scale === 1 ? v : Float64Array.from(v, (x) => x * scale);
}

/**
 * Undo the wrap of an angular series so successive samples differ by less than
 * half a period.
 *
 * A heading that steps 359° → 1° has moved 2°, not -358°. Every downstream
 * consumer here — the least-squares gain, the cross-correlation lag, the RMS
 * error — reads that jump as a huge excursion, so headings must be unwrapped
 * before they are compared or resampled. The unwrap is only valid while the
 * true motion between samples stays under half a period; a yaw rate fast enough
 * to break that is indistinguishable from a wrap in the samples alone.
 *
 * Non-finite samples pass through and do not disturb the accumulated offset.
 */
export function unwrapAngle(values: ArrayLike<number>, period = 360): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  let offset = 0;
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = NaN;
      continue;
    }
    if (Number.isFinite(prev)) {
      // Round to the nearest whole period: a single step may cross more than
      // one wrap when the series is coarsely sampled.
      offset -= Math.round((v - prev) / period) * period;
    }
    prev = v;
    out[i] = v + offset;
  }
  return out;
}

/**
 * Re-express `b` on `a`'s branch, so the pair can never drift apart by whole
 * turns.
 *
 * Unwrapping two heading series separately is not enough to compare them. A
 * commanded bearing steps discontinuously when the next waypoint is selected,
 * and a jump larger than half a period is indistinguishable from a wrap, so the
 * unwrap silently absorbs it as a turn the vehicle never made. Each such event
 * offsets one series against the other for the rest of the log — on an hour of a
 * boat's telemetry that accumulated to a reported bias of about -1090°, for a
 * pair whose true error stayed within a few degrees.
 *
 * Choosing b's branch per sample so that b - a lands within half a period fixes
 * that: the difference is then the true error whatever either series has
 * accumulated. The remaining ambiguity is real rather than introduced — an error
 * genuinely beyond half a turn cannot be told from its complement.
 */
export function alignAngles(a: ArrayLike<number>, b: ArrayLike<number>, period = 360): Float64Array {
  const n = Math.min(a.length, b.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = b[i] - a[i];
    out[i] = Number.isFinite(d) ? a[i] + (d - Math.round(d / period) * period) : NaN;
  }
  return out;
}

/** Median spacing of `time` over [start, end), or NaN with fewer than 2 samples. */
export function medianStep(time: ArrayLike<number>, start = 0, end = time.length): number {
  const count = end - start - 1;
  if (count < 1) return NaN;
  const d = new Float64Array(count);
  for (let i = 0; i < count; i++) d[i] = time[start + i + 1] - time[start + i];
  d.sort();
  const mid = count >> 1;
  return count % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
}

export interface UniformSeries {
  /** Uniform timestamps, microseconds. */
  times: Float64Array;
  /** Values interpolated onto `times`. */
  values: Float64Array;
  /** Grid spacing, seconds. */
  dtSec: number;
  /** Non-finite entries in `values`; a spectrum must refuse to run on these. */
  nanCount: number;
  /** Source samples in the window that fell outside the run actually used. */
  droppedSamples: number;
}

/**
 * Resample a window onto an evenly-spaced grid, restricted to its longest
 * gap-free run.
 *
 * An FFT reads its input as evenly spaced whether or not it is, so a dropped
 * telemetry second silently becomes a frequency error. Rather than stretch
 * across such a gap, this finds the longest run whose spacing stays within
 * `gapFactor` of the median and grids only that, reporting how many samples
 * were left out so the caller can say so.
 *
 * Note that linear interpolation is not spectrally neutral — it attenuates the
 * high end roughly as sinc² — so a spectrum built this way understates energy
 * near Nyquist. It is honest for the low-frequency content that motivates it
 * (a vehicle hunting on its heading) and not a substitute for a genuinely
 * uniform high-rate source.
 */
export function toUniform(
  time: Float64Array,
  values: Float64Array,
  start = 0,
  end = time.length,
  gapFactor = 3,
): UniformSeries | null {
  if (end - start < 4) return null;
  const step = medianStep(time, start, end);
  if (!(step > 0)) return null;

  // Longest run of samples whose spacing stays within gapFactor of the median.
  const gapLimit = step * gapFactor;
  let bestA = start;
  let bestB = start + 1;
  let a = start;
  for (let i = start + 1; i <= end; i++) {
    if (i === end || time[i] - time[i - 1] > gapLimit) {
      if (i - a > bestB - bestA) {
        bestA = a;
        bestB = i;
      }
      a = i;
    }
  }
  if (bestB - bestA < 4) return null;

  const t0 = time[bestA];
  const t1 = time[bestB - 1];
  const count = Math.floor((t1 - t0) / step) + 1;
  if (count < 4) return null;
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) times[i] = t0 + i * step;
  const out = resampleLinear(time.subarray(bestA, bestB), values.subarray(bestA, bestB), times);
  let nanCount = 0;
  for (let i = 0; i < count; i++) if (!Number.isFinite(out[i])) nanCount++;
  return {
    times,
    values: out,
    dtSec: step / 1e6,
    nanCount,
    droppedSamples: end - start - (bestB - bestA),
  };
}

/**
 * Remove the mean and the least-squares linear trend.
 *
 * A drifting signal is a step at the window edges as far as a periodogram is
 * concerned, and that step leaks across every bin. Removing the ramp first
 * keeps the leakage from burying the peaks the module exists to show.
 * Non-finite samples are excluded from the fit and pass through untouched.
 */
export function detrend(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  let count = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(values[i])) continue;
    count++;
    mx += i;
    my += values[i];
  }
  if (count === 0) {
    out.fill(NaN);
    return out;
  }
  mx /= count;
  my /= count;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(values[i])) continue;
    sxx += (i - mx) * (i - mx);
    sxy += (i - mx) * (values[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  for (let i = 0; i < n; i++) {
    out[i] = Number.isFinite(values[i]) ? values[i] - (my + slope * (i - mx)) : NaN;
  }
  return out;
}
