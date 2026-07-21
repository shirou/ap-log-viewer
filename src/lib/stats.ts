// Windowed statistics over the columnar log model. Pure and dependency-free;
// every reducer skips non-finite samples, matching the gap convention the plot
// code already uses (NaN marks "no sample here").

export interface ColumnStats {
  /** Finite samples actually counted. */
  count: number;
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation (n-1). 0 when count < 2. */
  std: number;
  /** Root mean square. */
  rms: number;
  /** Coefficient of variation, std/|mean|. NaN when mean is 0. */
  cv: number;
}

/**
 * Stats over v[start..end), skipping non-finite samples; null when none finite.
 *
 * Mean and variance use Welford's recurrence rather than the Σx / Σx² identity:
 * log fields like altitude or battery voltage carry a large offset, and the
 * naive identity subtracts two big nearly-equal numbers and loses the variance
 * in rounding. RMS keeps its own Σx² since that sum does not cancel.
 */
export function columnStats(v: ArrayLike<number>, start = 0, end = v.length): ColumnStats | null {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) continue;
    count++;
    const delta = x - mean;
    mean += delta / count;
    m2 += delta * (x - mean);
    sumSq += x * x;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (count === 0) return null;
  const std = count > 1 ? Math.sqrt(Math.max(0, m2 / (count - 1))) : 0;
  const rms = Math.sqrt(sumSq / count);
  const cv = mean !== 0 ? std / Math.abs(mean) : NaN;
  return { count, mean, min, max, std, rms, cv };
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Pearson correlation of x and y. NaN when either is constant or < 2 pairs. */
  r: number;
  /** Finite (x, y) pairs used. */
  count: number;
}

/**
 * Least-squares line y = slope·x + intercept plus the correlation r.
 *
 * Pairs where either coordinate is non-finite are skipped, so a resampled column
 * padded with NaN outside its source range does not poison the fit.
 */
export function linearFit(xs: ArrayLike<number>, ys: ArrayLike<number>): LinearFit {
  const n = Math.min(xs.length, ys.length);
  let count = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    count++;
    mx += x;
    my += y;
  }
  if (count < 2) return { slope: NaN, intercept: NaN, r: NaN, count };
  mx /= count;
  my /= count;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : NaN;
  const intercept = Number.isFinite(slope) ? my - slope * mx : NaN;
  const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  return { slope, intercept, r, count };
}

/** Pearson correlation of two columns, skipping non-finite pairs. */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return linearFit(a, b).r;
}
