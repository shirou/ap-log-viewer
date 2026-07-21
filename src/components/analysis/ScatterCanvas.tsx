import { useEffect, useRef } from 'react';
import { PALETTES, cssVar } from '../../lib/plotTheme.ts';
import type { Theme } from '../../store/logStore.ts';

interface Props {
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
  theme: Theme;
  /** Force equal px-per-unit on both axes so a true circle reads as a circle. */
  equalAspect?: boolean;
  /** Fitted circle to overlay (mag hard-iron). Its bounds and the origin are kept in view. */
  overlayCircle?: { cx: number; cy: number; r: number } | null;
  /** Fitted line to overlay (scatter-fit presets). */
  fitLine?: { slope: number; intercept: number } | null;
  xLabel?: string;
  yLabel?: string;
  height?: number;
}

const PAD = 38;

/**
 * A field-vs-field scatter drawn on a raw canvas rather than uPlot.
 *
 * uPlot's x and y scales are independent, so a geometric circle would render as
 * an ellipse — fatal for a diagnostic whose whole point is the shape of the
 * locus. A canvas lets us pin equal aspect and overlay the fitted circle/line
 * directly. The component is field-agnostic; the callers supply the meaning.
 */
export default function ScatterCanvas({
  xs,
  ys,
  theme,
  equalAspect,
  overlayCircle,
  fitLine,
  xLabel,
  yLabel,
  height = 320,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const cssW = wrap.clientWidth || 320;
      const cssH = height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const axis = cssVar('--plot-axis', '#8290a3');
      const grid = cssVar('--plot-grid', '#2a334060');
      const point = PALETTES[theme][2];
      const accent = PALETTES[theme][3];

      const n = Math.min(xs.length, ys.length);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (overlayCircle) {
        minX = Math.min(minX, overlayCircle.cx - overlayCircle.r, 0);
        maxX = Math.max(maxX, overlayCircle.cx + overlayCircle.r, 0);
        minY = Math.min(minY, overlayCircle.cy - overlayCircle.r, 0);
        maxY = Math.max(maxY, overlayCircle.cy + overlayCircle.r, 0);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
        // Nothing to plot: draw the frame + a note rather than a blank box.
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        ctx.strokeRect(PAD, PAD, cssW - PAD * 2, cssH - PAD * 2);
        ctx.fillStyle = axis;
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('no samples in window', cssW / 2, cssH / 2);
        return;
      }

      let spanX = maxX - minX || 1;
      let spanY = maxY - minY || 1;
      minX -= spanX * 0.08;
      maxX += spanX * 0.08;
      minY -= spanY * 0.08;
      maxY += spanY * 0.08;
      spanX = maxX - minX;
      spanY = maxY - minY;

      const plotW = cssW - PAD * 2;
      const plotH = cssH - PAD * 2;
      let sx = plotW / spanX;
      let sy = plotH / spanY;
      if (equalAspect) {
        const s = Math.min(sx, sy);
        sx = s;
        sy = s;
      }
      const offX = PAD + (plotW - sx * spanX) / 2;
      const offY = PAD + (plotH - sy * spanY) / 2;
      const px = (x: number) => offX + (x - minX) * sx;
      const py = (y: number) => cssH - (offY + (y - minY) * sy);

      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD, PAD, plotW, plotH);

      // Origin cross, when 0 is in view.
      if (0 >= minX && 0 <= maxX && 0 >= minY && 0 <= maxY) {
        ctx.strokeStyle = axis;
        ctx.beginPath();
        ctx.moveTo(px(0), PAD);
        ctx.lineTo(px(0), cssH - PAD);
        ctx.moveTo(PAD, py(0));
        ctx.lineTo(cssW - PAD, py(0));
        ctx.stroke();
      }

      // Points; stride for very dense clouds so drawing stays cheap.
      const stride = Math.max(1, Math.floor(n / 6000));
      ctx.fillStyle = point;
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < n; i += stride) {
        const x = xs[i];
        const y = ys[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        ctx.beginPath();
        ctx.arc(px(x), py(y), 1.8, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (overlayCircle) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let a = 0; a <= 96; a++) {
          const t = (a / 96) * 2 * Math.PI;
          const x = px(overlayCircle.cx + overlayCircle.r * Math.cos(t));
          const y = py(overlayCircle.cy + overlayCircle.r * Math.sin(t));
          if (a === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(px(overlayCircle.cx), py(overlayCircle.cy), 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }

      if (fitLine && Number.isFinite(fitLine.slope) && Number.isFinite(fitLine.intercept)) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(px(minX), py(fitLine.slope * minX + fitLine.intercept));
        ctx.lineTo(px(maxX), py(fitLine.slope * maxX + fitLine.intercept));
        ctx.stroke();
      }

      ctx.fillStyle = axis;
      ctx.font = '11px system-ui, sans-serif';
      if (xLabel) {
        ctx.textAlign = 'right';
        ctx.fillText(xLabel, cssW - PAD, cssH - 8);
      }
      if (yLabel) {
        ctx.save();
        ctx.translate(12, PAD);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'right';
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [xs, ys, theme, equalAspect, overlayCircle, fitLine, xLabel, yLabel, height]);

  return (
    <div className="mag-scatter" ref={wrapRef} style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
