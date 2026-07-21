// Discrete spectrum of a uniformly-sampled window.
//
// Pure and dependency-free like the rest of src/lib. The normalization is spelled
// out below and checked against Parseval's theorem in the tests, because a
// periodogram whose scale is only "relative" invites reading a taller peak in
// one window as more energy than a shorter peak in another.

/**
 * In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must share a
 * power-of-two length.
 */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fftRadix2 needs a power-of-two length, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export interface Spectrum {
  /** Bin centre frequencies, Hz. */
  freqs: Float64Array;
  /** One-sided power spectral density, (signal units)²/Hz. */
  psd: Float64Array;
  /** Bin spacing, Hz. */
  df: number;
  /** Highest frequency the sample rate can represent, Hz. */
  nyquist: number;
  /** Samples that carried signal (excludes the zero padding). */
  sampleCount: number;
}

export interface SpectrumOptions {
  /** Hann by default; 'none' only for signals already periodic in the window. */
  window?: 'hann' | 'none';
  /** Zero-pad up to the next power of two rather than truncating down to one. */
  zeroPad?: boolean;
}

/**
 * One-sided power spectral density of `samples`.
 *
 * Scaled as `2·|X_k|² / (fs·Σw²)`, with DC and Nyquist not doubled (they have no
 * mirror bin to fold in) and `Σw²` taken over the real samples only, so padding
 * changes the resolution without changing the level. Under that scaling
 * `Σ psd·df` recovers the signal's variance whatever the window or padding —
 * which is exactly what the tests assert.
 *
 * The caller is responsible for removing the mean and any trend first (see
 * signal.detrend); a DC offset otherwise dominates every plot. Non-finite
 * samples are rejected rather than zero-filled, since a zero is a real value to
 * an FFT and would ring across the whole band.
 */
export function powerSpectrum(samples: ArrayLike<number>, dtSec: number, opts: SpectrumOptions = {}): Spectrum | null {
  const n = samples.length;
  if (n < 4 || !(dtSec > 0)) return null;
  for (let i = 0; i < n; i++) if (!Number.isFinite(samples[i])) return null;

  const zeroPad = opts.zeroPad ?? true;
  let nfft = 1;
  if (zeroPad) {
    while (nfft < n) nfft <<= 1;
  } else {
    while (nfft * 2 <= n) nfft <<= 1;
  }
  const used = Math.min(n, nfft);
  if (used < 4) return null;

  const useHann = (opts.window ?? 'hann') === 'hann';
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  let sumW2 = 0;
  for (let i = 0; i < used; i++) {
    // Periodic (not symmetric) Hann: the DFT treats the window as one cycle of a
    // periodic extension, and the symmetric variant duplicates its endpoint.
    const w = useHann ? 0.5 * (1 - Math.cos((2 * Math.PI * i) / used)) : 1;
    re[i] = samples[i] * w;
    sumW2 += w * w;
  }
  if (!(sumW2 > 0)) return null;

  fftRadix2(re, im);

  const fs = 1 / dtSec;
  const bins = Math.floor(nfft / 2) + 1;
  const freqs = new Float64Array(bins);
  const psd = new Float64Array(bins);
  const scale = 1 / (fs * sumW2);
  for (let k = 0; k < bins; k++) {
    freqs[k] = k / (nfft * dtSec);
    const mag2 = re[k] * re[k] + im[k] * im[k];
    const oneSided = k === 0 || (nfft % 2 === 0 && k === nfft / 2) ? 1 : 2;
    psd[k] = oneSided * mag2 * scale;
  }
  return { freqs, psd, df: 1 / (nfft * dtSec), nyquist: fs / 2, sampleCount: used };
}

export interface SpectralPeak {
  freq: number;
  /** PSD at the peak bin. */
  power: number;
  index: number;
}

/**
 * Strongest bin at or above `minFreq`, DC excluded by default.
 *
 * Bin resolution is `df`; zero-padding interpolates between bins but does not
 * sharpen them, so a peak is only located to within roughly `1/(N·dt)` of true
 * sampled time however finely the transform is evaluated.
 */
export function dominantPeak(s: Spectrum, minFreq = 0): SpectralPeak | null {
  let best = -1;
  let bestP = -Infinity;
  for (let k = 1; k < s.psd.length; k++) {
    if (s.freqs[k] < minFreq) continue;
    if (s.psd[k] > bestP) {
      bestP = s.psd[k];
      best = k;
    }
  }
  return best < 0 ? null : { freq: s.freqs[best], power: bestP, index: best };
}
