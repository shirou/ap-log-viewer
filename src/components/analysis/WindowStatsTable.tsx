import { useMemo } from 'react';
import { useLogStore } from '../../store/logStore.ts';
import { getColumn } from '../../lib/signal.ts';
import { columnStats } from '../../lib/stats.ts';
import { rangeIndices } from '../../lib/series.ts';
import { fieldKey, type FieldRef } from '../../model/log.ts';

interface Props {
  range: [number, number] | null;
  /** Extra fields to include beyond the plotted selection (e.g. the mag triple). */
  extraFields: FieldRef[];
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000 || Number.isInteger(v)) return v.toFixed(0);
  return v.toPrecision(4);
}

/**
 * Windowed mean/σ/min/max/RMS/CV for the currently-plotted fields (plus any
 * extras). Every column is read through getColumn, so a stale ref the log has
 * no data for is skipped rather than throwing.
 */
export default function WindowStatsTable({ range, extraFields }: Props) {
  const log = useLogStore((s) => s.log);
  const selected = useLogStore((s) => s.selectedFields);

  const refs = useMemo(() => {
    const out: FieldRef[] = [];
    const seen = new Set<string>();
    for (const ref of [...selected, ...extraFields]) {
      const key = fieldKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
    return out;
  }, [selected, extraFields]);

  const rows = useMemo(() => {
    if (!log) return [];
    return refs.map((ref) => {
      const col = getColumn(log, ref);
      if (!col) return { ref, stats: null };
      const [i0, i1] = range ? rangeIndices(col.time, range[0], range[1]) : [0, col.values.length];
      return { ref, stats: columnStats(col.values, i0, i1) };
    });
  }, [log, refs, range]);

  if (!log) return null;

  return (
    <div className="analysis-stats">
      <p className="analysis-hint">
        {range ? 'Statistics over the selected interval.' : 'Whole log — drag on the strip above to limit to an interval.'}
      </p>
      {refs.length === 0 ? (
        <p className="analysis-hint">Select fields in the Fields tab to see their windowed statistics here.</p>
      ) : (
        <table className="table analysis-table">
          <thead>
            <tr>
              <th>field</th>
              <th>n</th>
              <th>mean</th>
              <th>min</th>
              <th>max</th>
              <th>σ</th>
              <th>rms</th>
              <th>cv%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ ref, stats }) => (
              <tr key={fieldKey(ref)}>
                <td className="k">{fieldKey(ref)}</td>
                {stats ? (
                  <>
                    <td>{stats.count}</td>
                    <td>{fmt(stats.mean)}</td>
                    <td>{fmt(stats.min)}</td>
                    <td>{fmt(stats.max)}</td>
                    <td>{fmt(stats.std)}</td>
                    <td>{fmt(stats.rms)}</td>
                    <td>{Number.isFinite(stats.cv) ? (stats.cv * 100).toFixed(1) : '—'}</td>
                  </>
                ) : (
                  <td className="v" colSpan={7}>
                    no samples in window
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
