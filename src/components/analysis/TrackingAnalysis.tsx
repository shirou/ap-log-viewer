import { useMemo, useState } from 'react';
import type uPlot from 'uplot';
import { useLogStore } from '../../store/logStore.ts';
import { detectTrackingPairs, type TrackingPair } from '../../lib/analysisSources.ts';
import { alignAngles, getColumn, medianStep, resampleLinear, scaled, unwrapAngle } from '../../lib/signal.ts';
import { rangeIndices } from '../../lib/series.ts';
import { stepMetrics, trackingMetrics } from '../../lib/tracking.ts';
import { PALETTES, cssVar } from '../../lib/plotTheme.ts';
import { fmtNum } from '../../lib/format.ts';
import { useUplot } from '../../hooks/useUplot.ts';

interface Props {
  range: [number, number] | null;
}

interface Gridded {
  /** Seconds from the log start, for the overlay plot. */
  seconds: Float64Array;
  desired: Float64Array;
  actual: Float64Array;
  dtSec: number;
}

/**
 * Put both halves of a pair on one uniform grid over their overlap.
 *
 * The grid step is the coarser of the two series, never the finer: interpolating
 * a 4 Hz demand up to a 400 Hz response would fabricate the very edges whose
 * timing the lag estimate then measures.
 */
function gridPair(
  desTime: Float64Array,
  desVals: Float64Array,
  actTime: Float64Array,
  actVals: Float64Array,
  startTime: number,
  wrap: number,
): Gridded | null {
  if (desTime.length < 4 || actTime.length < 4) return null;
  const t0 = Math.max(desTime[0], actTime[0]);
  const t1 = Math.min(desTime[desTime.length - 1], actTime[actTime.length - 1]);
  if (!(t1 > t0)) return null;
  const step = Math.max(medianStep(desTime), medianStep(actTime));
  if (!(step > 0)) return null;
  const count = Math.floor((t1 - t0) / step) + 1;
  if (count < 8) return null;
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) times[i] = t0 + i * step;
  const seconds = Float64Array.from(times, (t) => (t - startTime) / 1e6);
  const desired = resampleLinear(desTime, desVals, times);
  const actual = resampleLinear(actTime, actVals, times);
  return {
    seconds,
    desired,
    // Put the response back on the demand's branch: the two unwrapped
    // independently, and a demand that jumps at a waypoint change takes a whole
    // turn with it that the response never made.
    actual: wrap > 0 ? alignAngles(desired, actual, wrap) : actual,
    dtSec: step / 1e6,
  };
}

/**
 * How closely the achieved signal follows the commanded one over the window.
 *
 * Reports a delay in seconds rather than a phase angle: a maneuver spans a band
 * of frequencies, and a single phase figure only means something at one of them.
 */
export default function TrackingAnalysis({ range }: Props) {
  const log = useLogStore((s) => s.log);
  const theme = useLogStore((s) => s.theme);
  const [pairIdx, setPairIdx] = useState(0);

  const pairs = useMemo(() => (log ? detectTrackingPairs(log.messages) : []), [log]);
  const pair: TrackingPair | undefined = pairs[Math.min(pairIdx, pairs.length - 1)];

  const grid = useMemo(() => {
    if (!log || !pair) return null;
    const des = getColumn(log, pair.desired);
    const act = getColumn(log, pair.actual);
    if (!des || !act) return null;
    const t0 = range ? range[0] : log.startTime;
    const t1 = range ? range[1] : log.endTime;
    const [d0, d1] = rangeIndices(des.time, t0, t1);
    const [a0, a1] = rangeIndices(act.time, t0, t1);
    if (d1 - d0 < 4 || a1 - a0 < 4) return null;

    // Unwrap before resampling: interpolating across a 359 -> 1 step would
    // sweep the whole circle backwards between two samples.
    const prep = (vals: Float64Array, i0: number, i1: number, scale: number) => {
      const s = scaled(vals.subarray(i0, i1), scale);
      return pair.wrap > 0 ? unwrapAngle(s, pair.wrap) : s;
    };
    return gridPair(
      des.time.subarray(d0, d1),
      prep(des.values, d0, d1, pair.desired.scale),
      act.time.subarray(a0, a1),
      prep(act.values, a0, a1, pair.actual.scale),
      log.startTime,
      pair.wrap,
    );
  }, [log, pair, range]);

  const metrics = useMemo(() => (grid ? trackingMetrics(grid.desired, grid.actual, grid.dtSec) : null), [grid]);
  const step = useMemo(() => (grid ? stepMetrics(grid.desired, grid.actual, grid.dtSec) : null), [grid]);

  const palette = PALETTES[theme];
  const { containerRef } = useUplot(
    () => ({
      data: [
        grid?.seconds ?? new Float64Array(0),
        grid?.desired ?? new Float64Array(0),
        grid?.actual ?? new Float64Array(0),
      ] as unknown as uPlot.AlignedData,
      options: {
        scales: { x: { time: false } },
        legend: { show: true },
        cursor: { drag: { x: false, y: false } },
        axes: [
          {
            stroke: cssVar('--plot-axis', '#8290a3'),
            grid: { stroke: cssVar('--plot-grid', '#2a334060') },
            values: (_u: uPlot, vals: number[]) => vals.map((v) => `${v}s`),
          },
          { stroke: cssVar('--plot-axis', '#8290a3'), grid: { stroke: cssVar('--plot-grid', '#2a334060') } },
        ],
        series: [
          {},
          { label: 'desired', stroke: palette[0], width: 1.4, points: { show: false } },
          { label: 'achieved', stroke: palette[1], width: 1.4, points: { show: false } },
        ],
      },
    }),
    [grid, palette],
  );

  if (!log) return null;
  if (!pair) return <p className="analysis-hint">No commanded/achieved pair in this log.</p>;

  const lagAtBound = metrics ? Math.abs(metrics.lagSec) >= metrics.maxLagSec - metrics.dtSec / 2 : false;

  return (
    <div className="tracking-analysis">
      <div className="analysis-controls">
        <label>
          Pair
          <select value={pairIdx} onChange={(e) => setPairIdx(Number(e.target.value))}>
            {pairs.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
                {p.unit ? ` [${p.unit}]` : ''}
                {p.varies ? '' : ' — never moves'}
              </option>
            ))}
          </select>
        </label>
        <span className="analysis-hint">
          {pair.desired.message}.{pair.desired.field} vs {pair.actual.message}.{pair.actual.field}
        </span>
      </div>

      {!pair.varies && (
        <p className="analysis-hint readout-warn">
          This demand never changes anywhere in the log — the autopilot publishes the field without driving it, so there
          is nothing to track.
        </p>
      )}

      <div className="tracking-plot" ref={containerRef} style={{ height: 240 }} />

      {!grid ? (
        <p className="analysis-hint">Not enough overlapping samples in this window — select a longer interval.</p>
      ) : (
        <div className="tracking-grid">
          <div className="analysis-readout">
            <h3>Tracking</h3>
            {metrics ? (
              <dl>
                <dt>lag</dt>
                <dd className={lagAtBound ? 'readout-warn' : ''}>
                  {fmtNum(metrics.lagSec * 1000, 0)} ms{lagAtBound ? ' (at search bound)' : ''}
                </dd>
                <dt>gain at lag</dt>
                <dd>{fmtNum(metrics.gain, 3)}</dd>
                <dt>r at lag</dt>
                <dd className={metrics.r < 0.5 ? 'readout-warn' : ''}>{fmtNum(metrics.r, 3)}</dd>
                <dt>RMS error</dt>
                <dd>
                  {fmtNum(metrics.rmsError, 3)} {pair.unit}
                </dd>
                <dt>bias</dt>
                <dd>
                  {fmtNum(metrics.bias, 3)} {pair.unit}
                </dd>
                <dt>grid</dt>
                <dd>
                  {fmtNum(1 / metrics.dtSec, 1)} Hz · {metrics.count} pts
                </dd>
              </dl>
            ) : (
              <p className="analysis-hint">Window too short for a lag estimate.</p>
            )}
            {metrics && metrics.r < 0.5 && (
              <p className="analysis-hint">
                The two signals barely correlate at any shift, so the lag is not meaningful here.
              </p>
            )}
          </div>

          <div className="analysis-readout">
            <h3>Step response</h3>
            {step ? (
              <dl>
                <dt>step at</dt>
                <dd>{fmtNum(step.stepTimeSec, 2)} s into window</dd>
                <dt>amplitude</dt>
                <dd>
                  {fmtNum(step.amplitude, 3)} {pair.unit}
                </dd>
                <dt>delay to 10%</dt>
                <dd>{step.delaySec === null ? '—' : `${fmtNum(step.delaySec * 1000, 0)} ms`}</dd>
                <dt>rise 10→90%</dt>
                <dd>{step.riseTimeSec === null ? '—' : `${fmtNum(step.riseTimeSec * 1000, 0)} ms`}</dd>
                <dt>overshoot</dt>
                <dd className={(step.overshootPct ?? 0) > 25 ? 'readout-warn' : ''}>
                  {step.overshootPct === null ? '—' : `${fmtNum(step.overshootPct, 1)}%`}
                </dd>
                <dt>settling (±5%)</dt>
                <dd>{step.settlingTimeSec === null ? 'not settled' : `${fmtNum(step.settlingTimeSec, 2)} s`}</dd>
                <dt>steady-state error</dt>
                <dd>
                  {fmtNum(step.steadyStateError, 3)} {pair.unit}
                </dd>
              </dl>
            ) : (
              <p className="analysis-hint">
                No step in this window. Select an interval containing one clear command change — a gradual or noisy
                demand has no rise time to report.
              </p>
            )}
          </div>
        </div>
      )}

      <p className="analysis-note">
        Both signals are put on one uniform grid at the coarser of their two rates before anything is measured, so the
        resolution of the lag is that grid's step. {pair.wrap > 0 && 'This pair wraps, so it is unwrapped first. '}
        No time constant is reported: fitting one would assert a first-order system, which a tuned vehicle loop is not.
      </p>
    </div>
  );
}
