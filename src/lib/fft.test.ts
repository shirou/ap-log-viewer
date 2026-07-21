import { describe, expect, it } from 'vitest';
import { dominantPeak, fftRadix2, powerSpectrum } from './fft.ts';

/** A sine sampled at `fs` for `n` samples. */
function sine(n: number, fs: number, freq: number, amp: number, phase = 0): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * (i / fs) + phase);
  return out;
}

function variance(v: ArrayLike<number>): number {
  let mean = 0;
  for (let i = 0; i < v.length; i++) mean += v[i];
  mean /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] - mean) * (v[i] - mean);
  return s / v.length;
}

/** Σ psd·df — the total power the spectrum claims the signal carries. */
function totalPower(psd: ArrayLike<number>, df: number): number {
  let s = 0;
  for (let i = 0; i < psd.length; i++) s += psd[i];
  return s * df;
}

describe('fftRadix2', () => {
  it('transforms a constant into a single DC bin', () => {
    const re = new Float64Array([2, 2, 2, 2]);
    const im = new Float64Array(4);
    fftRadix2(re, im);
    expect(re[0]).toBeCloseTo(8, 10);
    for (let k = 1; k < 4; k++) {
      expect(Math.hypot(re[k], im[k])).toBeCloseTo(0, 10);
    }
  });

  it('matches a direct DFT on an arbitrary signal', () => {
    const n = 16;
    const src = new Float64Array(n);
    for (let i = 0; i < n; i++) src[i] = Math.sin(i) + 0.3 * i;
    const re = Float64Array.from(src);
    const im = new Float64Array(n);
    fftRadix2(re, im);
    for (let k = 0; k < n; k++) {
      let dRe = 0;
      let dIm = 0;
      for (let i = 0; i < n; i++) {
        const a = (-2 * Math.PI * k * i) / n;
        dRe += src[i] * Math.cos(a);
        dIm += src[i] * Math.sin(a);
      }
      expect(re[k]).toBeCloseTo(dRe, 8);
      expect(im[k]).toBeCloseTo(dIm, 8);
    }
  });

  it('rejects a non-power-of-two length', () => {
    expect(() => fftRadix2(new Float64Array(6), new Float64Array(6))).toThrow(/power-of-two/);
  });
});

describe('powerSpectrum', () => {
  it('puts the peak at the signal frequency', () => {
    const fs = 100;
    const s = powerSpectrum(sine(1024, fs, 12.5, 2), 1 / fs);
    expect(s).not.toBeNull();
    const peak = dominantPeak(s!);
    expect(peak!.freq).toBeCloseTo(12.5, 1);
    expect(s!.nyquist).toBeCloseTo(50, 10);
  });

  // The normalization is the whole point: Σ psd·df must recover the variance,
  // otherwise a peak's height is only comparable within one window.
  it('satisfies Parseval — total power equals the variance', () => {
    const fs = 100;
    const sig = sine(1024, fs, 12.5, 2);
    const s = powerSpectrum(sig, 1 / fs, { window: 'none' })!;
    expect(totalPower(s.psd, s.df)).toBeCloseTo(variance(sig), 6);
  });

  it('recovers the variance with a Hann window too', () => {
    const fs = 200;
    // Non-integer bin count, so the window is doing real work against leakage.
    const sig = sine(2048, fs, 17.3, 1.5);
    const s = powerSpectrum(sig, 1 / fs, { window: 'hann' })!;
    expect(totalPower(s.psd, s.df)).toBeCloseTo(variance(sig), 2);
  });

  it('keeps total power when zero-padding to the next power of two', () => {
    const fs = 100;
    const sig = sine(1500, fs, 10, 1);
    const padded = powerSpectrum(sig, 1 / fs, { window: 'none', zeroPad: true })!;
    const truncated = powerSpectrum(sig.subarray(0, 1024), 1 / fs, { window: 'none', zeroPad: false })!;
    expect(padded.sampleCount).toBe(1500);
    expect(truncated.sampleCount).toBe(1024);
    // Finer bins, same energy.
    expect(padded.df).toBeLessThan(truncated.df);
    expect(totalPower(padded.psd, padded.df)).toBeCloseTo(variance(sig), 4);
  });

  it('does not double DC or Nyquist', () => {
    const fs = 4;
    // Alternating ±1 is exactly the Nyquist frequency; its variance is 1.
    const sig = new Float64Array(64);
    for (let i = 0; i < 64; i++) sig[i] = i % 2 ? -1 : 1;
    const s = powerSpectrum(sig, 1 / fs, { window: 'none' })!;
    expect(totalPower(s.psd, s.df)).toBeCloseTo(1, 8);
    expect(s.freqs[s.freqs.length - 1]).toBeCloseTo(2, 10);
  });

  it('refuses non-finite samples and too-short windows', () => {
    const withNaN = new Float64Array([1, 2, NaN, 4, 5, 6, 7, 8]);
    expect(powerSpectrum(withNaN, 0.01)).toBeNull();
    expect(powerSpectrum(new Float64Array([1, 2, 3]), 0.01)).toBeNull();
    expect(powerSpectrum(new Float64Array(16), 0)).toBeNull();
  });
});

describe('dominantPeak', () => {
  it('finds the strongest line and honours a minimum frequency', () => {
    const fs = 100;
    // Strong 5 Hz plus a weaker 20 Hz, mean removed as callers must do.
    const sig = new Float64Array(1024);
    const a = sine(1024, fs, 5, 3);
    const b = sine(1024, fs, 20, 1);
    for (let i = 0; i < sig.length; i++) sig[i] = a[i] + b[i];
    const s = powerSpectrum(sig, 1 / fs)!;
    expect(dominantPeak(s)!.freq).toBeCloseTo(5, 0);
    expect(dominantPeak(s, 10)!.freq).toBeCloseTo(20, 0);
  });

  // Skipping bin 0 is not enough on its own: an un-removed offset leaks into
  // the bins beside it and wins. This is why the module detrends first.
  it('is dominated by leakage when the caller leaves a DC offset in', () => {
    const fs = 100;
    const sig = Float64Array.from(sine(1024, fs, 5, 3), (v) => v + 10);
    const s = powerSpectrum(sig, 1 / fs)!;
    expect(dominantPeak(s)!.freq).toBeLessThan(1);
  });
});
