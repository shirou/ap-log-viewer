import { useMemo, useState } from 'react';
import { useLogStore } from '../store/logStore.ts';
import { fieldKey } from '../model/log.ts';

export default function FieldTree() {
  const log = useLogStore((s) => s.log);
  const selectedFields = useLogStore((s) => s.selectedFields);
  const toggleField = useLogStore((s) => s.toggleField);
  const purgeMessage = useLogStore((s) => s.purgeMessage);
  const purgeUnselected = useLogStore((s) => s.purgeUnselected);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');

  const selected = useMemo(() => new Set(selectedFields.map(fieldKey)), [selectedFields]);

  const messages = useMemo(() => {
    if (!log) return [];
    const list = Object.values(log.messages).filter((m) => Object.keys(m.fields).length > 0);
    list.sort((a, b) => a.name.localeCompare(b.name));
    if (!filter) return list;
    const f = filter.toLowerCase();
    return list.filter((m) => m.name.toLowerCase().includes(f));
  }, [log, filter]);

  if (!log) return null;

  const total = Object.keys(log.messages).length;
  const purgeableCount = Object.keys(log.messages).filter(
    (n) => !selectedFields.some((r) => r.message === n),
  ).length;

  return (
    <div>
      <input
        className="search"
        placeholder="Search messages…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="tree-toolbar">
        <span className="count">{total} types</span>
        <button
          disabled={purgeableCount === 0}
          title="Remove messages with no plotted series from memory to reduce usage"
          onClick={() => {
            if (confirm(`Remove ${purgeableCount} unselected message types. Are you sure?`)) purgeUnselected();
          }}
        >
          Remove unselected ({purgeableCount})
        </button>
      </div>
      {messages.map((m) => {
        const fields = Object.keys(m.fields).filter((f) => f !== 'TimeUS');
        const isOpen = open[m.name] ?? false;
        return (
          <div className="tree-msg" key={m.name}>
            <div className="tree-row" onClick={() => setOpen((o) => ({ ...o, [m.name]: !isOpen }))}>
              <span>
                {isOpen ? '▾' : '▸'} {m.name}
              </span>
              <span className="row-right">
                <span className="count">{m.time.length.toLocaleString()}</span>
                <button
                  className="purge"
                  title={`Remove ${m.name} from memory`}
                  onClick={(e) => {
                    e.stopPropagation();
                    purgeMessage(m.name);
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
            {isOpen &&
              fields.map((f) => {
                const key = `${m.name}.${f}`;
                const isSel = selected.has(key);
                return (
                  <div
                    className={`tree-field${isSel ? ' selected' : ''}`}
                    key={f}
                    onClick={() => toggleField({ message: m.name, field: f })}
                  >
                    <input type="checkbox" readOnly checked={isSel} />
                    {f}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
