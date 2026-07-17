import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { selectDisplayTime, useLogStore } from '../store/logStore.ts';
import { fieldKey, type FieldRef, type LogData } from '../model/log.ts';

// Series colours per theme. The light set is darker/more saturated so the lines
// keep enough contrast against a white plot in daylight.
const PALETTES = {
  dark: ['#4fd1c5', '#f6ad55', '#63b3ed', '#fc8181', '#b794f4', '#68d391', '#f687b3'],
  light: ['#0a6e66', '#b45309', '#1d4ed8', '#c2262d', '#6d28d9', '#15803d', '#be185d'],
} as const;

// Read a CSS custom property off <html>, falling back when unavailable (SSR/tests).
function cssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// How long the cursor must rest before the value tooltip appears. Without this
// delay the tooltip would flicker on every pixel of mouse movement.
const TOOLTIP_DELAY_MS = 250;

function fmtVal(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  // Keep small fractions readable without trailing-zero noise.
  return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
}

interface Built {
  data: uPlot.AlignedData;
  labels: string[];
}

// Merge selected series onto a common x-axis (seconds since log start), filling
// gaps with null where a series has no sample. Each message's time array is
// already sorted, so we k-way merge them.
function buildData(log: LogData, fields: FieldRef[]): Built {
  const series = fields
    .map((ref) => {
      const m = log.messages[ref.message];
      const values = m?.fields[ref.field];
      return values ? { ref, time: m.time, values } : null;
    })
    .filter((s): s is { ref: FieldRef; time: Float64Array; values: Float64Array } => s !== null);

  if (series.length === 0) return { data: [new Float64Array(0)], labels: [] };

  const labelsOf = () => series.map((s) => fieldKey(s.ref));

  // Fast path: when every selected field comes from the same message they share
  // one time array, so no merge is needed. This also preserves samples that
  // share a timestamp, which the union path below necessarily collapses.
  if (series.every((s) => s.time === series[0].time)) {
    const t0 = series[0].time;
    const xs = new Float64Array(t0.length);
    for (let i = 0; i < t0.length; i++) xs[i] = (t0[i] - log.startTime) / 1e6;
    const data: (Float64Array | (number | null)[])[] = [xs, ...series.map((s) => s.values)];
    return { data: data as unknown as uPlot.AlignedData, labels: labelsOf() };
  }

  // Union of all timestamps.
  const ptrs = new Array(series.length).fill(0);
  const merged: number[] = [];
  for (;;) {
    let min = Infinity;
    for (let i = 0; i < series.length; i++) {
      const p = ptrs[i];
      if (p < series[i].time.length) min = Math.min(min, series[i].time[p]);
    }
    if (!Number.isFinite(min)) break;
    merged.push(min);
    for (let i = 0; i < series.length; i++) {
      while (ptrs[i] < series[i].time.length && series[i].time[ptrs[i]] === min) ptrs[i]++;
    }
  }

  const xs = new Float64Array(merged.length);
  for (let i = 0; i < merged.length; i++) xs[i] = (merged[i] - log.startTime) / 1e6;

  const data: (Float64Array | (number | null)[])[] = [xs];
  const labels: string[] = [];
  for (const s of series) {
    const col: (number | null)[] = new Array(merged.length).fill(null);
    let mi = 0;
    for (let i = 0; i < s.time.length; i++) {
      const t = s.time[i];
      while (mi < merged.length && merged[mi] < t) mi++;
      if (mi < merged.length && merged[mi] === t) col[mi] = s.values[i];
    }
    data.push(col);
    labels.push(fieldKey(s.ref));
  }
  return { data: data as unknown as uPlot.AlignedData, labels };
}

export default function PlotPanel() {
  const log = useLogStore((s) => s.log);
  const selectedFields = useLogStore((s) => s.selectedFields);
  const toggleField = useLogStore((s) => s.toggleField);
  const displayTime = useLogStore(selectDisplayTime);
  const setCursorTime = useLogStore((s) => s.setCursorTime);
  const theme = useLogStore((s) => s.theme);
  const palette = PALETTES[theme];

  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Live cursor position in seconds-since-start, read by the draw hook.
  const cursorSecRef = useRef(0);

  const built = useMemo(() => (log ? buildData(log, selectedFields) : null), [log, selectedFields]);

  // (Re)create the plot when the data shape changes.
  useEffect(() => {
    if (!wrapRef.current || !built || !log) return;
    const el = wrapRef.current;

    // Floating tooltip that appears after the cursor rests on the plot.
    const tooltip = document.createElement('div');
    tooltip.className = 'plot-tooltip';
    tooltip.style.display = 'none';
    el.appendChild(tooltip);

    let tipTimer: number | undefined;
    const hideTip = () => {
      if (tipTimer !== undefined) {
        clearTimeout(tipTimer);
        tipTimer = undefined;
      }
      tooltip.style.display = 'none';
    };
    const showTip = (u: uPlot) => {
      const idx = u.cursor.idx;
      const left = u.cursor.left ?? -1;
      const top = u.cursor.top ?? -1;
      if (idx == null || left < 0 || top < 0) return;
      const xs = u.data[0];
      const t = xs[idx] as number;
      const rows = built.labels
        .map((label, i) => {
          const v = u.data[i + 1]?.[idx];
          const color = palette[i % palette.length];
          return `<div class="tt-row"><span class="tt-dot" style="background:${color}"></span><span class="tt-label">${label}</span><span class="tt-val">${fmtVal(v)}</span></div>`;
        })
        .join('');
      tooltip.innerHTML = `<div class="tt-time">${fmtVal(t)}s</div>${rows}`;
      tooltip.style.display = 'block';
      // Place near the cursor, flipping left/up when close to the edges.
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      let x = left + 14;
      let y = top + 14;
      if (x + tw > u.bbox.width / devicePixelRatio) x = left - tw - 14;
      if (y + th > u.bbox.height / devicePixelRatio) y = top - th - 14;
      tooltip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
    };

    const axisStroke = cssVar('--plot-axis', '#8290a3');
    const gridStroke = cssVar('--plot-grid', '#2a334060');
    const cursorStroke = cssVar('--plot-cursor', '#f6ad55');

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: el.clientHeight || 240,
      scales: { x: { time: false } },
      axes: [
        { stroke: axisStroke, grid: { stroke: gridStroke }, values: (_u, vals) => vals.map((v) => `${v}s`) },
        { stroke: axisStroke, grid: { stroke: gridStroke } },
      ],
      legend: { show: true },
      cursor: { drag: { x: true, y: false } },
      series: [
        { label: 't (s)' },
        ...built.labels.map((label, i) => ({
          label,
          stroke: palette[i % palette.length],
          width: 1.4,
          spanGaps: true,
          points: { show: false },
        })),
      ],
      hooks: {
        // Debounce the value tooltip: any cursor movement hides it and restarts
        // the timer, so it only surfaces once the pointer has settled.
        setCursor: [
          (u) => {
            hideTip();
            if (u.cursor.idx == null) return;
            tipTimer = window.setTimeout(() => {
              tipTimer = undefined;
              showTip(u);
            }, TOOLTIP_DELAY_MS);
          },
        ],
        // Vertical line marking the timeline cursor.
        draw: [
          (u) => {
            const xVal = cursorSecRef.current;
            const left = u.valToPos(xVal, 'x', true);
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = cursorStroke;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(left, u.bbox.top);
            ctx.lineTo(left, u.bbox.top + u.bbox.height);
            ctx.stroke();
            ctx.restore();
          },
        ],
        ready: [
          (u) => {
            // Click on the plot to seek the timeline. Ignore uPlot's idle cursor
            // sentinel (negative left) so a click without a prior hover doesn't
            // snap the timeline to 0.
            u.over.addEventListener('click', () => {
              const left = u.cursor.left ?? -1;
              if (left < 0) return;
              const sec = u.posToVal(left, 'x');
              if (Number.isFinite(sec)) setCursorTime(log.startTime + sec * 1e6);
            });
          },
        ],
      },
    };

    const u = new uPlot(opts, built.data, el);
    plotRef.current = u;

    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);

    return () => {
      hideTip();
      tooltip.remove();
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [built, log, setCursorTime, palette]);

  // Move the cursor line when the shared timeline changes (including to a
  // hovered preview, so the line never contradicts the map marker).
  useEffect(() => {
    if (!log) return;
    cursorSecRef.current = (displayTime - log.startTime) / 1e6;
    plotRef.current?.redraw(false, false);
  }, [displayTime, log]);

  // Reset a drag-zoom back to the full x range (same as uPlot's double-click).
  const resetZoom = () => {
    const u = plotRef.current;
    const xs = u?.data[0];
    if (u && xs && xs.length) u.setScale('x', { min: xs[0] as number, max: xs[xs.length - 1] as number });
  };

  return (
    <div className="plot-wrap">
      <div className="plot-header">
        <span className="plot-title">Time series</span>
        <span className="plot-hint">x: seconds from start · drag to zoom</span>
        {selectedFields.length > 0 && (
          <button className="chip" onClick={resetZoom} title="Reset zoom to full range (double-click also works)">
            ⤢ Reset
          </button>
        )}
        {selectedFields.map((r) => (
          <button
            key={fieldKey(r)}
            className="chip"
            title="Click to hide"
            onClick={() => toggleField(r)}
          >
            {fieldKey(r)} ✕
          </button>
        ))}
      </div>
      {selectedFields.length ? (
        <div className="plot-area" ref={wrapRef} />
      ) : (
        <div className="plot-empty">Select series from the Fields tab on the left to display them here</div>
      )}
    </div>
  );
}
