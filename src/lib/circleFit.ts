// Algebraic circle fit for magnetometer hard-iron diagnostics.
//
// A magnetometer swept through a horizontal rotation traces a circle in x-y; its
// center is the residual hard-iron offset (what the current COMPASS_OFS did not
// remove). We fit with the Taubin method rather than Kåsa: both are direct (one
// pass of moments, no external dependency), but Taubin is far less biased when
// the rotation covers only a partial arc — the common case for a boat or rover
// that never completes a full turn. Ref: G. Taubin, IEEE PAMI 1991; and
// N. Chernov's circle-fit notes, whose moment formulation this follows.
//
// The fit is in the raw sensor x-y plane: it assumes rotation about a roughly
// vertical axis with the sensor near level, does not undo COMPASS_ORIENT/board
// rotation, and cannot separate the z offset. It is a diagnostic, not a drop-in
// replacement for the vehicle's own 3D calibration.

export interface CircleFit {
  ok: true;
  /** Circle center = residual hard-iron offset, in the input's units. */
  cx: number;
  cy: number;
  R: number;
  /** hypot(cx, cy): residual offset magnitude. */
  d: number;
  dOverR: number;
  /** Worst-case heading error from the offset: asin(min(1, d/R)) in degrees. */
  headingErrorDeg: number;
  /** Population stddev of per-sample radius: circle non-uniformity (soft iron). */
  radialStddev: number;
  /** Angular span the samples cover around the center, degrees (360 = full turn). */
  arcCoverageDeg: number;
  sampleCount: number;
}

export interface CircleFitFailure {
  ok: false;
  reason: 'too-few-samples' | 'degenerate';
  sampleCount: number;
}

export type CircleFitResult = CircleFit | CircleFitFailure;

const MIN_SAMPLES = 3;
const RAD2DEG = 180 / Math.PI;

/**
 * Taubin circle fit over x[start..end)/y[start..end). Non-finite pairs skipped.
 *
 * Returns a typed failure rather than NaN when there are too few points or the
 * cloud is collinear/degenerate.
 */
export function fitCircle(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  start = 0,
  end = x.length,
): CircleFitResult {
  // Pass 1: centroid over finite pairs.
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = start; i < end; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    n++;
    sx += xi;
    sy += yi;
  }
  if (n < MIN_SAMPLES) return { ok: false, reason: 'too-few-samples', sampleCount: n };
  const mx = sx / n;
  const my = sy / n;

  // Pass 2: RMS radius, used to scale the cloud to unit size. Magnetometer
  // values span mGauss to raw counts depending on the source, and normalizing
  // keeps the moments and the degeneracy test O(1) regardless of that scale.
  let sumR2 = 0;
  for (let i = start; i < end; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    const u = xi - mx;
    const v = yi - my;
    sumR2 += u * u + v * v;
  }
  const s = Math.sqrt(sumR2 / n);
  if (!(s > 0)) return { ok: false, reason: 'degenerate', sampleCount: n };

  // Pass 3: Taubin moments on centered + unit-scaled coordinates.
  let Mxx = 0;
  let Myy = 0;
  let Mxy = 0;
  let Mxz = 0;
  let Myz = 0;
  let Mz = 0;
  let Mzz = 0;
  for (let i = start; i < end; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    const u = (xi - mx) / s;
    const v = (yi - my) / s;
    const z = u * u + v * v;
    Mxx += u * u;
    Myy += v * v;
    Mxy += u * v;
    Mxz += u * z;
    Myz += v * z;
    Mz += z;
    Mzz += z * z;
  }
  Mxx /= n;
  Myy /= n;
  Mxy /= n;
  Mxz /= n;
  Myz /= n;
  Mz /= n;
  Mzz /= n;

  const covXy = Mxx * Myy - Mxy * Mxy;
  // On unit-scaled data covXy is O(1) for a real circle and → 0 for a line, so
  // this absolute threshold is effectively scale-free.
  if (!(covXy > 1e-10)) return { ok: false, reason: 'degenerate', sampleCount: n };

  const varZ = Mzz - Mz * Mz;
  const a3 = 4 * Mz;
  const a2 = -3 * Mz * Mz - Mzz;
  const a1 = varZ * Mz + 4 * covXy * Mz - Mxz * Mxz - Myz * Myz;
  const a0 = Mxz * (Mxz * Myy - Myz * Mxy) + Myz * (Myz * Mxx - Mxz * Mxy) - varZ * covXy;
  const a22 = a2 + a2;
  const a33 = a3 + a3 + a3;

  // Newton root of the characteristic cubic, started at 0.
  let root = 0;
  let value = a0;
  for (let iter = 0; iter < 99; iter++) {
    const slope = a1 + root * (a22 + a33 * root);
    const next = root - value / slope;
    if (!Number.isFinite(next) || next === root) break;
    const nextValue = a0 + next * (a1 + next * (a2 + next * a3));
    if (Math.abs(nextValue) >= Math.abs(value)) break;
    root = next;
    value = nextValue;
  }

  const det = 2 * (root * root - root * Mz + covXy);
  if (!(Math.abs(det) > 1e-12)) return { ok: false, reason: 'degenerate', sampleCount: n };
  const cxScaled = (Mxz * (Myy - root) - Myz * Mxy) / det;
  const cyScaled = (Myz * (Mxx - root) - Mxz * Mxy) / det;
  const rScaled = Math.sqrt(cxScaled * cxScaled + cyScaled * cyScaled + Mz);

  // Undo the centering + scaling to recover input units.
  const cx = cxScaled * s + mx;
  const cy = cyScaled * s + my;
  const R = rScaled * s;
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(R > 0)) {
    return { ok: false, reason: 'degenerate', sampleCount: n };
  }

  // Pass 4: radial spread and angular coverage about the fitted center.
  let sumR = 0;
  let sumRSq = 0;
  const angles: number[] = [];
  for (let i = start; i < end; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    const dx = xi - cx;
    const dy = yi - cy;
    const r = Math.hypot(dx, dy);
    sumR += r;
    sumRSq += r * r;
    angles.push(Math.atan2(dy, dx));
  }
  const rMean = sumR / n;
  const radialStddev = Math.sqrt(Math.max(0, sumRSq / n - rMean * rMean));

  const d = Math.hypot(cx, cy);
  const dOverR = d / R;
  return {
    ok: true,
    cx,
    cy,
    R,
    d,
    dOverR,
    headingErrorDeg: Math.asin(Math.min(1, dOverR)) * RAD2DEG,
    radialStddev,
    arcCoverageDeg: angularCoverage(angles),
    sampleCount: n,
  };
}

/** Degrees of arc the angles span: 360 minus the largest empty gap between them. */
function angularCoverage(angles: number[]): number {
  if (angles.length < 2) return 0;
  const sorted = angles.slice().sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > maxGap) maxGap = gap;
  }
  // Wrap-around gap between the last and first angle, through ±π.
  const wrap = sorted[0] + 2 * Math.PI - sorted[sorted.length - 1];
  if (wrap > maxGap) maxGap = wrap;
  return (2 * Math.PI - maxGap) * RAD2DEG;
}
