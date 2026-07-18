import { useEffect, useRef } from 'react';
import { selectDisplayTime, selectPreviewTime, useLogStore } from '../store/logStore.ts';
import { formatDuration, rangeValueAtX } from '../lib/series.ts';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

// PageUp/PageDown jump this many scrub steps; arrows move one.
const PAGE_STEPS = 25;

export default function Timeline() {
  const log = useLogStore((s) => s.log);
  const cursorTime = useLogStore((s) => s.cursorTime);
  const displayTime = useLogStore(selectDisplayTime);
  const setCursorTime = useLogStore((s) => s.setCursorTime);
  const previewTime = useLogStore(selectPreviewTime);
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
  // The track is the mapping surface: pointer x is resolved against its measured
  // rect, so nothing has to assume how the control is drawn.
  const trackRef = useRef<HTMLDivElement>(null);
  // True from pointerdown until release: the pointer is seeking, not browsing,
  // so no preview is recorded and the playhead stays authoritative.
  const seekingRef = useRef(false);

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
  const previewing = previewTime != null;

  const timeAtX = (clientX: number): number | null => {
    const track = trackRef.current;
    if (!track) return null;
    return rangeValueAtX(clientX, track.getBoundingClientRect(), log.startTime, log.endTime, step);
  };

  // Pressing anywhere on the scrub seeks there and starts a drag. Capturing the
  // pointer keeps the drag tracking even when it wanders off the control.
  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = timeAtX(e.clientX);
    if (t == null) return;
    seekingRef.current = true;
    setHoverTime(null); // the seek is the intent now; a preview would fight it
    e.currentTarget.setPointerCapture(e.pointerId);
    setCursorTime(t);
  };

  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = timeAtX(e.clientX);
    if (t == null) return;
    if (seekingRef.current) {
      setCursorTime(t);
      return;
    }
    if (playing) return; // a preview here would be ignored; don't record one
    if (e.pointerType !== 'mouse') return; // touch/pen: pressing already seeks
    setHoverTime(t);
  };

  const endSeek = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return;
    seekingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Arrow/Home/End seek from the keyboard. Any such seek drops a preview left
  // behind by a pointer resting on the scrub, which would otherwise keep every
  // view showing the old instant and make the keypress look ignored.
  const onScrubKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const seekTo = (t: number) => {
      e.preventDefault();
      setHoverTime(null);
      setCursorTime(t); // clamped by the store
    };
    const by = (d: number) => seekTo(cursorTime + d);
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        return by(step);
      case 'ArrowLeft':
      case 'ArrowDown':
        return by(-step);
      case 'PageUp':
        return by(step * PAGE_STEPS);
      case 'PageDown':
        return by(-step * PAGE_STEPS);
      case 'Home':
        return seekTo(log.startTime);
      case 'End':
        return seekTo(log.endTime);
    }
  };

  const pct = ((cursorTime - log.startTime) / span) * 100;
  // Where the preview sits, so the scrub itself shows what is being previewed.
  const previewPct = previewTime == null ? null : ((previewTime - log.startTime) / span) * 100;

  return (
    <div className="timeline">
      {/* Wide enough for "⏸ Pause", the longer label: at 64px the button grew on
          play and shoved the scrub 12px sideways, moving the thumb under a
          resting pointer. */}
      <button className="primary" onClick={togglePlaying} style={{ minWidth: 84 }}>
        {playing ? '⏸ Pause' : '▶ Play'}
      </button>

      {/* A custom slider rather than <input type="range">: hover, click and drag
          all resolve pointer x against the track's measured rect, so a preview
          and the seek it becomes cannot disagree. */}
      <div
        className="scrub"
        role="slider"
        tabIndex={0}
        aria-label="Timeline position"
        aria-valuemin={log.startTime}
        aria-valuemax={log.endTime}
        aria-valuenow={cursorTime}
        aria-valuetext={`${formatDuration(cursorTime - log.startTime)} of ${formatDuration(span)}`}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={endSeek}
        onPointerCancel={(e) => {
          endSeek(e);
          setHoverTime(null);
        }}
        onPointerLeave={() => {
          if (!seekingRef.current) setHoverTime(null);
        }}
        // Capture is released for reasons beyond our pointerup — the element
        // going away, the browser cancelling it. Without this the seek flag
        // could stick and silently kill hovering for the rest of the session.
        onLostPointerCapture={() => {
          seekingRef.current = false;
        }}
        onKeyDown={onScrubKey}
      >
        <div className="scrub-track" ref={trackRef}>
          <div className="scrub-fill" style={{ width: `${pct}%` }} />
          {previewPct != null && <div className="scrub-preview" style={{ left: `${previewPct}%` }} />}
          <div className="scrub-thumb" style={{ left: `${pct}%` }} />
        </div>
      </div>

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
