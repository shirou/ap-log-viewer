import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { selectDisplayTime, useLogStore } from '../store/logStore.ts';
import { fieldKey, type FieldRef, type LogData } from '../model/log.ts';
import { assignAxes, extentOf, type AxisAssignment, type AxisSide, type Col } from '../lib/axisGroups.ts';

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

interface Merged {
  data: uPlot.AlignedData;
  labels: string[];
}

interface Built extends Merged {
  /** Left/right assignment, one entry per `labels` entry. */
  axes: AxisAssignment;
}

/** Marks which axis a series is drawn against. Shape, not colour, so it survives glare. */
const GLYPH = ['◀', '▶'] as const;

/** A tooltip cell. Text goes in as text, never as markup — see showTip. */
function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

// Merge selected series onto a common x-axis (seconds since log start), filling
// gaps with null where a series has no sample. Each message's time array is
// already sorted, so we k-way merge them.
function buildData(log: LogData, fields: FieldRef[]): Merged {
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
  const loadId = useLogStore((s) => s.loadId);
  const selectedFields = useLogStore((s) => s.selectedFields);
  const toggleField = useLogStore((s) => s.toggleField);
  const axisOverride = useLogStore((s) => s.axisOverride);
  const setAxisOverride = useLogStore((s) => s.setAxisOverride);
  const displayTime = useLogStore(selectDisplayTime);
  const setCursorTime = useLogStore((s) => s.setCursorTime);
  const setHoverTime = useLogStore((s) => s.setHoverTime);
  const theme = useLogStore((s) => s.theme);
  const palette = PALETTES[theme];

  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Live cursor position in seconds-since-start, read by the draw hook.
  const cursorSecRef = useRef(0);
  // A zoom carried across a plot rebuild, so a cosmetic edit — moving a series
  // to the other axis, adding one — does not throw the view away. Tagged with
  // `loadId`, not the LogData: purging a message makes a new log object without
  // changing what is on screen, and holding the old one would keep every purged
  // message's samples alive, which is the whole point of purging.
  const xViewRef = useRef<{ loadId: number; min: number; max: number } | null>(null);

  const merged = useMemo(() => (log ? buildData(log, selectedFields) : null), [log, selectedFields]);

  // Scanning the columns is the expensive half and depends only on the data, so
  // it is kept off the override's memo — otherwise every ◀/▶ click would re-walk
  // every sample in the log to flip one flag.
  const extents = useMemo(() => (merged ? merged.data.slice(1).map((c) => extentOf(c as Col)) : []), [merged]);

  const built = useMemo<Built | null>(
    () => (merged ? { ...merged, axes: assignAxes(extents, merged.labels.map((l) => axisOverride[l])) } : null),
    [merged, extents, axisOverride],
  );

  // Axis side by field key. The chips iterate `selectedFields`, but `buildData`
  // drops refs the log has no column for, so a position in `selectedFields`
  // indexes neither `built.labels` nor `built.axes.side`. Keys always do.
  const sideByKey = useMemo(() => {
    const m = new Map<string, AxisSide>();
    built?.labels.forEach((label, i) => m.set(label, built.axes.side[i]));
    return m;
  }, [built]);

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
      // Built as nodes rather than an HTML string. Series labels are message
      // and column names copied verbatim out of the log's own FMT records
      // (src/parsers/dataflash.ts), so a crafted file can put anything it likes
      // in one — through innerHTML that is script execution on hover, and
      // opening files you did not write is the whole point of this app.
      tooltip.replaceChildren(span('tt-time', `${fmtVal(t)}s`));
      built.labels.forEach((label, i) => {
        const row = document.createElement('div');
        row.className = 'tt-row';
        const dot = span('tt-dot', '');
        dot.style.background = palette[i % palette.length];
        row.append(dot);
        // With two scales the same pixel height means different things per row,
        // so say which axis each value was read against.
        if (built.axes.split) row.append(span('tt-axis', GLYPH[built.axes.side[i]]));
        row.append(span('tt-label', label), span('tt-val', fmtVal(u.data[i + 1]?.[idx])));
        tooltip.append(row);
      });
      tooltip.style.display = 'block';
      // Place near the cursor, flipping left/up when close to the edges.
      //
      // `left`/`top` are measured from the corner of .u-over, which the axes
      // inset, while the tooltip is positioned from the corner of .plot-area.
      // The plot rect's own offset has to be added back or the tooltip is drawn
      // roughly an axis-width up and to the left of the cursor it describes.
      // bbox is in canvas pixels, so scale it by the ratio uPlot itself used.
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      const ox = u.bbox.left / uPlot.pxRatio;
      const oy = u.bbox.top / uPlot.pxRatio;
      let x = ox + left + 14;
      let y = oy + top + 14;
      // Flip against the box that actually clips the tooltip rather than the
      // plot rect, so it only moves out of the way when it would be cut off.
      if (x + tw > el.clientWidth) x = ox + left - tw - 14;
      if (y + th > el.clientHeight) y = oy + top - th - 14;
      tooltip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
    };

    const axisStroke = cssVar('--plot-axis', '#8290a3');
    const gridStroke = cssVar('--plot-grid', '#2a334060');
    const cursorStroke = cssVar('--plot-cursor', '#f6ad55');

    const usesLeft = built.axes.side.some((s) => s === 0);
    const usesRight = built.axes.split;

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: el.clientHeight || 240,
      scales: { x: { time: false }, ...(usesRight ? { y2: {} } : {}) },
      axes: [
        { stroke: axisStroke, grid: { stroke: gridStroke }, values: (_u, vals) => vals.map((v) => `${v}s`) },
        // A y axis is drawn only while something is on it: pinning every series
        // to one side is reachable from the chips, and the other axis would
        // otherwise be left ranging over a scale that never receives data.
        //
        // Both `scale` and `side` are spelled out, because uPlot defaults every
        // axis past the first to {scale: 'y', side: 3} — omit either on the
        // right axis and it lands on top of the left one. `grid` survives as a
        // partial thanks to uPlot's deep merge; a shallow one would drop the
        // default `show: true`.
        //
        // Only one axis draws the grid. The two scales range independently, so
        // a second set of lines would not align with the first and would read
        // as noise rather than as a second reference.
        ...(usesLeft ? [{ scale: 'y', side: 3 as uPlot.Axis.Side, stroke: axisStroke, grid: { stroke: gridStroke } }] : []),
        ...(usesRight
          ? [{ scale: 'y2', side: 1 as uPlot.Axis.Side, stroke: axisStroke, grid: { show: !usesLeft, stroke: gridStroke } }]
          : []),
      ],
      legend: { show: true },
      cursor: { drag: { x: true, y: false } },
      series: [
        { label: 't (s)' },
        // No ◀/▶ suffix on the label: uPlot hangs its legend below .u-wrap,
        // which `height` already fills, so .plot-wrap's overflow clips it away.
        // The chips and the tooltip carry the axis markers instead.
        ...built.labels.map((label, i) => ({
          label,
          scale: built.axes.side[i] === 1 ? 'y2' : 'y',
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
            // Preview the hovered instant across the other views. uPlot parks
            // the cursor at a negative offset when the pointer is away, which
            // is also how a redraw reports "not hovering" — either way there is
            // nothing to preview. Read `playing` live rather than closing over
            // it, so play/pause doesn't force the plot to be rebuilt.
            const left = u.cursor.left ?? -1;
            if (left < 0 || useLogStore.getState().playing) {
              setHoverTime(null);
            } else {
              const sec = u.posToVal(left, 'x');
              if (Number.isFinite(sec)) setHoverTime(log.startTime + sec * 1e6);
            }

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
            // setCursor already clears the preview when the pointer parks off
            // the plot, but not if the pointer leaves without a final move.
            u.over.addEventListener('mouseleave', () => setHoverTime(null));
          },
        ],
      },
    };

    const u = new uPlot(opts, built.data, el);
    plotRef.current = u;

    // Put back a carried zoom. This has to happen here and not from the `ready`
    // hook: uPlot fires that from inside _commit while its queuedCommit flag is
    // still set, so a setScale there queues a commit that is then dropped. The
    // constructor only schedules its first _commit on a microtask, so setting
    // the scale now lands in that same first draw.
    const kept = xViewRef.current;
    const xs = built.data[0];
    if (kept && kept.loadId === loadId && xs.length > 0) {
      // Clip to the new data: a different field can span a different stretch of
      // the flight, and uPlot applies an explicit range verbatim — a window
      // that misses the data entirely would leave the plot blank.
      const min = Math.max(kept.min, xs[0] as number);
      const max = Math.min(kept.max, xs[xs.length - 1] as number);
      if (min < max) u.setScale('x', { min, max });
    }

    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);

    return () => {
      hideTip();
      tooltip.remove();
      ro.disconnect();
      // Hand a zoom to whatever plot replaces this one. Only an actual zoom:
      // un-zoomed, uPlot leaves scales.x sitting on the data extremes, and
      // replaying those over a series covering a different stretch of the
      // flight would silently crop it with nothing to show a zoom is in effect.
      const { min, max } = u.scales.x;
      const data = u.data[0];
      const zoomed =
        data.length > 0 &&
        min != null &&
        max != null &&
        (min > (data[0] as number) || max < (data[data.length - 1] as number));
      xViewRef.current = zoomed ? { loadId, min: min as number, max: max as number } : null;
      u.destroy();
      plotRef.current = null;
      // Don't strand a preview if the plot goes away mid-hover (fields cleared,
      // theme switched); every view would keep showing that instant.
      setHoverTime(null);
    };
  }, [built, log, loadId, setCursorTime, setHoverTime, palette]);

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
        {selectedFields.map((r) => {
          const key = fieldKey(r);
          const side = sideByKey.get(key);
          const pinned = axisOverride[key] != null;
          return (
            // A span, not a button: the axis control below is a button of its
            // own, and nesting one inside another is invalid DOM whose inner
            // click would bubble straight into the hide handler.
            <span key={key} className="chip series-chip">
              {/* Offered whenever there is a second series to separate from,
                  not only once split — an automatic call that read the ranges
                  as compatible is exactly when overriding it is worth doing.
                  Counted over what is plotted, since a field the log has no
                  column for leaves nothing on screen to separate. */}
              {side !== undefined && sideByKey.size > 1 && (
                <button
                  className="chip-axis"
                  // Clicking a pinned series releases it rather than moving it,
                  // and it may well stay where it is, so the two states cannot
                  // share a description. aria-label overrides title as the
                  // accessible name, so it has to carry the distinction too.
                  aria-label={
                    pinned
                      ? `${key}: return to the automatic axis`
                      : `${key}: move to the ${side ? 'left' : 'right'} axis`
                  }
                  title={
                    pinned
                      ? `Pinned to the ${side ? 'right' : 'left'} axis — click to return it to automatic`
                      : `On the ${side ? 'right' : 'left'} axis — click to move it across`
                  }
                  onClick={() => setAxisOverride(key, pinned ? null : ((side ? 0 : 1) as AxisSide))}
                >
                  {GLYPH[side]}
                </button>
              )}
              <span className="chip-label">{key}</span>
              <button className="chip-hide" aria-label={`${key}: hide`} title="Click to hide" onClick={() => toggleField(r)}>
                ✕
              </button>
            </span>
          );
        })}
      </div>
      {selectedFields.length ? (
        <div className="plot-area" ref={wrapRef} />
      ) : (
        <div className="plot-empty">Select series from the Fields tab on the left to display them here</div>
      )}
    </div>
  );
}
