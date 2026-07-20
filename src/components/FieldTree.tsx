import { useMemo, useState } from 'react';
import { useLogStore } from '../store/logStore.ts';
import { fieldKey } from '../model/log.ts';
import { parseQuery, searchMessages } from '../lib/fieldSearch.ts';

/**
 * `text` with the first occurrence of `term` marked.
 *
 * Message and field names come verbatim out of the log file's own format
 * records, so they are attacker-controlled; rendering them as React text nodes
 * escapes them. Never reach for dangerouslySetInnerHTML here.
 */
function Highlight({ text, term }: { text: string; term: string }) {
  const i = term ? text.toLowerCase().indexOf(term) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length)}
    </>
  );
}

export default function FieldTree() {
  const log = useLogStore((s) => s.log);
  const selectedFields = useLogStore((s) => s.selectedFields);
  const toggleField = useLogStore((s) => s.toggleField);
  const purgeMessage = useLogStore((s) => s.purgeMessage);
  const purgeUnselected = useLogStore((s) => s.purgeUnselected);
  const [filter, setFilter] = useState('');
  // Two maps rather than one, because a search opens messages on its own: a
  // single map would carry "I collapsed this" across to the next query, where
  // the message would come back collapsed on top of a hit for no visible
  // reason. The search map is dropped whenever the term changes, so browsing
  // expansions survive a search and search expansions do not outlive it.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState<Record<string, boolean>>({});

  const selected = useMemo(() => new Set(selectedFields.map(fieldKey)), [selectedFields]);

  const query = useMemo(() => parseQuery(filter), [filter]);
  const messages = useMemo(() => (log ? searchMessages(log.messages, filter) : []), [log, filter]);

  if (!log) return null;

  const total = Object.keys(log.messages).length;
  const purgeableCount = Object.keys(log.messages).filter(
    (n) => !selectedFields.some((r) => r.message === n),
  ).length;

  return (
    <div>
      <input
        className="search"
        placeholder="Search messages & fields (e.g. GPS.cog)"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setSearchOpen({});
        }}
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
      {messages.map(({ series: m, fields, hits, autoExpand }) => {
        // A message the search opened starts open, but the row still toggles.
        const isOpen = query ? (searchOpen[m.name] ?? autoExpand) : (open[m.name] ?? false);
        const setIsOpen = query ? setSearchOpen : setOpen;
        return (
          <div className="tree-msg" key={m.name}>
            <div className="tree-row" onClick={() => setIsOpen((o) => ({ ...o, [m.name]: !isOpen }))}>
              <span>
                {isOpen ? '▾' : '▸'} <Highlight text={m.name} term={query?.message ?? ''} />
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
                    {/* The row is a flex container, so the name needs its own
                        box — otherwise <mark> becomes a sibling flex item and
                        the gap splits the word ("G | Crs"). */}
                    <span>{hits.has(f) ? <Highlight text={f} term={query?.field ?? ''} /> : f}</span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
