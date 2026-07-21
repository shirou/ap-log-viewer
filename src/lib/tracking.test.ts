import { describe, expect, it } from 'vitest';
import { stepMetrics, trackingMetrics } from './tracking.ts';

/** Deterministic pseudo-random noise so the gate tests do not flake. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

function chirp(n: number, dt: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    out[i] = Math.sin(2 * Math.PI * (0.5 + 0.05 * t) * t);
  }
  return out;
}

/** `src` delayed by `shift` samples; the head repeats the first value. */
function delay(src: Float64Array, shift: number): Float64Array {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[Math.max(0, i - shift)];
  return out;
}

describe('trackingMetrics', () => {
  it('recovers a whole-sample delay', () => {
    const dt = 0.01;
    const des = chirp(1000, dt);
    const m = trackingMetrics(des, delay(des, 7), dt)!;
    expect(m.lagSec).toBeCloseTo(7 * dt, 3);
    expect(m.r).toBeGreaterThan(0.9);
  });

  it('resolves a delay finer than one sample by interpolation', () => {
    // A chirp, so the correlation has one unmistakable peak, sampled twice with
    // a 3.4-sample offset between the two.
    const dt = 0.01;
    const n = 1000;
    const shift = 3.4;
    const at = (t: number) => Math.sin(2 * Math.PI * (0.5 + 0.05 * t) * t);
    const des = new Float64Array(n);
    const act = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      des[i] = at(i * dt);
      act[i] = at((i - shift) * dt);
    }
    const m = trackingMetrics(des, act, dt)!;
    expect(m.lagSec).toBeCloseTo(shift * dt, 3);
  });

  // A steady oscillation correlates just as well at every whole period, so the
  // lag it reports is only unique up to that period.
  it('is ambiguous by one period on a purely periodic signal', () => {
    const dt = 0.01;
    const n = 1000;
    const period = 1 / 3;
    const des = new Float64Array(n);
    const act = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      des[i] = Math.sin(2 * Math.PI * 3 * i * dt);
      act[i] = Math.sin(2 * Math.PI * 3 * (i - 3.4) * dt);
    }
    const m = trackingMetrics(des, act, dt)!;
    const residual = ((m.lagSec - 3.4 * dt) % period + period) % period;
    expect(Math.min(residual, period - residual)).toBeLessThan(0.01);
    expect(m.r).toBeGreaterThan(0.99);
  });

  it('reports a negative lag when the response leads', () => {
    const dt = 0.02;
    const des = chirp(600, dt);
    const m = trackingMetrics(delay(des, 5), des, dt)!;
    expect(m.lagSec).toBeCloseTo(-5 * dt, 2);
  });

  it('recovers the gain of an under-responding loop', () => {
    const dt = 0.01;
    const des = chirp(800, dt);
    const act = Float64Array.from(des, (v) => 0.6 * v);
    const m = trackingMetrics(des, act, dt)!;
    expect(m.gain).toBeCloseTo(0.6, 6);
    expect(m.r).toBeCloseTo(1, 6);
    expect(m.lagSec).toBeCloseTo(0, 6);
  });

  // The reason gain is taken at the lag: a loop that delivers all of the demand
  // but arrives late is not a low-gain loop, though the unshifted slope says so.
  it('recovers gain from a response that is both delayed and attenuated', () => {
    const dt = 0.01;
    const des = chirp(1000, dt);
    const act = Float64Array.from(delay(des, 6), (v) => 0.75 * v);
    const m = trackingMetrics(des, act, dt)!;
    expect(m.lagSec).toBeCloseTo(6 * dt, 3);
    expect(m.gain).toBeCloseTo(0.75, 2);
    expect(m.r).toBeGreaterThan(0.95);
  });

  it('reports bias and RMS error in signal units', () => {
    const dt = 0.05;
    const des = chirp(400, dt);
    const act = Float64Array.from(des, (v) => v + 2);
    const m = trackingMetrics(des, act, dt)!;
    expect(m.bias).toBeCloseTo(2, 9);
    expect(m.rmsError).toBeCloseTo(2, 9);
  });

  it('skips NaN pairs rather than poisoning the metrics', () => {
    const dt = 0.01;
    const des = chirp(400, dt);
    const act = Float64Array.from(des);
    act[10] = NaN;
    act[11] = NaN;
    const m = trackingMetrics(des, act, dt)!;
    expect(m.count).toBe(398);
    expect(m.gain).toBeCloseTo(1, 6);
  });

  it('never searches past a quarter of the window', () => {
    const dt = 0.1;
    const des = chirp(40, dt);
    const m = trackingMetrics(des, des, dt, 999)!;
    expect(m.maxLagSec).toBeLessThanOrEqual((40 * dt) / 4 + dt);
  });

  it('returns null for a window too short to shift', () => {
    expect(trackingMetrics(new Float64Array(4), new Float64Array(4), 0.01)).toBeNull();
    expect(trackingMetrics(new Float64Array(40), new Float64Array(40), 0)).toBeNull();
  });
});

/** First-order response to a unit step at index `at`, τ in samples. */
function firstOrderStep(n: number, at: number, amp: number, tau: number, base = 0): { des: Float64Array; act: Float64Array } {
  const des = new Float64Array(n);
  const act = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    des[i] = base + (i >= at ? amp : 0);
    act[i] = base + (i >= at ? amp * (1 - Math.exp(-(i - at) / tau)) : 0);
  }
  return { des, act };
}

describe('stepMetrics', () => {
  it('measures rise time on a first-order response', () => {
    const dt = 0.01;
    const tau = 20;
    const { des, act } = firstOrderStep(400, 100, 1, tau);
    const m = stepMetrics(des, act, dt)!;
    expect(m.stepTimeSec).toBeCloseTo(100 * dt, 6);
    expect(m.amplitude).toBeCloseTo(1, 6);
    // 10%->90% of a first-order lag is ln(9)·τ.
    expect(m.riseTimeSec).toBeCloseTo(Math.log(9) * tau * dt, 2);
    expect(m.overshootPct).toBeCloseTo(0, 1);
    expect(m.steadyStateError).toBeCloseTo(0, 3);
  });

  it('handles a negative step the same way', () => {
    const dt = 0.01;
    const tau = 15;
    const { des, act } = firstOrderStep(400, 100, -2, tau, 5);
    const m = stepMetrics(des, act, dt)!;
    expect(m.amplitude).toBeCloseTo(-2, 6);
    expect(m.riseTimeSec).toBeCloseTo(Math.log(9) * tau * dt, 2);
    expect(m.overshootPct).toBeCloseTo(0, 1);
  });

  it('reports overshoot and settling for a ringing response', () => {
    const dt = 0.01;
    const n = 600;
    const at = 100;
    const des = new Float64Array(n);
    const act = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      des[i] = i >= at ? 1 : 0;
      if (i < at) act[i] = 0;
      else {
        const t = (i - at) * dt;
        act[i] = 1 - Math.exp(-3 * t) * Math.cos(12 * t);
      }
    }
    const m = stepMetrics(des, act, dt)!;
    expect(m.overshootPct!).toBeGreaterThan(10);
    expect(m.settlingTimeSec!).toBeGreaterThan(0);
    expect(m.settlingTimeSec!).toBeLessThan(n * dt);
  });

  it('reports the steady-state error a proportional loop leaves', () => {
    const dt = 0.01;
    const { des, act } = firstOrderStep(400, 100, 1, 10);
    // Response settles 8% short of the command.
    for (let i = 100; i < 400; i++) act[i] *= 0.92;
    const m = stepMetrics(des, act, dt)!;
    expect(m.steadyStateError).toBeCloseTo(-0.08, 2);
  });

  it('returns null for a noise-only window', () => {
    const r = rng(7);
    const n = 400;
    const des = new Float64Array(n);
    const act = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      des[i] = r() * 0.02;
      act[i] = r() * 0.02;
    }
    expect(stepMetrics(des, act, 0.01)).toBeNull();
  });

  it('returns null for a ramp — a big total change but no single step', () => {
    const n = 400;
    const des = new Float64Array(n);
    const act = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      des[i] = i / n;
      act[i] = i / n;
    }
    expect(stepMetrics(des, act, 0.01)).toBeNull();
  });

  it('survives noise riding on a real step', () => {
    const r = rng(11);
    const dt = 0.01;
    const { des, act } = firstOrderStep(400, 100, 1, 20);
    for (let i = 0; i < 400; i++) {
      des[i] += r() * 0.004;
      act[i] += r() * 0.004;
    }
    const m = stepMetrics(des, act, dt);
    expect(m).not.toBeNull();
    expect(m!.amplitude).toBeCloseTo(1, 1);
  });

  it('returns null when the step leaves too little room to respond', () => {
    const { des, act } = firstOrderStep(400, 397, 1, 20);
    expect(stepMetrics(des, act, 0.01)).toBeNull();
  });

  // A whole-log window of a 400 Hz .bin message reaches this size easily, and
  // anything that spreads the window into an argument list dies there.
  it('handles a window of several hundred thousand samples', () => {
    const n = 400_000;
    const { des, act } = firstOrderStep(n, n / 2, 1, 2000);
    const m = stepMetrics(des, act, 1 / 400);
    expect(m).not.toBeNull();
    expect(m!.amplitude).toBeCloseTo(1, 6);
  });
});

describe('trackingMetrics on large windows', () => {
  it('stays responsive by bounding the shift search as the window grows', () => {
    const dt = 1 / 400;
    const n = 200_000;
    const des = new Float64Array(n);
    for (let i = 0; i < n; i++) des[i] = Math.sin(2 * Math.PI * 1.5 * i * dt);
    const m = trackingMetrics(des, delay(des, 40), dt)!;
    // The budget caps the search well short of the 2 s default at this rate.
    expect(m.maxLagSec).toBeLessThan(2);
    expect(m.lagSec).toBeGreaterThan(0);
  });
});
