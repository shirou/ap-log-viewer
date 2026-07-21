import { useMemo, useState } from 'react';
import { useLogStore } from '../../store/logStore.ts';
import { detectDriverSources, detectMagSources } from '../../lib/analysisSources.ts';
import { getColumn, resampleLinear } from '../../lib/signal.ts';
import { fitCircle } from '../../lib/circleFit.ts';
import { columnStats, linearFit } from '../../lib/stats.ts';
import { rangeIndices } from '../../lib/series.ts';
import ScatterCanvas from './ScatterCanvas.tsx';

interface Props {
  range: [number, number] | null;
}

const EMPTY = new Float64Array(0);

function num(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

/**
 * Magnetometer hard-iron diagnostic: fit a circle to the x-y locus over the
 * selected interval; its center is the residual offset the current COMPASS_OFS
 * did not remove. Also reports |B| stability and, when a current/throttle source
 * exists, a COMPASS_MOT-style |B|-vs-drive scatter for motor interference.
 */
export default function CompassAnalysis({ range }: Props) {
  const log = useLogStore((s) => s.log);
  const theme = useLogStore((s) => s.theme);
  const [sourceIdx, setSourceIdx] = useState(0);
  const [driverIdx, setDriverIdx] = useState(0);

  const magSources = useMemo(() => (log ? detectMagSources(log.messages) : []), [log]);
  const driverSources = useMemo(() => (log ? detectDriverSources(log.messages) : []), [log]);
  const source = magSources[Math.min(sourceIdx, magSources.length - 1)];

  const cols = useMemo(() => {
    if (!log || !source) return null;
    const x = getColumn(log, { message: source.message, field: source.xField });
    const y = getColumn(log, { message: source.message, field: source.yField });
    const z = getColumn(log, { message: source.message, field: source.zField });
    return x && y && z ? { x, y, z, time: x.time } : null;
  }, [log, source]);

  const win = useMemo<[number, number]>(() => {
    if (!cols) return [0, 0];
    return range ? rangeIndices(cols.time, range[0], range[1]) : [0, cols.time.length];
  }, [cols, range]);

  const fit = useMemo(() => {
    if (!cols) return null;
    return fitCircle(cols.x.values, cols.y.values, win[0], win[1]);
  }, [cols, win]);

  // |B| over the window, and its stability.
  const magnitude = useMemo(() => {
    if (!cols) return new Float64Array(0);
    const [i0, i1] = win;
    const out = new Float64Array(Math.max(0, i1 - i0));
    for (let i = i0; i < i1; i++) out[i - i0] = Math.hypot(cols.x.values[i], cols.y.values[i], cols.z.values[i]);
    return out;
  }, [cols, win]);
  const magStats = useMemo(() => columnStats(magnitude), [magnitude]);

  // Sliced x/y and the fitted circle, memoized so ScatterCanvas isn't handed a
  // fresh subarray/object identity every render (which would redraw the canvas).
  const scatter = useMemo(() => {
    if (!cols) return { x: EMPTY, y: EMPTY };
    return { x: cols.x.values.subarray(win[0], win[1]), y: cols.y.values.subarray(win[0], win[1]) };
  }, [cols, win]);
  const overlayCircle = useMemo(() => (fit && fit.ok ? { cx: fit.cx, cy: fit.cy, r: fit.R } : null), [fit]);

  // COMPASS_MOT: |B| against the drive signal, resampled onto the mag timestamps.
  const driver = driverSources[Math.min(driverIdx, driverSources.length - 1)];
  const motor = useMemo(() => {
    if (!log || !cols || !driver || magnitude.length === 0) return null;
    const dcol = getColumn(log, { message: driver.message, field: driver.field });
    if (!dcol) return null;
    const target = cols.time.subarray(win[0], win[1]);
    const driveOnMag = resampleLinear(dcol.time, dcol.values, target);
    const lf = linearFit(driveOnMag, magnitude);
    const fitLine = Number.isFinite(lf.slope) ? { slope: lf.slope, intercept: lf.intercept } : null;
    return { driveOnMag, fit: lf, fitLine, driver };
  }, [log, cols, driver, magnitude, win]);

  if (!log) return null;
  if (!source || !cols) {
    return <p className="analysis-hint">No magnetometer data in this log.</p>;
  }

  return (
    <div className="compass-analysis">
      <div className="analysis-controls">
        <label>
          Compass
          <select value={sourceIdx} onChange={(e) => setSourceIdx(Number(e.target.value))}>
            {magSources.map((s, i) => (
              <option key={s.message} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {!range && <span className="analysis-hint">Select a rotation interval on the strip above.</span>}
      </div>

      <div className="compass-grid">
        <ScatterCanvas
          xs={scatter.x}
          ys={scatter.y}
          theme={theme}
          equalAspect
          overlayCircle={overlayCircle}
          xLabel={`${source.xField} (sensor units)`}
          yLabel={source.yField}
        />
        <div className="analysis-readout">
          {fit && fit.ok ? (
            <>
              <div className="readout-headline">
                <span className="readout-big">{num(fit.headingErrorDeg, 1)}°</span>
                <span className="readout-cap">worst-case heading error</span>
              </div>
              <dl>
                <dt>center (cx, cy)</dt>
                <dd>
                  {num(fit.cx)}, {num(fit.cy)}
                </dd>
                <dt>radius R</dt>
                <dd>{num(fit.R)}</dd>
                <dt>residual offset d</dt>
                <dd>{num(fit.d)}</dd>
                <dt>d / R</dt>
                <dd>{(fit.dOverR * 100).toFixed(1)}%</dd>
                <dt>radial σ</dt>
                <dd>
                  {num(fit.radialStddev, 1)} ({((fit.radialStddev / fit.R) * 100).toFixed(1)}% of R)
                </dd>
                <dt>arc coverage</dt>
                <dd className={fit.arcCoverageDeg < 270 ? 'readout-warn' : ''}>{num(fit.arcCoverageDeg)}°</dd>
                <dt>samples</dt>
                <dd>{fit.sampleCount}</dd>
              </dl>
              {fit.arcCoverageDeg < 270 && (
                <p className="analysis-hint">Arc &lt; 270° — the center is unreliable; select more of a full turn.</p>
              )}
            </>
          ) : (
            <p className="analysis-hint">
              {fit && !fit.ok && fit.reason === 'too-few-samples'
                ? 'Too few samples — select an interval covering a horizontal rotation.'
                : fit && !fit.ok
                  ? 'Points too collinear to fit a circle — rotate through more of a turn.'
                  : 'Select an interval to fit.'}
            </p>
          )}
        </div>
      </div>

      <div className="compass-mot">
        <h3>Field strength / COMPASS_MOT</h3>
        {magStats ? (
          <>
            <p className="analysis-hint">
              |B| mean {num(magStats.mean)} · CV {Number.isFinite(magStats.cv) ? (magStats.cv * 100).toFixed(1) : '—'}% (a
              good compass keeps |B| nearly constant; rising |B| with current means motor interference).
            </p>
            {motor ? (
              <>
                <ScatterCanvas
                  xs={motor.driveOnMag}
                  ys={magnitude}
                  theme={theme}
                  fitLine={motor.fitLine}
                  xLabel={`${motor.driver.label} (${motor.driver.unit || motor.driver.kind})`}
                  yLabel="|B|"
                  height={260}
                />
                <p className="analysis-hint">
                  slope {num(motor.fit.slope, 3)} |B|/{motor.driver.unit || motor.driver.kind} · r{' '}
                  {Number.isFinite(motor.fit.r) ? motor.fit.r.toFixed(2) : '—'}
                  {driverSources.length > 1 && (
                    <select value={driverIdx} onChange={(e) => setDriverIdx(Number(e.target.value))}>
                      {driverSources.map((d, i) => (
                        <option key={d.label} value={i}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  )}
                </p>
              </>
            ) : (
              <p className="analysis-hint">No current/throttle channel found for an interference scatter.</p>
            )}
          </>
        ) : (
          <p className="analysis-hint">No samples in the selected window.</p>
        )}
      </div>

      <p className="analysis-note">
        Values are in the raw sensor frame (before COMPASS_ORIENT/board rotation and the vehicle's own 3D
        calibration) — a diagnostic, not a drop-in COMPASS_OFS. The z offset cannot be separated from a horizontal
        rotation.
      </p>
    </div>
  );
}
