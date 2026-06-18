import { useEffect } from 'react';
import { useLogStore } from '../store/logStore.ts';
import { formatDuration } from '../lib/series.ts';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export default function Timeline() {
  const log = useLogStore((s) => s.log);
  const cursorTime = useLogStore((s) => s.cursorTime);
  const setCursorTime = useLogStore((s) => s.setCursorTime);
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
        step={span / 1000}
        value={cursorTime}
        onChange={(e) => setCursorTime(Number(e.target.value))}
      />

      <span className="time">
        {formatDuration(cursorTime - log.startTime)} / {formatDuration(span)}
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
