import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { selectDisplayTime, useLogStore } from '../store/logStore.ts';
import { fieldKey, type FieldRef, type LogData } from '../model/log.ts';
import { assignAxes, extentOf, type AxisAssignment, type AxisSide, type Col } from '../lib/axisGroups.ts';
import { nearestSampleIndex } from '../lib/series.ts';
import { elapsedTicks, formatElapsed } from '../lib/format.ts';
import { PALETTES, cssVar } from '../lib/plotTheme.ts';
import PlotDownload from './PlotDownload.tsx';

// How long the cursor must rest before the value tooltip appears. Without this
// delay the tooltip would flicker on every pixel of mouse movement.
const TOOLTIP_DELAY_MS = 250;

/**
 * Marker geometry, in CSS pixels (scaled by pxRatio when drawn).
 *
 * The two annotations are deliberately unequal. A command is something someone
 * did to the vehicle, so it gets weight, a flag and a full name down the plot; a
 * mission step is the vehicle reporting its own progress, and there are far more
 * of them, so it gets a hairline and a two-character tag by the axis. Reading
 * the plot should never cost a second look to tell which is which.
 */
const MARK_PX = {
  /** Half-width of the flag at the top of a command marker. */
  flag: 4,
  /** How far that flag hangs below the top of the plot. */
  flagDrop: 6,
  /** Smallest gap between two labelled markers; closer ones go unlabelled. */
  labelGap: 18,
  /** Gap between a marker and the label beside it. */
  labelInset: 5,
  fontSize: 11,
  /** Mission tags are shorter, so they can sit closer before they collide. */
  stepLabelGap: 6,
  stepFontSize: 10,
  /** How far a mission tag sits above the x axis. */
  stepLabelLift: 4,
} as const;

function fmtVal(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  // Keep small fractions readable without trailing-zero noise.
  return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * One series as its own message logged it, before the merge onto a common x.
 *
 * Kept alongside the merged columns because those columns are null wherever the
 * series' message did not sample, and the tooltip has to answer for an instant
 * that almost always belongs to some other message. Both arrays are the log's
 * own, held by reference — no copy.
 */
interface Samples {
  /** Raw timestamps, the same domain as `Merged.times`. */
  time: Float64Array;
  values: Float64Array;
}

interface Merged {
  data: uPlot.AlignedData;
  labels: string[];
  /** Raw timestamps behind `data[0]`, which holds seconds since log start. */
  times: Float64Array;
  /** One entry per `labels` entry. */
  samples: Samples[];
  /**
   * True when every series was already on one time array, so no merge happened
   * and an x index addresses all of them directly.
   *
   * Worth knowing because a timestamp does not identify a sample there: a
   * message with no time column inherits the last one seen, so several of its
   * samples can share a stamp, and a search would answer with the last of the
   * run whichever one the cursor is on.
   */
  sharedTime: boolean;
}

interface Built extends Merged {
  /** Left/right assignment, one entry per `labels` entry. */
  axes: AxisAssignment;
}

/** Marks which axis a series is drawn against. Shape, not colour, so it survives glare. */
const GLYPH = ['◀', '▶'] as const;

/**
 * One annotation, placed on the plot's x domain (seconds since log start).
 *
 * In time order, which the model guarantees (`LogData.commands` and
 * `missionSteps` are sorted by their parsers) and which the left-to-right label
 * layout below depends on.
 */
interface Mark {
  sec: number;
  label: string;
}

/** `text` trimmed with an ellipsis until it fits `maxWidth`, measured in `ctx`. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut--;
  return `${text.slice(0, cut)}…`;
}

/**
 * The marks currently on screen, as canvas x positions.
 *
 * This runs on every redraw, which during playback is once per animation frame,
 * so a plain scan looks wasteful — `rangeIndices` would give the visible run by
 * binary search instead. It is not worth the parallel array it would need to be
 * fed: at 18000 marks, far more than any real log carries, the scan costs 0.6 ms
 * of a 16.7 ms frame, and what a search cannot avoid is the drawing.
 *
 * Everything downstream works in canvas pixels — `bbox` and `valToPos(..., true)`
 * both do — which is why the CSS-pixel constants in MARK_PX are scaled by
 * `pxRatio` wherever they are used.
 */
function visibleMarks(u: uPlot, marks: Mark[]): Array<{ x: number; label: string }> {
  const { min, max } = u.scales.x;
  if (marks.length === 0 || min == null || max == null) return [];
  const out: Array<{ x: number; label: string }> = [];
  for (const m of marks) {
    if (m.sec < min || m.sec > max) continue;
    // Half-pixel offset so a 1-device-pixel line lands on a pixel rather than
    // straddling two and coming out grey.
    out.push({ x: Math.round(u.valToPos(m.sec, 'x', true)) + 0.5, label: m.label });
  }
  return out;
}

/** Clip drawing to the plot rect, so a marker cannot spill over the axes. */
function clipToPlot(u: uPlot): void {
  const { left, top, width, height } = u.bbox;
  u.ctx.beginPath();
  u.ctx.rect(left, top, width, height);
  u.ctx.clip();
}

/**
 * Vertical markers where a command was sent to the vehicle.
 *
 * Dashed, flagged and labelled rather than merely coloured: the series palette
 * has seven entries and any hue picked here could end up next to a curve wearing
 * something close to it, whereas nothing else on the plot is a full-height
 * dashed line.
 */
function drawCommands(u: uPlot, marks: Mark[], stroke: string, halo: string): void {
  const visible = visibleMarks(u, marks);
  if (visible.length === 0) return;
  const r = uPlot.pxRatio;
  const { top: by, height: bh } = u.bbox;
  const ctx = u.ctx;

  ctx.save();
  clipToPlot(u);

  // Lines first, then flags and labels, so the dash pattern is set once.
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5 * r;
  ctx.setLineDash([5 * r, 4 * r]);
  ctx.beginPath();
  for (const v of visible) {
    ctx.moveTo(v.x, by);
    ctx.lineTo(v.x, by + bh);
  }
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = stroke;
  ctx.beginPath();
  for (const v of visible) {
    ctx.moveTo(v.x - MARK_PX.flag * r, by);
    ctx.lineTo(v.x + MARK_PX.flag * r, by);
    ctx.lineTo(v.x, by + MARK_PX.flagDrop * r);
    ctx.closePath();
  }
  ctx.fill();

  // Labels run top-to-bottom beside their marker. On a long flight they crowd
  // far past legibility, so they are laid down left to right and any that would
  // land on the previous one is skipped — zooming in brings it back.
  ctx.font = `${MARK_PX.fontSize * r}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 * r;
  ctx.strokeStyle = halo;
  const room = bh - (MARK_PX.flagDrop + 4) * r;
  let labelledTo = -Infinity;
  for (const v of visible) {
    if (v.x - labelledTo < MARK_PX.labelGap * r) continue;
    labelledTo = v.x;
    const text = ellipsize(ctx, v.label, room);
    ctx.save();
    ctx.translate(v.x + MARK_PX.labelInset * r, by + (MARK_PX.flagDrop + 2) * r);
    ctx.rotate(Math.PI / 2);
    // Haloed against the plot background: the label crosses whatever series
    // happen to run under it, and unbacked text there is unreadable.
    ctx.strokeText(text, 0, 0);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Hairline markers where the vehicle moved on to the next item of its plan.
 *
 * Held well below the command markers on purpose. These are frequent — a survey
 * pattern steps through its waypoints dozens of times an hour — and they are
 * context for reading the curves rather than events in their own right, so they
 * are a fine dash in the axis colour, with no flag and a short `3` tag sitting
 * on the baseline instead of a name written down the plot.
 */
function drawMissionSteps(u: uPlot, marks: Mark[], stroke: string, halo: string): void {
  const visible = visibleMarks(u, marks);
  if (visible.length === 0) return;
  const r = uPlot.pxRatio;
  const { top: by, height: bh } = u.bbox;
  const ctx = u.ctx;

  ctx.save();
  clipToPlot(u);

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1 * r;
  ctx.setLineDash([3 * r, 4 * r]);
  ctx.beginPath();
  for (const v of visible) {
    ctx.moveTo(v.x, by);
    ctx.lineTo(v.x, by + bh);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Tags are laid down left to right like the command labels, but measured:
  // they vary in width (`3` against `12`) and are close enough together that a
  // fixed gap would either overlap or drop tags that would have fitted.
  ctx.font = `${MARK_PX.stepFontSize * r}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 * r;
  ctx.strokeStyle = halo;
  ctx.fillStyle = stroke;
  const y = by + bh - MARK_PX.stepLabelLift * r;
  let labelledTo = -Infinity;
  for (const v of visible) {
    const x = v.x + MARK_PX.labelInset * r;
    if (x - labelledTo < MARK_PX.stepLabelGap * r) continue;
    labelledTo = x + ctx.measureText(v.label).width;
    ctx.strokeText(v.label, x, y);
    ctx.fillText(v.label, x, y);
  }
  ctx.restore();
}

/**
 * The x window in seconds when the plot is actually zoomed, otherwise null.
 *
 * Un-zoomed, uPlot leaves `scales.x` sitting on the data extremes, so the numbers
 * alone cannot say whether the reader narrowed anything. The x scale's default
 * range is `snapNumX`, which — unlike the y scales — adds no padding, so the
 * comparison against the data ends is exact.
 *
 * Shared by the teardown that carries a zoom across a rebuild and the hook that
 * reports the window to the store, so the two can never disagree about what
 * counts as zoomed.
 */
function zoomedSeconds(u: uPlot): { min: number; max: number } | null {
  const { min, max } = u.scales.x;
  const data = u.data[0];
  if (!data || data.length === 0 || min == null || max == null) return null;
  const first = data[0] as number;
  const last = data[data.length - 1] as number;
  return min > first || max < last ? { min, max } : null;
}

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

  if (series.length === 0) {
    return { data: [new Float64Array(0)], labels: [], times: new Float64Array(0), samples: [], sharedTime: true };
  }

  const labelsOf = () => series.map((s) => fieldKey(s.ref));
  const samplesOf = () => series.map((s) => ({ time: s.time, values: s.values }));

  // Fast path: when every selected field comes from the same message they share
  // one time array, so no merge is needed. This also preserves samples that
  // share a timestamp, which the union path below necessarily collapses.
  if (series.every((s) => s.time === series[0].time)) {
    const t0 = series[0].time;
    const xs = new Float64Array(t0.length);
    for (let i = 0; i < t0.length; i++) xs[i] = (t0[i] - log.startTime) / 1e6;
    const data: (Float64Array | (number | null)[])[] = [xs, ...series.map((s) => s.values)];
    return {
      data: data as unknown as uPlot.AlignedData,
      labels: labelsOf(),
      times: t0,
      samples: samplesOf(),
      sharedTime: true,
    };
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
  return {
    data: data as unknown as uPlot.AlignedData,
    labels,
    times: Float64Array.from(merged),
    samples: samplesOf(),
    sharedTime: false,
  };
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
  // Written, never read here: PlotDownload subscribes to the result instead, so
  // a zoom re-renders that component and leaves this one — and the uPlot instance
  // it owns — alone.
  const setViewRange = useLogStore((s) => s.setViewRange);
  const theme = useLogStore((s) => s.theme);
  const palette = PALETTES[theme];

  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Live cursor position in seconds-since-start, read by the draw hook.
  const cursorSecRef = useRef(0);
  // Annotation layers on/off. Held as refs as well so toggling one only redraws
  // the canvas instead of tearing the plot down and building it again.
  const [showCommands, setShowCommands] = useState(true);
  const showCommandsRef = useRef(showCommands);
  const [showSteps, setShowSteps] = useState(true);
  const showStepsRef = useRef(showSteps);
  // A zoom carried across a plot rebuild, so a cosmetic edit — moving a series
  // to the other axis, adding one — does not throw the view away. Tagged with
  // `loadId`, not the LogData: purging a message makes a new log object without
  // changing what is on screen, and holding the old one would keep every purged
  // message's samples alive, which is the whole point of purging.
  const xViewRef = useRef<{ loadId: number; min: number; max: number } | null>(null);

  const merged = useMemo(() => (log ? buildData(log, selectedFields) : null), [log, selectedFields]);

  // Annotations on the plot's own x domain. A .bin carries no commands at all,
  // and a log that flew no mission carries no steps, so either can be empty and
  // the layer then simply never appears.
  const commands = useMemo<Mark[]>(
    () => (log ? log.commands.map((c) => ({ sec: (c.time - log.startTime) / 1e6, label: c.name })) : []),
    [log],
  );
  const steps = useMemo<Mark[]>(
    () => (log ? log.missionSteps.map((s) => ({ sec: (s.time - log.startTime) / 1e6, label: String(s.seq) })) : []),
    [log],
  );

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
      // The instant to report every series at. uPlot's idx points into the
      // merged x, whose timestamps are the union of the selected messages'.
      const rawT = built.times[idx];
      // Built as nodes rather than an HTML string. Series labels are message
      // and column names copied verbatim out of the log's own FMT records
      // (src/parsers/dataflash.ts), so a crafted file can put anything it likes
      // in one — through innerHTML that is script execution on hover, and
      // opening files you did not write is the whole point of this app.
      // Two decimals, where the axis and the timeline readout show one: this is
      // the precision readout, and a series sampled at 50 Hz has several samples
      // inside a tenth of a second.
      tooltip.replaceChildren(span('tt-time', formatElapsed(t, 2)));
      built.labels.forEach((label, i) => {
        const row = document.createElement('div');
        row.className = 'tt-row';
        const dot = span('tt-dot', '');
        dot.style.background = palette[i % palette.length];
        row.append(dot);
        // With two scales the same pixel height means different things per row,
        // so say which axis each value was read against.
        if (built.axes.split) row.append(span('tt-axis', GLYPH[built.axes.side[i]]));
        // Read from the series' own samples rather than from its merged column.
        // That column is null at every timestamp the series' message did not
        // log, which is most of them once two messages are on screen, so
        // reading it left every row blank but the one series whose sample the
        // cursor had landed on. The axis split separates series by range, which
        // in practice means by message, which is why the blanks came out
        // looking like one whole side of the plot.
        //
        // Unmerged, the cursor's index already is the sample index — see
        // `sharedTime` for why the search must not be used there.
        const s = built.samples[i];
        const j = built.sharedTime ? idx : nearestSampleIndex(s.time, rawT);
        row.append(span('tt-label', label), span('tt-val', fmtVal(j == null ? null : s.values[j])));
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
    const commandStroke = cssVar('--plot-command', '#ff5470');
    const stepStroke = cssVar('--plot-mission', '#8290a3');
    const markHalo = cssVar('--plot-bg', '#0e1116');

    const usesLeft = built.axes.side.some((s) => s === 0);
    const usesRight = built.axes.split;

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: el.clientHeight || 240,
      scales: { x: { time: false }, ...(usesRight ? { y2: {} } : {}) },
      axes: [
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke },
          values: (_u, vals, _axisIdx, _foundSpace, foundIncr) => elapsedTicks(vals, foundIncr),
          // m:ss is wider than the bare seconds this replaced, and h:mm:ss wider
          // again; without the extra room uPlot thins the ticks out to fit.
          space: 70,
        },
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
        // Report the window on screen, so the download control can offer it.
        // Fires once per scale that actually changed, which includes y and y2
        // autoscaling — hence the key test — and once on the first commit.
        //
        // Nothing here may call back into uPlot: this runs from inside _commit,
        // where a setScale would queue a commit the one in progress then drops
        // (the same trap the carried zoom below works around). Writing to the
        // store is safe because the control that reads it is a separate
        // component, so nothing here re-renders.
        setScale: [
          (u, key) => {
            if (key !== 'x') return;
            const z = zoomedSeconds(u);
            if (!z) return setViewRange(null);
            // Back to absolute microseconds, and rounded here because this is
            // where float seconds stop being float: a dragged edge is an arbitrary
            // value out of posToVal, rangeIndices compares both ends inclusively,
            // and the store's dedup compares the numbers — two drags landing on
            // the same microsecond should not count as a new window.
            // AnalysisModal.setBound rounds for the same reason.
            setViewRange([
              Math.round(log.startTime + z.min * 1e6),
              Math.round(log.startTime + z.max * 1e6),
            ]);
          },
        ],
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
        draw: [
          // Annotations go down before the playhead, quietest first, so the
          // stacking order matches how loudly each one is meant to read.
          (u) => {
            if (showStepsRef.current) drawMissionSteps(u, steps, stepStroke, markHalo);
            if (showCommandsRef.current) drawCommands(u, commands, commandStroke, markHalo);
          },
          // Vertical line marking the timeline cursor.
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
      const z = zoomedSeconds(u);
      xViewRef.current = z ? { loadId, min: z.min, max: z.max } : null;
      u.destroy();
      plotRef.current = null;
      // Don't strand a preview if the plot goes away mid-hover (fields cleared,
      // theme switched); every view would keep showing that instant.
      setHoverTime(null);
    };
  }, [built, log, loadId, commands, steps, setCursorTime, setHoverTime, setViewRange, palette]);

  // With nothing selected there is no plot and no window, so the last one
  // reported has to go — the download control would otherwise keep offering a
  // range nothing on screen shows.
  //
  // Deliberately not done from the plot effect's teardown: that also runs before
  // every *rebuild* (a new series, an axis flip, a theme switch), and the
  // replacement plot only reports its window from a microtask, so clearing there
  // would blink the control off and on again each time.
  useEffect(() => {
    if (selectedFields.length === 0) setViewRange(null);
  }, [selectedFields.length, setViewRange]);

  // Toggling a layer only changes what the canvas draws, so redraw rather than
  // letting the flag rebuild the plot (which would also drop the zoom).
  useEffect(() => {
    showCommandsRef.current = showCommands;
    showStepsRef.current = showSteps;
    plotRef.current?.redraw(false, false);
  }, [showCommands, showSteps]);

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
        <span className="plot-hint">x: time from start (m:ss) · drag to zoom</span>
        {selectedFields.length > 0 && (
          <button className="chip" onClick={resetZoom} title="Reset zoom to full range (double-click also works)">
            ⤢ Reset
          </button>
        )}
        {selectedFields.length > 0 && <PlotDownload />}
        {/* Offered only when the log has commands to show: a .bin never does,
            and a dead toggle would read as "this log has none plotted" rather
            than "this kind of log cannot carry them". */}
        {commands.length > 0 && selectedFields.length > 0 && (
          <button
            className="chip"
            aria-pressed={showCommands}
            onClick={() => setShowCommands((v) => !v)}
            title={
              showCommands
                ? 'Commands sent to the vehicle are marked — click to hide them'
                : 'Show a marker where each command was sent to the vehicle'
            }
          >
            {showCommands ? '◆' : '◇'} {commands.length} command{commands.length === 1 ? '' : 's'}
          </button>
        )}
        {steps.length > 0 && selectedFields.length > 0 && (
          <button
            className="chip chip-quiet"
            aria-pressed={showSteps}
            onClick={() => setShowSteps((v) => !v)}
            title={
              showSteps
                ? 'Each move to the next mission item is marked — click to hide them'
                : 'Show a marker where the vehicle moved to the next mission item'
            }
          >
            {showSteps ? '┆' : '·'} {steps.length} mission step{steps.length === 1 ? '' : 's'}
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
