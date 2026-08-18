import { useLogStore } from '../store/logStore.ts';
import { ALL_SOURCES, sourceKey, type SourceInfo } from '../model/log.ts';

/**
 * `SURFACE_BOAT` -> `Surface boat`.
 *
 * The dialect's SHOUTING is right for a constant and wrong for a control a
 * reader scans, and these sit next to file names and message counts.
 */
function pretty(name: string): string {
  const s = name.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * How to say which thing a source is.
 *
 * The MAV_TYPE is the useful half — "Surface boat" against "Gcs" is the whole
 * question a reader has. The component name only earns its place when the type
 * does not already answer it, which in practice means telling two ground
 * stations apart: the sample log has a Mission Planner and a second GCS that
 * both announce `GCS`.
 */
function describe(s: SourceInfo): string {
  const type = s.typeLabel ? pretty(s.typeLabel) : null;
  const comp = s.compLabel ? pretty(s.compLabel) : null;
  if (type && comp && comp.toLowerCase() !== type.toLowerCase()) return `${type} · ${comp}`;
  return type ?? comp ?? 'Unknown';
}

/**
 * Which MAVLink source the rest of the app is showing.
 *
 * Sits where the message-type count used to, because that is what it replaces
 * and because the choice is global: the plot, map, params, messages, timeline
 * and analysis all follow it. Downloads deliberately do not — a slice is a cut
 * of the file, not of the view — which DownloadModal says in its own words.
 *
 * A .bin has no sources to choose between, so it keeps the old readout.
 */
export default function SourceSelect() {
  const log = useLogStore((s) => s.log);
  const parsed = useLogStore((s) => s.parsed);
  const selection = useLogStore((s) => s.selection);
  const setSelection = useLogStore((s) => s.setSelection);
  if (!log || !parsed) return null;

  // Counted from the data as it stands, not from a number recorded at parse
  // time: purging drops types, and a frozen count would keep advertising them.
  const typesIn = (key: string) => Object.keys(parsed.bySource.get(key)?.messages ?? {}).length;
  const allTypes = new Set<string>();
  for (const d of parsed.bySource.values()) for (const n of Object.keys(d.messages)) allTypes.add(n);

  if (log.sources.length === 0) {
    return (
      <span className="file">
        {log.source.toUpperCase()} · {allTypes.size} msg types
      </span>
    );
  }

  return (
    <select
      className="source-select"
      aria-label="MAVLink source"
      title="Which vehicle or ground station to show"
      value={selection}
      onChange={(e) => setSelection(e.target.value)}
    >
      <option value={ALL_SOURCES}>All sources · {allTypes.size} types</option>
      {log.sources.map((s) => {
        const key = sourceKey(s);
        return (
          <option key={key} value={key}>
            {key} {describe(s)} · {typesIn(key)} types · {s.records.toLocaleString()} rec
          </option>
        );
      })}
    </select>
  );
}
