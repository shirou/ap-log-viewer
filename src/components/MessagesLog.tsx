import { useLogStore } from '../store/logStore.ts';
import { formatDuration } from '../lib/series.ts';

export default function MessagesLog() {
  const log = useLogStore((s) => s.log);
  const setCursorTime = useLogStore((s) => s.setCursorTime);
  if (!log) return null;

  if (log.texts.length === 0 && log.modes.length === 0) {
    return <p style={{ padding: 10, color: 'var(--muted)' }}>No text/mode messages</p>;
  }

  const items = [
    ...log.modes.map((m) => ({ time: m.time, text: `▣ ${m.mode}`, mode: true })),
    ...log.texts.map((t) => ({ time: t.time, text: t.text, mode: false })),
  ].sort((a, b) => a.time - b.time);

  return (
    <div>
      {items.map((it, i) => (
        <div
          className="msg-row"
          key={i}
          onClick={() => setCursorTime(it.time)}
          style={{ cursor: 'pointer', color: it.mode ? 'var(--accent)' : undefined }}
        >
          <span className="t">{formatDuration(it.time - log.startTime)}</span>
          <span>{it.text}</span>
        </div>
      ))}
    </div>
  );
}
