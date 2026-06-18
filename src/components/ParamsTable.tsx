import { useMemo, useState } from 'react';
import { useLogStore } from '../store/logStore.ts';

export default function ParamsTable() {
  const log = useLogStore((s) => s.log);
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    if (!log) return [];
    const entries = Object.entries(log.params).sort((a, b) => a[0].localeCompare(b[0]));
    if (!filter) return entries;
    const f = filter.toUpperCase();
    return entries.filter(([k]) => k.toUpperCase().includes(f));
  }, [log, filter]);

  if (!log) return null;

  return (
    <div>
      <input className="search" placeholder="Search parameters…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {rows.length === 0 ? (
        <p style={{ padding: 10, color: 'var(--muted)' }}>No parameters</p>
      ) : (
        <table className="table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="k">{k}</td>
                <td className="v">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
