import { useLogStore } from '../store/logStore.ts';
import { ALL_SOURCES, sourceKey, type SourceInfo } from '../model/log.ts';
import { sourceOptions } from '../parsers/project.ts';

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
 * What a whole system is, said without naming one of the boxes on it.
 *
 * `describe` reaches for the component name when the MAV_TYPE does not already
 * answer the question, which is right for one address and wrong for a system:
 * a group labelled "Gcs · Autopilot1" claims to be a component it merely
 * contains.
 */
function describeSystem(s: SourceInfo): string {
  return s.typeLabel ? pretty(s.typeLabel) : 'Unknown';
}

/**
 * Which MAVLink source the rest of the app is showing.
 *
 * Sits where the message-type count used to, because that is what it replaces
 * and because the choice is global: the plot, map, params, messages, timeline
 * and analysis all follow it. Downloads deliberately do not — a slice is a cut
 * of the file, not of the view — which DownloadModal says in its own words.
 *
 * Two grains, listed together: a SYSID is one aircraft, and the COMPIDs under
 * it are the autopilot and whatever else is bolted on. The system comes first
 * and its components sit indented beneath it, so a reader who wants the vehicle
 * and a reader who wants one box on it both find their row without switching
 * modes. A system with a single component has no group row — merging one source
 * is the identity, and two rows that cannot differ are one row too many.
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
  const typesIn = (members: SourceInfo[]) => {
    const seen = new Set<string>();
    for (const m of members) {
      for (const n of Object.keys(parsed.bySource.get(sourceKey(m))?.messages ?? {})) seen.add(n);
    }
    return seen.size;
  };
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
      title="Which system, vehicle or ground station to show"
      value={selection}
      onChange={(e) => setSelection(e.target.value)}
    >
      <option value={ALL_SOURCES}>All sources · {allTypes.size} types</option>
      {sourceOptions(parsed).map((o) => {
        // U+3000 rather than spaces: HTML collapses runs of ASCII whitespace
        // inside an <option>, and the ideographic space is not one of them.
        const indent = o.indented ? '\u3000\u3000' : '';
        const head = o.group ? `sys ${o.primary.sysid}` : o.key;
        const what = o.group ? describeSystem(o.primary) : describe(o.primary);
        const comps = o.group ? ` · ${o.members.length} comp` : '';
        return (
          <option key={o.key} value={o.key}>
            {indent}{head} · {what}{comps} · {typesIn(o.members)} types · {o.records.toLocaleString()} rec
          </option>
        );
      })}
    </select>
  );
}
