import { useEffect, useRef } from 'react';
import type { DependencyList } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface UplotHandle {
  containerRef: React.RefObject<HTMLDivElement | null>;
  plotRef: React.RefObject<uPlot | null>;
}

/**
 * Build and tear down a uPlot inside a container div, sized to it and rebuilt
 * only when `deps` change.
 *
 * The analysis modal can hold several plots that mount and unmount as the user
 * switches modules; centralizing the new/destroy/ResizeObserver dance here keeps
 * each of them from re-deriving PlotPanel's lifecycle and leaking a canvas or an
 * observer on the way out. `build` receives the measured size, so a plot created
 * after the dialog has laid out reads a real width rather than the 600px default.
 */
export function useUplot(
  build: (width: number, height: number) => { options: Omit<uPlot.Options, 'width' | 'height'>; data: uPlot.AlignedData },
  deps: DependencyList,
): UplotHandle {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const width = el.clientWidth || 600;
    const height = el.clientHeight || 160;
    const { options, data } = build(width, height);
    const u = new uPlot({ ...options, width, height }, data, el);
    plotRef.current = u;
    const ro = new ResizeObserver(() => {
      // A zero is never propagated: a panel that is momentarily unmeasurable
      // would otherwise collapse the plot to nothing, and resizing it back is
      // not something the observer will be asked to do again. The old fallback
      // to the creation-time size had the same effect more quietly, pinning the
      // plot to a stale width.
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) u.setSize({ width: w, height: h });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
    // `build` is intentionally excluded: it closes over the current deps, and
    // rebuilding is driven by `deps` so the plot is not recreated every render.
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return { containerRef, plotRef };
}
