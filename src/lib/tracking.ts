// How well an achieved signal follows the one that was commanded.
//
// Both inputs must already sit on a shared uniform grid (see signal.toUniform):
// the lag estimate counts samples, so it is only a time if the samples are
// evenly spaced and the two series share the same spacing.

export interface TrackingMetrics {
  /** Finite (desired, achieved) pairs used for the error metrics. */
  count: number;
  /** Mean of achieved - desired: a standing offset the loop never removes. */
  bias: number;
  rmsError: number;
  /**
   * Least-squares slope of achieved against desired, measured at `lagSec`.
   * 1 = full authority. Taken at the lag rather than unshifted: a loop that
   * eventually delivers all of a demand but arrives late is not a loop with low
   * gain, and reading the slope off the unshifted pair would call it one.
   */
  gain: number;
  /** Correlation at `lagSec`. Low values mean neither gain nor lag is meaningful. */
  r: number;
  /** Seconds the achieved signal trails the desired one. Negative = leads. */
  lagSec: number;
  /** Bound the lag search actually used. A lag at the bound is not resolved. */
  maxLagSec: number;
  /** Grid spacing, i.e. the resolution the lag was interpolated within. */
  dtSec: number;
}

interface ShiftedFit {
  /** Correlation of the pair at this shift. */
  r: number;
  /** Least-squares slope of act against des at this shift. */
  slope: number;
  count: number;
}

/**
 * Correlation and slope of `des[i]` against `act[i + k]` over their overlap.
 *
 * Recomputed per shift rather than normalized once globally: the overlap
 * shrinks as |k| grows, and reusing the full-series means would let a signal
 * with a trend score better simply for being cut shorter.
 */
function shiftedFit(des: ArrayLike<number>, act: ArrayLike<number>, n: number, k: number): ShiftedFit {
  const none = { r: NaN, slope: NaN, count: 0 };
  const from = Math.max(0, -k);
  const to = Math.min(n, n - k);
  if (to - from < 3) return none;
  let count = 0;
  let mx = 0;
  let my = 0;
  for (let i = from; i < to; i++) {
    const x = des[i];
    const y = act[i + k];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    count++;
    mx += x;
    my += y;
  }
  if (count < 3) return none;
  mx /= count;
  my /= count;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = from; i < to; i++) {
    const x = des[i];
    const y = act[i + k];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sxx += (x - mx) * (x - mx);
    syy += (y - my) * (y - my);
    sxy += (x - mx) * (y - my);
  }
  if (!(sxx > 0)) return none;
  return { r: syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN, slope: sxy / sxx, count };
}

/**
 * Tracking quality of `act` against `des`, both on the same uniform grid.
 *
 * The headline number is `lagSec`, from the peak of the normalized
 * cross-correlation refined by a parabola through its neighbours — not a phase
 * angle. A single phase only means something at a single frequency, and a
 * maneuver spans a band, so a degree figure would read as precision the data
 * does not carry. Seconds of delay stay true across the whole band.
 *
 * The lag of a *steadily oscillating* window is only unique up to one period of
 * the oscillation, since every whole-period shift correlates equally well; a
 * window containing a maneuver rather than a limit cycle does not have this
 * ambiguity. `lagCorr` cannot distinguish the two — it is high in both.
 *
 * Returns null for a window too short to shift meaningfully.
 */
export function trackingMetrics(
  des: ArrayLike<number>,
  act: ArrayLike<number>,
  dtSec: number,
  maxLagSec?: number,
): TrackingMetrics | null {
  const n = Math.min(des.length, act.length);
  if (n < 8 || !(dtSec > 0)) return null;

  let count = 0;
  let sumErr = 0;
  let sumSqErr = 0;
  for (let i = 0; i < n; i++) {
    const d = des[i];
    const a = act[i];
    if (!Number.isFinite(d) || !Number.isFinite(a)) continue;
    count++;
    sumErr += a - d;
    sumSqErr += (a - d) * (a - d);
  }
  if (count < 3) return null;

  // Never search past a quarter of the window: beyond that the overlap is too
  // short for the correlation to mean anything.
  const limitSec = (n * dtSec) / 4;
  // The default reach has to cover the slowest loop a log might hold, not the
  // fastest. A multirotor rate loop answers in tens of milliseconds, but a boat
  // or rover swinging onto a new heading takes seconds, and a search that stops
  // at two of them reports the bound back as though it were the measurement.
  const wantSec = maxLagSec === undefined ? Math.min(10, limitSec) : Math.min(maxLagSec, limitSec);
  // Each shift costs a pass over the window, so the shift count has to fall as
  // the window grows or a long high-rate selection stalls the UI. The budget
  // still leaves a rate loop's worth of lag searchable at any realistic rate.
  const budget = Math.max(8, Math.min(400, Math.floor(4e6 / n)));
  const maxK = Math.max(1, Math.min(budget, Math.round(wantSec / dtSec)));

  let bestK = 0;
  let best: ShiftedFit | null = null;
  const corr = new Map<number, number>();
  for (let k = -maxK; k <= maxK; k++) {
    const fit = shiftedFit(des, act, n, k);
    corr.set(k, fit.r);
    if (Number.isFinite(fit.r) && (best === null || fit.r > best.r)) {
      best = fit;
      bestK = k;
    }
  }
  if (!best) return null;
  const bestC = best.r;

  // Sub-sample refinement: fit a parabola through the peak and its neighbours.
  let refined = bestK;
  const cm = corr.get(bestK - 1);
  const cp = corr.get(bestK + 1);
  if (cm !== undefined && cp !== undefined && Number.isFinite(cm) && Number.isFinite(cp)) {
    const denom = cm - 2 * bestC + cp;
    if (denom !== 0) {
      const delta = (0.5 * (cm - cp)) / denom;
      if (Math.abs(delta) <= 1) refined = bestK + delta;
    }
  }

  return {
    count,
    // Error and bias stay unshifted on purpose: they are what the vehicle
    // actually did at each instant, and a delay is part of that error.
    bias: sumErr / count,
    rmsError: Math.sqrt(sumSqErr / count),
    gain: best.slope,
    r: bestC,
    lagSec: refined * dtSec,
    maxLagSec: maxK * dtSec,
    dtSec,
  };
}

export interface StepMetrics {
  /** Seconds from the window start to the commanded step. */
  stepTimeSec: number;
  /** Commanded change, in the signal's own units. */
  amplitude: number;
  /** Seconds from the step until the response first reaches 10% of amplitude. */
  delaySec: number | null;
  /** 10% -> 90% of the commanded amplitude. */
  riseTimeSec: number | null;
  /** Peak excursion past the commanded level, as a percentage of amplitude. */
  overshootPct: number | null;
  /** Seconds from the step until the response stays within 5% of amplitude. */
  settlingTimeSec: number | null;
  /** Achieved minus commanded once settled, in the signal's own units. */
  steadyStateError: number;
}

function median(v: number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function finiteSlice(v: ArrayLike<number>, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) if (Number.isFinite(v[i])) out.push(v[i]);
  return out;
}

/** Time of the first crossing of `level` after `from`, linearly interpolated. */
function crossingTime(v: ArrayLike<number>, from: number, n: number, level: number, rising: boolean, dtSec: number): number | null {
  for (let i = from; i < n; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) continue;
    if (rising ? x >= level : x <= level) {
      const prev = i > from ? v[i - 1] : NaN;
      if (i > from && Number.isFinite(prev) && x !== prev) {
        return (i - 1 + (level - prev) / (x - prev)) * dtSec;
      }
      return i * dtSec;
    }
  }
  return null;
}

/**
 * Step-response metrics for a window that actually contains a step.
 *
 * Gated deliberately: run over an arbitrary window, a largest-jump search will
 * always find *something*, and reporting a rise time for what was really sensor
 * noise is worse than reporting nothing. The command must jump by several times
 * its own sample-to-sample noise (robust MAD estimate) and that jump must
 * account for a good share of the window's total command range — a ramp or a
 * wander fails both. Returns null when the window holds no step.
 *
 * There is deliberately no time constant here: fitting one asserts a first-order
 * system, and a tuned vehicle loop is not one. Rise, overshoot and settling
 * describe the response without claiming a model for it.
 */
export function stepMetrics(
  des: ArrayLike<number>,
  act: ArrayLike<number>,
  dtSec: number,
  snrFactor = 5,
): StepMetrics | null {
  const n = Math.min(des.length, act.length);
  if (n < 12 || !(dtSec > 0)) return null;

  const diffs: number[] = [];
  let stepIdx = -1;
  let maxJump = 0;
  for (let i = 1; i < n; i++) {
    const a = des[i - 1];
    const b = des[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = Math.abs(b - a);
    diffs.push(d);
    if (d > maxJump) {
      maxJump = d;
      stepIdx = i - 1;
    }
  }
  if (stepIdx < 0 || maxJump <= 0) return null;

  // Scanned rather than spread: Math.max(...window) puts every sample on the
  // call stack, which throws outright once a window runs to a few hundred
  // thousand samples — exactly what a high-rate .bin selection is.
  let count = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = des[i];
    if (!Number.isFinite(v)) continue;
    count++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (count < 12) return null;
  const range = hi - lo;
  // 1.4826·MAD estimates σ of the sample-to-sample noise without letting the
  // step itself — the one huge value — inflate the estimate the way a plain σ
  // would.
  const noise = 1.4826 * median(diffs);
  if (noise > 0 && maxJump < snrFactor * noise) return null;
  // A single jump that is only a small part of the total travel means the
  // command ramped or wandered rather than stepped.
  if (!(range > 0) || maxJump < 0.3 * range) return null;

  const before = stepIdx + 1;
  const after = n - before;
  if (before < 5 || after < 5) return null;

  const desBefore = median(finiteSlice(des, 0, before));
  const desAfter = median(finiteSlice(des, before, n));
  const amplitude = desAfter - desBefore;
  if (!Number.isFinite(amplitude) || amplitude === 0) return null;

  const baseline = median(finiteSlice(act, 0, before));
  if (!Number.isFinite(baseline)) return null;

  const stepTimeSec = before * dtSec;
  const rising = amplitude > 0;
  const at = (frac: number) => baseline + frac * amplitude;
  const t10 = crossingTime(act, before, n, at(0.1), rising, dtSec);
  const t90 = crossingTime(act, before, n, at(0.9), rising, dtSec);

  // Peak excursion past the commanded level, normalized so a negative step
  // reads the same way as a positive one.
  let peak = -Infinity;
  for (let i = before; i < n; i++) {
    if (!Number.isFinite(act[i])) continue;
    const norm = (act[i] - baseline) / amplitude;
    if (norm > peak) peak = norm;
  }
  const overshootPct = Number.isFinite(peak) ? Math.max(0, (peak - 1) * 100) : null;

  // Settling: the last moment it was outside the 5% band, so a late excursion
  // counts rather than being hidden by an earlier entry into the band.
  let lastOutside = -1;
  for (let i = before; i < n; i++) {
    if (!Number.isFinite(act[i])) continue;
    if (Math.abs((act[i] - baseline) / amplitude - 1) > 0.05) lastOutside = i;
  }
  const settlingTimeSec = lastOutside < 0 ? 0 : lastOutside + 1 < n ? (lastOutside + 1) * dtSec - stepTimeSec : null;

  const tailFrom = Math.max(before, n - Math.max(3, Math.round(after * 0.1)));
  const tail = finiteSlice(act, tailFrom, n);
  const steadyStateError = tail.length ? tail.reduce((s, x) => s + x, 0) / tail.length - (baseline + amplitude) : NaN;

  return {
    stepTimeSec,
    amplitude,
    delaySec: t10 === null ? null : t10 - stepTimeSec,
    riseTimeSec: t10 === null || t90 === null ? null : t90 - t10,
    overshootPct,
    settlingTimeSec,
    steadyStateError,
  };
}
