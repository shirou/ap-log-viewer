import { useMemo, useState } from 'react';
import { useLogStore } from '../../store/logStore.ts';
import { detectActuatorSources } from '../../lib/analysisSources.ts';
import { getColumn } from '../../lib/signal.ts';
import { columnStats, type ColumnStats } from '../../lib/stats.ts';
import { rangeIndices } from '../../lib/series.ts';
import { fmtNum, fmtPct } from '../../lib/format.ts';

interface Props {
  range: [number, number] | null;
}

/** Microseconds either side of a limit still counted as sitting on it. */
const SAT_TOL = 2;

interface ChannelRow {
  index: number;
  field: string;
  stats: ColumnStats | null;
  min: number;
  max: number;
  /** Limits came from the log's own parameters rather than the defaults. */
  fromParams: boolean;
  lowFrac: number;
  highFrac: number;
  /** The channel never moves — an unassigned output rather than a stuck one. */
  idle: boolean;
  /** Observed values fall outside the assumed limits, so those limits are wrong. */
  outOfBounds: boolean;
}

/**
 * Per-channel output balance and saturation.
 *
 * A thruster or servo that spends the window against its endpoint has no
 * authority left, and one that sits well off the group's mean is doing more of
 * the work than its neighbours — both show up here before they show up as a
 * vehicle that will not hold heading.
 */
export default function ThrusterAnalysis({ range }: Props) {
  const log = useLogStore((s) => s.log);
  const [sourceIdx, setSourceIdx] = useState(0);
  const [overrideMin, setOverrideMin] = useState('');
  const [overrideMax, setOverrideMax] = useState('');

  const sources = useMemo(() => (log ? detectActuatorSources(log.messages) : []), [log]);
  const source = sources[Math.min(sourceIdx, sources.length - 1)];

  const rows = useMemo<ChannelRow[]>(() => {
    if (!log || !source) return [];
    const oMin = parseFloat(overrideMin);
    const oMax = parseFloat(overrideMax);
    return source.channels.map((ch) => {
      const col = getColumn(log, { message: source.message, field: ch.field });
      const [i0, i1] = col && range ? rangeIndices(col.time, range[0], range[1]) : [0, col?.values.length ?? 0];
      const stats = col ? columnStats(col.values, i0, i1) : null;

      // The vehicle's own limits when the log carries them: a frame with
      // narrowed endpoints saturates long before the 1100/1900 defaults say so.
      const pMin = log.params[`${source.paramPrefix}${ch.index}_MIN`];
      const pMax = log.params[`${source.paramPrefix}${ch.index}_MAX`];
      const fromParams = Number.isFinite(pMin) && Number.isFinite(pMax);
      let min = fromParams ? pMin : source.defaultMin;
      let max = fromParams ? pMax : source.defaultMax;
      if (Number.isFinite(oMin)) min = oMin;
      if (Number.isFinite(oMax)) max = oMax;

      let low = 0;
      let high = 0;
      let n = 0;
      if (col) {
        for (let i = i0; i < i1; i++) {
          const v = col.values[i];
          if (!Number.isFinite(v)) continue;
          n++;
          if (v <= min + SAT_TOL) low++;
          if (v >= max - SAT_TOL) high++;
        }
      }
      const idle = !stats || (stats.std === 0 && (stats.mean === 0 || stats.count <= 1));
      return {
        index: ch.index,
        field: ch.field,
        stats,
        min,
        max,
        fromParams,
        lowFrac: n ? low / n : NaN,
        highFrac: n ? high / n : NaN,
        idle,
        outOfBounds: Boolean(stats) && !idle && (stats!.min < min - SAT_TOL || stats!.max > max + SAT_TOL),
      };
    });
  }, [log, source, range, overrideMin, overrideMax]);

  const active = useMemo(() => rows.filter((r) => !r.idle && r.stats), [rows]);

  // Imbalance is only meaningful against the channels that are actually driven.
  const groupMean = useMemo(() => {
    if (active.length < 2) return NaN;
    return active.reduce((s, r) => s + r.stats!.mean, 0) / active.length;
  }, [active]);

  const worst = useMemo(() => {
    if (!active.length) return null;
    let sat = active[0];
    for (const r of active) {
      if (Math.max(r.lowFrac, r.highFrac) > Math.max(sat.lowFrac, sat.highFrac)) sat = r;
    }
    return sat;
  }, [active]);

  const anyOutOfBounds = rows.some((r) => r.outOfBounds);
  // Provenance is per channel — a log can carry SERVO1_MIN and not SERVO3_MIN —
  // so the label is only allowed to claim the parameters when every driven
  // channel actually came from them.
  const overridden = Number.isFinite(parseFloat(overrideMin)) || Number.isFinite(parseFloat(overrideMax));
  const limitSource = overridden
    ? 'manual'
    : active.length && active.every((r) => r.fromParams)
      ? `from ${source.paramPrefix}n_MIN/MAX`
      : active.some((r) => r.fromParams)
        ? 'part parameters, part defaults'
        : 'assumed defaults';

  if (!log) return null;
  if (!source) return <p className="analysis-hint">No servo or RC channel bank in this log.</p>;

  return (
    <div className="thruster-analysis">
      <div className="analysis-controls">
        {sources.length > 1 && (
          <label>
            Channels
            <select value={sourceIdx} onChange={(e) => setSourceIdx(Number(e.target.value))}>
              {sources.map((s, i) => (
                <option key={s.message} value={i}>
                  {s.label} ({s.kind})
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          limits
          <input
            type="number"
            placeholder={String(rows[0]?.min ?? source.defaultMin)}
            value={overrideMin}
            onChange={(e) => setOverrideMin(e.target.value)}
          />
          <input
            type="number"
            placeholder={String(rows[0]?.max ?? source.defaultMax)}
            value={overrideMax}
            onChange={(e) => setOverrideMax(e.target.value)}
          />
        </label>
        <span className="analysis-hint">{limitSource}</span>
      </div>

      {worst && Number.isFinite(Math.max(worst.lowFrac, worst.highFrac)) && (
        <div className="readout-headline">
          <span className="readout-big">{fmtPct(Math.max(worst.lowFrac, worst.highFrac))}%</span>
          <span className="readout-cap">
            most-saturated channel ({worst.field}), {active.length} channel{active.length === 1 ? '' : 's'} driven
          </span>
        </div>
      )}

      <div className="thruster-bars">
        {active.map((r) => {
          const span = r.max - r.min || 1;
          const clamp = (v: number) => Math.max(0, Math.min(100, ((v - r.min) / span) * 100));
          const lo = clamp(r.stats!.min);
          const hi = clamp(r.stats!.max);
          const mean = clamp(r.stats!.mean);
          const off = Number.isFinite(groupMean) ? r.stats!.mean - groupMean : NaN;
          return (
            <div className="thruster-bar-row" key={r.field}>
              <span className="thruster-ch">{r.field}</span>
              <div className="thruster-track" title={`${fmtNum(r.min)}..${fmtNum(r.max)}`}>
                <div className="thruster-span" style={{ left: `${lo}%`, width: `${Math.max(0.5, hi - lo)}%` }} />
                <div className="thruster-mean" style={{ left: `${mean}%` }} />
              </div>
              <span className="thruster-val">{fmtNum(r.stats!.mean)}</span>
              <span className={`thruster-off${Math.abs(off) > 0.05 * span ? ' readout-warn' : ''}`}>
                {Number.isFinite(off) ? `${off >= 0 ? '+' : ''}${fmtNum(off)}` : '—'}
              </span>
            </div>
          );
        })}
      </div>

      <table className="table analysis-table">
        <thead>
          <tr>
            <th>channel</th>
            <th>n</th>
            <th>mean</th>
            <th>min</th>
            <th>max</th>
            <th>σ</th>
            <th>at low %</th>
            <th>at high %</th>
            <th>vs group</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field} className={r.idle ? 'thruster-idle' : ''}>
              <td className="k">{r.field}</td>
              {r.stats ? (
                <>
                  <td>{r.stats.count}</td>
                  <td>{fmtNum(r.stats.mean)}</td>
                  <td>{fmtNum(r.stats.min)}</td>
                  <td>{fmtNum(r.stats.max)}</td>
                  <td>{fmtNum(r.stats.std, 1)}</td>
                  {/* An undriven channel reads as 100% against its low limit;
                      that is not saturation, so it is neither shown nor flagged. */}
                  <td className={!r.idle && r.lowFrac > 0.05 ? 'readout-warn' : ''}>{r.idle ? '—' : fmtPct(r.lowFrac)}</td>
                  <td className={!r.idle && r.highFrac > 0.05 ? 'readout-warn' : ''}>{r.idle ? '—' : fmtPct(r.highFrac)}</td>
                  <td>
                    {r.idle
                      ? 'not driven'
                      : Number.isFinite(groupMean)
                        ? `${r.stats.mean - groupMean >= 0 ? '+' : ''}${fmtNum(r.stats.mean - groupMean)}`
                        : '—'}
                  </td>
                </>
              ) : (
                <td className="v" colSpan={8}>
                  no samples in window
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {anyOutOfBounds && (
        <p className="analysis-hint readout-warn">
          Some channels ran past the assumed limits, so the saturation percentages are understated — set the real{' '}
          {source.paramPrefix}n_MIN/MAX above.
        </p>
      )}

      <p className="analysis-note">
        {source.kind === 'output'
          ? 'Which channel drives which thruster depends on SERVOn_FUNCTION, which is not read here — the numbers are per output channel, not per motor.'
          : 'These are the pilot’s stick inputs, not what the autopilot did with them; which stick is which depends on RCMAP.'}{' '}
        A channel that never moves is shown greyed as not driven.
      </p>
    </div>
  );
}
