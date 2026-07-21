import { useCallback, useEffect, useMemo, useRef } from 'react';
import type uPlot from 'uplot';
import { useUplot } from '../../hooks/useUplot.ts';
import { PALETTES, cssVar } from '../../lib/plotTheme.ts';
import type { Theme } from '../../store/logStore.ts';

interface Props {
  /** Whole-log timestamps (µs) of the signal shown for orientation. */
  time: Float64Array;
  values: Float64Array;
  startTime: number;
  theme: Theme;
  range: [number, number] | null;
  onChange: (r: [number, number]) => void;
  label: string;
}

/**
 * A thin time-series strip whose drag selects the analysis interval.
 *
 * `drag.setScale = false` keeps the drag from zooming (unlike the main plot); the
 * drag only reports [t0, t1] µs back via `onChange`, and the band reflects
 * `range` (so Full-range / Clear / the numeric inputs stay in sync). uPlot clears
 * its own selection box on a stray click WITHOUT firing setSelect, which would
 * leave the band gone while the interval stayed active — so we re-assert the band
 * from state on mouseup, keeping what's shown and what's stored as one.
 */
export default function IntervalBrush({ time, values, startTime, theme, range, onChange, label }: Props) {
  const xs = useMemo(() => {
    const a = new Float64Array(time.length);
    for (let i = 0; i < time.length; i++) a[i] = (time[i] - startTime) / 1e6;
    return a;
  }, [time, startTime]);

  // Read the latest onChange/range without rebuilding the plot every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const color = PALETTES[theme][0];

  // Apply the stored range to uPlot's selection band (null = clear it).
  const applyBand = useCallback(
    (u: uPlot) => {
      const r = rangeRef.current;
      if (!r) {
        u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        return;
      }
      const left = u.valToPos((r[0] - startTime) / 1e6, 'x');
      const right = u.valToPos((r[1] - startTime) / 1e6, 'x');
      u.setSelect({ left, top: 0, width: Math.max(0, right - left), height: u.over.clientHeight }, false);
    },
    [startTime],
  );

  const { containerRef, plotRef } = useUplot(
    () => ({
      data: [xs, values] as unknown as uPlot.AlignedData,
      options: {
        scales: { x: { time: false } },
        legend: { show: false },
        cursor: { drag: { x: true, y: false, setScale: false } },
        axes: [
          {
            stroke: cssVar('--plot-axis', '#8290a3'),
            grid: { stroke: cssVar('--plot-grid', '#2a334060') },
            values: (_u, vals) => vals.map((v) => `${v}s`),
          },
          { show: false },
        ],
        series: [{}, { stroke: color, width: 1, points: { show: false }, spanGaps: true }],
        hooks: {
          setSelect: [
            (u: uPlot) => {
              if (u.select.width <= 0) return;
              // Round to integer µs: log timestamps are integers, and a fractional
              // bound just above one would exclude that boundary sample.
              const t0 = Math.round(startTime + u.posToVal(u.select.left, 'x') * 1e6);
              const t1 = Math.round(startTime + u.posToVal(u.select.left + u.select.width, 'x') * 1e6);
              onChangeRef.current([Math.min(t0, t1), Math.max(t0, t1)]);
            },
          ],
        },
      },
    }),
    [xs, values, color],
  );

  // Reflect the stored range into the band (buttons / numeric inputs / rebuilds).
  useEffect(() => {
    const u = plotRef.current;
    if (u) applyBand(u);
  }, [range, applyBand, plotRef, xs, values, color]);

  // A stray click clears uPlot's box without firing setSelect; restore the band
  // from state after the pointer settles (rAF, so it runs after uPlot's handler).
  // Only ever restores a band — a genuine Clear (range → null) goes through the
  // sync effect above, so this never wipes a selection.
  useEffect(() => {
    const u = plotRef.current;
    if (!u) return;
    const onUp = () => requestAnimationFrame(() => plotRef.current === u && rangeRef.current && applyBand(u));
    u.over.addEventListener('mouseup', onUp);
    return () => u.over.removeEventListener('mouseup', onUp);
  }, [applyBand, plotRef, xs, values, color]);

  return (
    <div className="interval-brush">
      <div className="interval-brush-label">{label}</div>
      <div className="interval-brush-plot" ref={containerRef} style={{ height: 96 }} />
    </div>
  );
}
