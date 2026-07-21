import { describe, expect, it } from 'vitest';
import { fitCircle } from './circleFit.ts';

// Deterministic RNG so the noisy-circle case never flakes.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample a circle over [a0, a1] radians into parallel x/y arrays.
function circle(cx: number, cy: number, R: number, n: number, a0 = 0, a1 = 2 * Math.PI) {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    x[i] = cx + R * Math.cos(a);
    y[i] = cy + R * Math.sin(a);
  }
  return { x, y };
}

describe('fitCircle', () => {
  it('recovers an off-center circle exactly', () => {
    // Off-center on purpose: a lost ½ factor in the solve doubles the center and
    // only shows up when cx,cy are non-zero.
    const { x, y } = circle(120, -45, 300, 64);
    const f = fitCircle(x, y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const d = Math.hypot(120, 45);
    expect(f.cx).toBeCloseTo(120, 6);
    expect(f.cy).toBeCloseTo(-45, 6);
    expect(f.R).toBeCloseTo(300, 6);
    expect(f.d).toBeCloseTo(d, 6);
    expect(f.dOverR).toBeCloseTo(d / 300, 6);
    expect(f.headingErrorDeg).toBeCloseTo((Math.asin(d / 300) * 180) / Math.PI, 6);
    expect(f.radialStddev).toBeCloseTo(0, 6);
    expect(f.arcCoverageDeg).toBeGreaterThan(350);
    expect(f.sampleCount).toBe(64);
  });

  it('recovers a noisy circle within tolerance', () => {
    const rng = mulberry32(42);
    const { x, y } = circle(-200, 80, 450, 400);
    for (let i = 0; i < x.length; i++) {
      x[i] += (rng() - 0.5) * 10;
      y[i] += (rng() - 0.5) * 10;
    }
    const f = fitCircle(x, y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(Math.abs(f.cx + 200)).toBeLessThan(3);
    expect(Math.abs(f.cy - 80)).toBeLessThan(3);
    expect(Math.abs(f.R - 450)).toBeLessThan(3);
    expect(f.radialStddev).toBeGreaterThan(0);
  });

  it('fits a 200-degree partial arc and reports its coverage', () => {
    const { x, y } = circle(50, 50, 100, 128, 0, (200 * Math.PI) / 180);
    const f = fitCircle(x, y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.cx).toBeCloseTo(50, 3);
    expect(f.cy).toBeCloseTo(50, 3);
    expect(f.R).toBeCloseTo(100, 3);
    expect(f.arcCoverageDeg).toBeCloseTo(200, 0);
  });

  it('honours the index range and skips NaN', () => {
    const { x, y } = circle(10, -10, 60, 40);
    const px = new Float64Array([999, 999, ...x, 999]);
    const py = new Float64Array([999, 999, ...y, 999]);
    px[10] = NaN; // one bad pair inside the window
    const f = fitCircle(px, py, 2, 2 + x.length);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.cx).toBeCloseTo(10, 4);
    expect(f.cy).toBeCloseTo(-10, 4);
    expect(f.sampleCount).toBe(x.length - 1);
  });

  it('reports typed failures rather than NaN', () => {
    expect(fitCircle(new Float64Array([1, 2]), new Float64Array([1, 2]))).toMatchObject({
      ok: false,
      reason: 'too-few-samples',
    });
    // Collinear, large scale: the relative guard must still catch it.
    const line = new Float64Array([1000, 2000, 3000, 4000, 5000]);
    expect(fitCircle(line, line)).toMatchObject({ ok: false, reason: 'degenerate' });
    // Small-scale genuine circle must NOT be misflagged as degenerate.
    const tiny = circle(0.01, -0.02, 0.5, 40);
    expect(fitCircle(tiny.x, tiny.y).ok).toBe(true);
  });
});
