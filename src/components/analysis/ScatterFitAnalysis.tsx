import { useMemo, useState } from 'react';
import { useLogStore } from '../../store/logStore.ts';
import { detectScatterPresets, type ScatterAxis } from '../../lib/analysisSources.ts';
import { getColumn, pairOnCommonTime, scaled } from '../../lib/signal.ts';
import { linearFit } from '../../lib/stats.ts';
import { fmtNum } from '../../lib/format.ts';
import ScatterCanvas from './ScatterCanvas.tsx';

interface Props {
  range: [number, number] | null;
}

const TIME_FIELDS = new Set(['TimeUS', 'TimeMS', 'timeBootMs', 'timeUsec', 'timeUnixUsec']);
const EMPTY = new Float64Array(0);

const axisTitle = (a: ScatterAxis) => `${a.label}${a.unit ? ` (${a.unit})` : ''}`;

/**
 * One field against another, with a least-squares line.
 *
 * The presets are the fits worth naming — battery sag against current is the
 * pack's internal resistance, throttle against speed is the thrust curve and its
 * deadband — but any two numeric columns can be paired, since which pair matters
 * depends on the vehicle.
 */
export default function ScatterFitAnalysis({ range }: Props) {
  const log = useLogStore((s) => s.log);
  const theme = useLogStore((s) => s.theme);
  const presets = useMemo(() => (log ? detectScatterPresets(log.messages) : []), [log]);

  // -1 is the custom pair; presets are offered first because they are the ones
  // that come with an interpretation.
  const [presetIdx, setPresetIdx] = useState(0);
  const [xMsg, setXMsg] = useState('');
  const [xField, setXField] = useState('');
  const [yMsg, setYMsg] = useState('');
  const [yField, setYField] = useState('');

  const messageNames = useMemo(() => (log ? Object.keys(log.messages).sort() : []), [log]);
  const fieldsOf = (name: string) =>
    log && log.messages[name] ? Object.keys(log.messages[name].fields).filter((f) => !TIME_FIELDS.has(f)) : [];

  // With no preset to offer, the custom pair is the only choice there is.
  const custom = presetIdx < 0 || presets.length === 0;
  const axes = useMemo<{ x: ScatterAxis; y: ScatterAxis } | null>(() => {
    if (!custom) {
      const p = presets[Math.min(presetIdx, presets.length - 1)];
      return p ? { x: p.x, y: p.y } : null;
    }
    if (!xMsg || !xField || !yMsg || !yField) return null;
    return {
      x: { message: xMsg, field: xField, scale: 1, unit: '', label: `${xMsg}.${xField}` },
      y: { message: yMsg, field: yField, scale: 1, unit: '', label: `${yMsg}.${yField}` },
    };
  }, [custom, presetIdx, presets, xMsg, xField, yMsg, yField]);

  const preset = custom ? null : presets[Math.min(presetIdx, presets.length - 1)];

  const paired = useMemo(() => {
    if (!log || !axes) return null;
    const xc = getColumn(log, axes.x);
    const yc = getColumn(log, axes.y);
    if (!xc || !yc) return null;
    const t0 = range ? range[0] : log.startTime;
    const t1 = range ? range[1] : log.endTime;
    const p = pairOnCommonTime(xc, yc, t0, t1);
    if (!p) return null;
    return { xs: scaled(p.a, axes.x.scale), ys: scaled(p.b, axes.y.scale) };
  }, [log, axes, range]);

  const fit = useMemo(() => (paired ? linearFit(paired.xs, paired.ys) : null), [paired]);
  const fitLine = useMemo(
    () => (fit && Number.isFinite(fit.slope) ? { slope: fit.slope, intercept: fit.intercept } : null),
    [fit],
  );

  if (!log) return null;

  const slopeUnit = axes ? `${axes.y.unit || 'y'}/${axes.x.unit || 'x'}` : '';
  // A pack's internal resistance is the negative of the sag slope, in milliohms.
  // Only shown when the pack actually sagged: a non-negative slope means the
  // window caught no load variation worth fitting, and a headline reading
  // "-12 mΩ" would dress that up as a measurement.
  const resistance = preset?.interpret === 'internal-resistance' && fit && fit.slope < 0 ? -fit.slope * 1000 : NaN;

  return (
    <div className="scatterfit-analysis">
      <div className="analysis-controls">
        <label>
          Fit
          <select value={custom ? -1 : presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))}>
            {presets.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
            <option value={-1}>Custom…</option>
          </select>
        </label>
        {custom && (
          <>
            <label>
              X
              <select
                value={xMsg}
                onChange={(e) => {
                  setXMsg(e.target.value);
                  setXField(fieldsOf(e.target.value)[0] ?? '');
                }}
              >
                <option value="">—</option>
                {messageNames.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={xField} onChange={(e) => setXField(e.target.value)} disabled={!xMsg}>
                {fieldsOf(xMsg).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Y
              <select
                value={yMsg}
                onChange={(e) => {
                  setYMsg(e.target.value);
                  setYField(fieldsOf(e.target.value)[0] ?? '');
                }}
              >
                <option value="">—</option>
                {messageNames.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={yField} onChange={(e) => setYField(e.target.value)} disabled={!yMsg}>
                {fieldsOf(yMsg).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      {!axes ? (
        <p className="analysis-hint">
          {presets.length === 0 && !custom
            ? 'No preset fit applies to this log — pick two fields with Custom.'
            : 'Pick a field for each axis.'}
        </p>
      ) : (
        <div className="compass-grid">
          <ScatterCanvas
            xs={paired?.xs ?? EMPTY}
            ys={paired?.ys ?? EMPTY}
            theme={theme}
            fitLine={fitLine}
            xLabel={axisTitle(axes.x)}
            yLabel={axisTitle(axes.y)}
          />
          <div className="analysis-readout">
            {fit && Number.isFinite(fit.slope) ? (
              <>
                {Number.isFinite(resistance) && (
                  <div className="readout-headline">
                    <span className="readout-big">
                      {fmtNum(resistance, 1)}
                      <span className="readout-unit">mΩ</span>
                    </span>
                    <span className="readout-cap">internal resistance (−slope)</span>
                  </div>
                )}
                <dl>
                  <dt>slope</dt>
                  <dd>
                    {fit.slope.toPrecision(4)} {slopeUnit}
                  </dd>
                  <dt>intercept</dt>
                  <dd>
                    {fit.intercept.toPrecision(4)} {axes.y.unit}
                  </dd>
                  <dt>r</dt>
                  <dd className={Math.abs(fit.r) < 0.5 ? 'readout-warn' : ''}>{fmtNum(fit.r, 3)}</dd>
                  <dt>r²</dt>
                  <dd>{fmtNum(fit.r * fit.r, 3)}</dd>
                  <dt>points</dt>
                  <dd>{fit.count}</dd>
                </dl>
                {Math.abs(fit.r) < 0.5 && (
                  <p className="analysis-hint">
                    Weak correlation — the line is a poor summary of this cloud, so read the slope with suspicion.
                  </p>
                )}
                {preset?.note && <p className="analysis-hint">{preset.note}</p>}
              </>
            ) : (
              <p className="analysis-hint">
                {paired ? 'Not enough overlapping samples to fit.' : 'No samples in the selected window.'}
              </p>
            )}
          </div>
        </div>
      )}

      <p className="analysis-note">
        The two fields rarely share timestamps, so the denser one is interpolated onto the sparser one's samples.
        Interpolation smooths, which flatters the correlation slightly; a fit built from a handful of points across a
        narrow range of x says little whatever r reads.
      </p>
    </div>
  );
}
