import { useEffect, useRef } from 'react';
import { selectDisplayTime, useLogStore } from '../store/logStore.ts';
import { formatDuration, rangeValueAtX } from '../lib/series.ts';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

// Width of the scrub thumb, needed to map pointer x to a time. index.css pins
// it (browser defaults differ) and publishes it as --scrub-thumb; read it from
// there so the two can't drift. The fallback only matters if the CSS is absent.
const FALLBACK_THUMB_PX = 16;
function readThumbPx(el: HTMLElement): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue('--scrub-thumb'));
  return Number.isFinite(v) && v > 0 ? v : FALLBACK_THUMB_PX;
}

export default function Timeline() {
  const log = useLogStore((s) => s.log);
  const cursorTime = useLogStore((s) => s.cursorTime);
  const displayTime = useLogStore(selectDisplayTime);
  const setCursorTime = useLogStore((s) => s.setCursorTime);
  const hoverTime = useLogStore((s) => s.hoverTime);
  const setHoverTime = useLogStore((s) => s.setHoverTime);
  const playing = useLogStore((s) => s.playing);
  const togglePlaying = useLogStore((s) => s.togglePlaying);
  const setPlaying = useLogStore((s) => s.setPlaying);
  const speed = useLogStore((s) => s.speed);
  const setSpeed = useLogStore((s) => s.setSpeed);
  const stepMode = useLogStore((s) => s.stepMode);
  const setStepMode = useLogStore((s) => s.setStepMode);
  const stepIntervalSec = useLogStore((s) => s.stepIntervalSec);
  const setStepIntervalSec = useLogStore((s) => s.setStepIntervalSec);
  const loop = useLogStore((s) => s.loop);
  const setLoop = useLogStore((s) => s.setLoop);
  // Measured once per mount: the thumb is a pseudo-element, so it can't be
  // measured off the DOM, and its width is fixed by CSS anyway.
  const thumbRef = useRef<number | null>(null);

  // Playback driver. Continuous = real-time × speed via rAF.
  // Interval = jump forward `stepIntervalSec` of log-time on each tick.
  useEffect(() => {
    if (!playing || !log) return;
    const { startTime, endTime } = log;

    const span = Math.max(1, endTime - startTime);

    const advance = (deltaMicros: number) => {
      const st = useLogStore.getState();
      let next = st.cursorTime + deltaMicros;
      if (next >= endTime) {
        if (st.loop) {
          // Modulo the span so a large delta (e.g. after a backgrounded tab)
          // wraps correctly instead of sticking at the end.
          next = startTime + ((next - startTime) % span);
        } else {
          setCursorTime(endTime);
          setPlaying(false);
          return false;
        }
      }
      setCursorTime(next);
      return true;
    };

    if (stepMode === 'continuous') {
      let raf = 0;
      let last = performance.now();
      const tick = (now: number) => {
        const dt = (now - last) / 1000; // seconds
        last = now;
        if (advance(dt * speed * 1e6)) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    // Interval mode: advance `stepIntervalSec` of log-time once per real second.
    const id = setInterval(() => advance(stepIntervalSec * 1e6), 1000);
    return () => clearInterval(id);
  }, [playing, log, stepMode, speed, stepIntervalSec, setCursorTime, setPlaying]);

  if (!log) return null;
  const span = Math.max(1, log.endTime - log.startTime);
  const step = span / 1000;
  // Hover only previews while paused (see selectDisplayTime), so the readout
  // must not advertise a preview that nothing is showing.
  const previewing = !playing && hoverTime != null;

  // Hovering the scrub previews that instant across the views without seeking.
  const onScrubHover = (e: React.PointerEvent<HTMLInputElement>) => {
    if (e.pointerType !== 'mouse') return; // touch/pen: dragging already seeks
    const el = e.currentTarget;
    thumbRef.current ??= readThumbPx(el);
    // Snap to the same `step` the input itself uses, so the previewed time and
    // the time a click here would commit are identical, not merely close.
    setHoverTime(
      rangeValueAtX(e.clientX, el.getBoundingClientRect(), log.startTime, log.endTime, step, thumbRef.current),
    );
  };

  return (
    <div className="timeline">
      <button className="primary" onClick={togglePlaying} style={{ minWidth: 64 }}>
        {playing ? '⏸ Pause' : '▶ Play'}
      </button>

      <input
        className="scrub"
        type="range"
        min={log.startTime}
        max={log.endTime}
        step={step}
        value={cursorTime}
        onChange={(e) => setCursorTime(Number(e.target.value))}
        onPointerMove={onScrubHover}
        onPointerLeave={() => setHoverTime(null)}
        onPointerCancel={() => setHoverTime(null)}
      />

      <span
        className={previewing ? 'time preview' : 'time'}
        title={previewing ? 'Previewing the hovered instant — release to return to the playhead' : undefined}
      >
        {formatDuration(displayTime - log.startTime)} / {formatDuration(span)}
      </span>

      <label>
        mode
        <select value={stepMode} onChange={(e) => setStepMode(e.target.value as 'continuous' | 'interval')}>
          <option value="continuous">continuous</option>
          <option value="interval">interval</option>
        </select>
      </label>

      {stepMode === 'continuous' ? (
        <label>
          speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                ×{s}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label title="log-seconds advanced per real second">
          step
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={stepIntervalSec}
            style={{ width: 64 }}
            onChange={(e) => setStepIntervalSec(Math.max(0.1, Number(e.target.value)))}
          />
          s/s
        </label>
      )}

      <label>
        <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
        loop
      </label>
    </div>
  );
}
