import { useMemo, useState } from 'react';
import type uPlot from 'uplot';
import { useLogStore } from '../../store/logStore.ts';
import { detectSpectrumSources } from '../../lib/analysisSources.ts';
import { detrend, getColumn, toUniform, type UniformSeries } from '../../lib/signal.ts';
import { rangeIndices } from '../../lib/series.ts';
import { dominantPeak, powerSpectrum, type SpectralPeak, type Spectrum } from '../../lib/fft.ts';
import { PALETTES, cssVar } from '../../lib/plotTheme.ts';
import { fmtNum } from '../../lib/format.ts';
import { useUplot } from '../../hooks/useUplot.ts';
import type { FieldRef } from '../../model/log.ts';

interface Props {
  range: [number, number] | null;
}

const TIME_FIELDS = new Set(['TimeUS', 'TimeMS', 'timeBootMs', 'timeUsec', 'timeUnixUsec']);

type SpectrumError = 'short' | 'gaps' | 'missing' | 'flat';

type SpectrumResult =
  | { kind: 'error'; error: SpectrumError }
  | { kind: 'ok'; spectrum: Spectrum; uniform: UniformSeries; peak: SpectralPeak | null };

const ERROR_TEXT: Record<SpectrumError, string> = {
  short: 'Too few samples in the selected window for a spectrum — select a longer interval.',
  gaps: 'This signal has holes in the selected window; a spectrum over a gapped series would be misleading.',
  missing: 'This log carries no data for the selected field.',
  flat: 'This signal does not vary over the window, so its spectrum carries no power to show.',
};

// Signals whose oscillation is worth looking at first: a vehicle hunting on its
// heading or rate shows up here well before it shows up anywhere else.
const PREFERRED: ReadonlyArray<FieldRef> = [
  { message: 'RATE', field: 'R' },
  { message: 'RATE', field: 'Y' },
  { message: 'ATT', field: 'Roll' },
  { message: 'ATTITUDE', field: 'rollspeed' },
  { message: 'ATTITUDE', field: 'yawspeed' },
  { message: 'VFR_HUD', field: 'heading' },
];

export default function SpectrumAnalysis({ range }: Props) {
  const log = useLogStore((s) => s.log);
  const theme = useLogStore((s) => s.theme);
  const selected = useLogStore((s) => s.selectedFields);
  const sources = useMemo(() => (log ? detectSpectrumSources(log.messages) : null), [log]);

  const messageNames = useMemo(() => (log ? Object.keys(log.messages).sort() : []), [log]);
  const fieldsOf = (name: string) =>
    log && log.messages[name] ? Object.keys(log.messages[name].fields).filter((f) => !TIME_FIELDS.has(f)) : [];

  const initial = useMemo<FieldRef | null>(() => {
    if (!log) return null;
    for (const ref of [...PREFERRED, ...selected]) {
      if (log.messages[ref.message]?.fields[ref.field]) return ref;
    }
    for (const name of messageNames) {
      const f = fieldsOf(name)[0];
      if (f) return { message: name, field: f };
    }
    return null;
  }, [log, selected, messageNames]);

  const [ref, setRef] = useState<FieldRef | null>(null);
  const active = ref ?? initial;
  const [logY, setLogY] = useState(true);

  const result = useMemo<SpectrumResult | null>(() => {
    if (!log || !active) return null;
    const col = getColumn(log, active);
    if (!col) return { kind: 'error', error: 'missing' };
    const [i0, i1] = range ? rangeIndices(col.time, range[0], range[1]) : [0, col.values.length];
    const uniform = toUniform(col.time, col.values, i0, i1);
    if (!uniform) return { kind: 'error', error: 'short' };
    if (uniform.nanCount > 0) return { kind: 'error', error: 'gaps' };
    const spectrum = powerSpectrum(detrend(uniform.values), uniform.dtSec);
    if (!spectrum) return { kind: 'error', error: 'short' };
    return { kind: 'ok', spectrum, uniform, peak: dominantPeak(spectrum) };
  }, [log, active, range]);

  const ok = result?.kind === 'ok' ? result : null;
  const spectrum = ok?.spectrum ?? null;
  const palette = PALETTES[theme];

  // Bin 0 is the residual DC of a detrended signal — plotting it on a log axis
  // just anchors the scale at zero and flattens everything else.
  //
  // A logarithmic axis also cannot accept the empty bins a windowed transform
  // leaves behind: log(0) has no position on it, and uPlot resolves the whole
  // layout to zero rather than dropping the point, which renders as a plot that
  // is simply not there. Those bins become gaps, and the axis is floored eight
  // decades below the peak so one near-empty bin cannot squash everything else.
  const view = useMemo(() => {
    if (!spectrum) return null;
    const freqs = spectrum.freqs.subarray(1);
    const psd = spectrum.psd.subarray(1);
    let hi = 0;
    let lo = Infinity;
    for (const v of psd) {
      if (v > 0) {
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
    }
    if (!(hi > 0)) return null;
    const floor = Math.max(lo, hi * 1e-8);
    const values = logY ? Array.from(psd, (v) => (v >= floor ? v : null)) : psd;
    return { data: [freqs, values] as unknown as uPlot.AlignedData, floor, hi };
  }, [spectrum, logY]);

  const { containerRef } = useUplot(
    () => ({
      data: view?.data ?? ([new Float64Array(0), new Float64Array(0)] as unknown as uPlot.AlignedData),
      options: {
        scales: {
          x: { time: false },
          y: logY && view ? { distr: 3 as const, range: (): [number, number] => [view.floor, view.hi] } : {},
        },
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        axes: [
          {
            stroke: cssVar('--plot-axis', '#8290a3'),
            grid: { stroke: cssVar('--plot-grid', '#2a334060') },
            values: (_u: uPlot, vals: number[]) => vals.map((v) => `${v} Hz`),
          },
          {
            stroke: cssVar('--plot-axis', '#8290a3'),
            grid: { stroke: cssVar('--plot-grid', '#2a334060') },
            // A power spectrum spans decades; uPlot also nulls out the ticks it
            // filters off a log axis, so guard before touching the value.
            values: (_u: uPlot, vals: Array<number | null>) =>
              vals.map((v) => {
                if (v == null || !Number.isFinite(v)) return '';
                const a = Math.abs(v);
                return a >= 0.001 && a < 1e4 ? String(+v.toPrecision(3)) : v.toExponential(0);
              }),
          },
        ],
        series: [{}, { stroke: palette[2], width: 1.2, points: { show: false } }],
      },
    }),
    [view, palette, logY],
  );

  if (!log || !sources) return null;

  const sampleRate = ok ? 1 / ok.uniform.dtSec : NaN;

  return (
    <div className="spectrum-analysis">
      <div className="analysis-controls">
        <label>
          Signal
          <select
            value={active?.message ?? ''}
            onChange={(e) => setRef({ message: e.target.value, field: fieldsOf(e.target.value)[0] ?? '' })}
          >
            {messageNames.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={active?.field ?? ''}
            onChange={(e) => active && setRef({ message: active.message, field: e.target.value })}
          >
            {fieldsOf(active?.message ?? '').map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> log power
        </label>
      </div>

      {/* Every dead end says which one it is. A silent empty panel leaves the
          reader unable to tell a flat signal from a broken module. */}
      {result === null ? (
        <p className="analysis-hint">Select a signal to transform.</p>
      ) : result.kind === 'error' ? (
        <p className="analysis-hint">{ERROR_TEXT[result.error]}</p>
      ) : !view ? (
        <p className="analysis-hint">{ERROR_TEXT.flat}</p>
      ) : (
        spectrum && (
          <>
            <div className="spectrum-plot" ref={containerRef} style={{ height: 260 }} />
            <div className="analysis-readout spectrum-readout">
              <dl>
                <dt>dominant peak</dt>
                <dd>
                  {ok?.peak ? `${fmtNum(ok.peak.freq, 3)} Hz (${fmtNum(1 / ok.peak.freq, 2)} s period)` : '—'}
                </dd>
                <dt>sample rate</dt>
                <dd>{fmtNum(sampleRate, 1)} Hz</dd>
                <dt>Nyquist</dt>
                <dd>{fmtNum(spectrum.nyquist, 2)} Hz</dd>
                <dt>resolution</dt>
                <dd>{fmtNum(spectrum.df, 4)} Hz</dd>
                <dt>samples</dt>
                <dd>
                  {spectrum.sampleCount}
                  {ok && ok.uniform.droppedSamples > 0 ? ` (${ok.uniform.droppedSamples} dropped across a gap)` : ''}
                </dd>
              </dl>
            </div>
          </>
        )
      )}

      {sources.onboardFft.length > 0 && (
        <p className="analysis-hint">
          This log also carries onboard FFT results ({sources.onboardFft.map((s) => s.message).join(', ')}) — plot those
          fields directly in the Fields tab; they are already a spectrum and must not be transformed again.
        </p>
      )}

      <p className="analysis-note">
        This transform is only as good as its source rate. At {fmtNum(sampleRate, 1)} Hz nothing above{' '}
        {fmtNum(spectrum?.nyquist ?? NaN, 2)} Hz can be represented, and real motion up there folds back into this plot
        as a convincing low-frequency peak. That makes it a fair tool for the slow oscillations of a control loop —
        hunting, limit cycles — and the wrong tool for propeller and motor vibration, which needs batch IMU sampling
        (INS_LOG_BAT_MASK, giving ISBH/ISBD) or the onboard FFT (FFT_ENABLE, giving FTN1/FTN2).
        {sources.hasBatchImu && ' This log does carry ISBH/ISBD batches, which this viewer does not yet decode.'}
      </p>
    </div>
  );
}
