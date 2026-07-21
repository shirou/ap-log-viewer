import { useEffect, useMemo, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore.ts';
import { detectMagSources } from '../lib/analysisSources.ts';
import { getColumn } from '../lib/signal.ts';
import { fieldKey, type FieldRef } from '../model/log.ts';
import IntervalBrush from './analysis/IntervalBrush.tsx';
import WindowStatsTable from './analysis/WindowStatsTable.tsx';
import CompassAnalysis from './analysis/CompassAnalysis.tsx';

type ModuleId = 'stats' | 'compass';

const TIME_FIELD = 'TimeUS';

export default function AnalysisModal({ onClose }: { onClose: () => void }) {
  const log = useLogStore((s) => s.log);
  const theme = useLogStore((s) => s.theme);
  const selectedFields = useLogStore((s) => s.selectedFields);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [tab, setTab] = useState<ModuleId>('stats');

  // Show it as a true modal so Esc, focus-trap, the top layer and ::backdrop
  // all come from the platform.
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  const magSources = useMemo(() => (log ? detectMagSources(log.messages) : []), [log]);

  // The signal shown in the brush: a magnetometer axis reads as a clean sinusoid
  // during a rotation, which is exactly what a user is trying to locate; failing
  // that, the first plotted field, else any numeric column.
  const brush = useMemo(() => {
    if (!log) return null;
    const candidates: FieldRef[] = [];
    if (magSources[0]) candidates.push({ message: magSources[0].message, field: magSources[0].xField });
    candidates.push(...selectedFields);
    for (const m of Object.values(log.messages)) {
      const f = Object.keys(m.fields).find((k) => k !== TIME_FIELD);
      if (f) {
        candidates.push({ message: m.name, field: f });
        break;
      }
    }
    for (const ref of candidates) {
      const col = getColumn(log, ref);
      if (col && col.time.length > 0) return { ref, time: col.time, values: col.values };
    }
    return null;
  }, [log, magSources, selectedFields]);

  // Stable array identity so WindowStatsTable's memos don't re-run every render.
  const magFields = useMemo<FieldRef[]>(() => {
    const s = magSources[0];
    return s
      ? [
          { message: s.message, field: s.xField },
          { message: s.message, field: s.yField },
          { message: s.message, field: s.zField },
        ]
      : [];
  }, [magSources]);

  if (!log) return null;

  const modules: { id: ModuleId; label: string; available: boolean }[] = [
    { id: 'stats', label: 'Window stats', available: true },
    { id: 'compass', label: 'Compass', available: magSources.length > 0 },
  ];

  const close = () => dialogRef.current?.close();
  const setBound = (which: 0 | 1, secStr: string) => {
    const sec = parseFloat(secStr);
    if (!Number.isFinite(sec)) return;
    // Round to integer µs so a value like 0.1s doesn't land a fraction off an
    // integer timestamp and drop a boundary sample when slicing.
    const us = Math.max(log.startTime, Math.min(log.endTime, Math.round(log.startTime + sec * 1e6)));
    const cur = range ?? [log.startTime, log.endTime];
    const next: [number, number] = which === 0 ? [us, cur[1]] : [cur[0], us];
    setRange([Math.min(next[0], next[1]), Math.max(next[0], next[1])]);
  };
  const sec = (us: number) => ((us - log.startTime) / 1e6).toFixed(1);

  return (
    <dialog
      ref={dialogRef}
      className="analysis-modal"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) close();
      }}
    >
      <div className="analysis-inner">
        <header className="analysis-head">
          <h2>Analysis</h2>
          <span className="analysis-sub">{log.source.toUpperCase()}</span>
          <div className="spacer" />
          <button className="analysis-close" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>

        {brush ? (
          <div className="interval-controls">
            <IntervalBrush
              time={brush.time}
              values={brush.values}
              startTime={log.startTime}
              theme={theme}
              range={range}
              onChange={setRange}
              label={fieldKey(brush.ref)}
            />
            <div className="interval-row">
              <label>
                start
                <input type="number" step="0.1" value={range ? sec(range[0]) : ''} onChange={(e) => setBound(0, e.target.value)} />
                s
              </label>
              <label>
                end
                <input type="number" step="0.1" value={range ? sec(range[1]) : ''} onChange={(e) => setBound(1, e.target.value)} />
                s
              </label>
              <span className="interval-dur">{range ? `Δ ${((range[1] - range[0]) / 1e6).toFixed(1)}s` : 'no interval — drag to select'}</span>
              <button onClick={() => setRange([log.startTime, log.endTime])}>Full range</button>
              <button onClick={() => setRange(null)} disabled={!range}>
                Clear
              </button>
            </div>
          </div>
        ) : (
          <p className="analysis-hint">No plottable data to select an interval from.</p>
        )}

        {/* A button group, not an ARIA tablist: only the active module is mounted
            in one swapped panel, which the tab/tabpanel contract (one panel per
            tab) doesn't fit. aria-pressed conveys the active module instead. */}
        <div className="analysis-tabs" role="group" aria-label="Analysis modules">
          {modules.map((m) => (
            <button
              key={m.id}
              aria-pressed={tab === m.id}
              disabled={!m.available}
              className={tab === m.id ? 'active' : ''}
              onClick={() => setTab(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="analysis-body">
          {tab === 'stats' && <WindowStatsTable range={range} extraFields={magFields} />}
          {tab === 'compass' && magSources.length > 0 && <CompassAnalysis range={range} />}
        </div>
      </div>
    </dialog>
  );
}
