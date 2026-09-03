// Picking one MAVLink source out of a parsed log, or merging them all.
//
// The parsers hand back every source separately (`ParsedLog`); every view still
// wants the single `LogData` it has always been given. This module is the seam
// between the two, and the whole reason the split costs no memory: choosing a
// source hands back the arrays the parser already built, never a copy of them.
// Only `ALL_SOURCES` builds anything, and only for the message types more than
// one source actually sent — three of thirty-six on the sample log.
//
// A .bin arrives here as a single source filed under `ALL_SOURCES`, so it takes
// the merge path with one input, which is the identity. That is deliberate:
// one path, exercised by both formats.

import type {
  CommandEvent,
  LogData,
  MessageSeries,
  MissionStep,
  ModeChange,
  ParsedLog,
  SourceData,
  SourceInfo,
  TextMessage,
  Waypoint,
} from '../model/log.ts';
import { minimal } from 'mavlink-mappings';
import { ALL_SOURCES, groupKey, parseGroupKey, sourceKey } from '../model/log.ts';
import { EMPTY_TRAJECTORY, normalizeEvents } from './columnar.ts';
import { commandKey } from './tlog.ts';
import { kindFromMavType } from '../lib/vehicleModes.ts';

/**
 * Components a system needs before it earns a row of its own.
 *
 * Merging one source is the identity, so a one-component system's group row
 * would be a byte-for-byte copy of the row beneath it. Three places decide
 * whether a group exists — the opening selection, the selector's rows and the
 * projection's fallback — and they have to agree: a selector offering a row
 * that resolves to something else is worse than not offering it.
 */
const GROUP_MIN_COMPONENTS = 2;

/** True when this source's HEARTBEAT names something ArduPilot flies. */
function namesAVehicle(s: SourceInfo): boolean {
  return s.mavType !== undefined && kindFromMavType(s.mavType) !== null;
}

/**
 * The component a list of sources speaks for.
 *
 * Three tests, narrowest first, because each one alone gets a real log wrong:
 *
 *  - The busiest source is not always the vehicle. On the sample log an
 *    external GPS injector sends 36,720 frames; a quieter autopilot would lose.
 *  - "Not a ground station" lets a gimbal or an ADSB transponder win.
 *  - But a vehicle announcing MAV_TYPE_GENERIC passes neither of the first two,
 *    and picking nothing at all would leave the reader staring at a mixture.
 *
 * `sources` MUST be in records-descending order — what both parsers produce —
 * so the first match in each pass is the busiest of its class. Test two admits
 * a source that sent no HEARTBEAT at all: not announcing a type is not
 * announcing GCS. Undefined only for an empty list, which is a .bin.
 */
export function primaryOf(sources: SourceInfo[]): SourceInfo | undefined {
  return sources.find(namesAVehicle)
    ?? sources.find((s) => s.mavType !== minimal.MavType.GCS)
    ?? sources[0];
}

/**
 * The source to show when a log is first opened.
 *
 * The whole aircraft when it has more than one component, not just its
 * autopilot: a SYSID is one vehicle, and a reader opening a log wants the
 * vehicle rather than one of the boxes on it. A system with a single component
 * has no group row to choose, so it opens on the address as it always did.
 */
export function defaultSelection(parsed: ParsedLog): string {
  const primary = primaryOf(parsed.sources);
  if (!primary) return ALL_SOURCES;
  const siblings = parsed.sources.filter((s) => s.sysid === primary.sysid);
  return siblings.length >= GROUP_MIN_COMPONENTS ? groupKey(primary.sysid) : sourceKey(primary);
}

/** One row of the source selector: a whole system, or one address. */
export interface SourceOption {
  /** `<select>` value: a group key (`4/*`) or an address (`4/1`). */
  key: string;
  /** True when this row stands for a whole system rather than one address. */
  group: boolean;
  /** The addresses this row covers, most frames first. One for an address row. */
  members: SourceInfo[];
  /** The component that names this row — `primaryOf(members)`, not `members[0]`. */
  primary: SourceInfo;
  /** Frames across `members`. NOT `primary.records`, which is one component's. */
  records: number;
  /** True when this row sits under a group row above it. */
  indented: boolean;
}

/**
 * The rows to offer, in the order to offer them.
 *
 * Two grains side by side: a system, then the components under it. A system
 * with one component gets no group row — merging one source is the identity,
 * and two rows that cannot differ by a single byte are one row too many.
 *
 * Systems are ordered by their total frames, components within a system by
 * their own, which is the order `parsed.sources` already carries.
 */
export function sourceOptions(parsed: ParsedLog): SourceOption[] {
  const bySysid = new Map<number, SourceInfo[]>();
  for (const s of parsed.sources) {
    const list = bySysid.get(s.sysid);
    if (list) list.push(s);
    else bySysid.set(s.sysid, [s]);
  }
  const systems = [...bySysid].map(([sysid, members]) => ({
    sysid,
    members,
    records: members.reduce((n, m) => n + m.records, 0),
  }));
  systems.sort((a, b) => b.records - a.records);

  const out: SourceOption[] = [];
  for (const sys of systems) {
    const single = sys.members.length < GROUP_MIN_COMPONENTS;
    if (!single) {
      out.push({
        key: groupKey(sys.sysid),
        group: true,
        members: sys.members,
        primary: primaryOf(sys.members)!,
        records: sys.records,
        indented: false,
      });
    }
    for (const m of sys.members) {
      out.push({ key: sourceKey(m), group: false, members: [m], primary: m, records: m.records, indented: !single });
    }
  }
  return out;
}

/**
 * The addresses a selection covers, or `[]` when it names nothing.
 *
 * `ALL_SOURCES` is every key of `bySource`, NOT `sources.map(sourceKey)`: a
 * .bin holds one entry keyed `ALL_SOURCES` and an empty `sources`, so going
 * through `sources` would make every .bin selection empty — and purging, which
 * reads this to decide what it may drop, a silent no-op.
 *
 * A group's members come back in the parsers' records-descending order, which
 * is what `primaryOf` is entitled to assume.
 */
export function selectionKeys(parsed: ParsedLog, selection: string): string[] {
  if (selection === ALL_SOURCES) return [...parsed.bySource.keys()];
  const sysid = parseGroupKey(selection);
  if (sysid !== null) return parsed.sources.filter((s) => s.sysid === sysid).map(sourceKey);
  return parsed.bySource.has(selection) ? [selection] : [];
}

/**
 * Render one selection as the `LogData` every view already reads.
 *
 * One path for all three kinds of selection — everything, one system, one
 * address — because they differ only in which sources go in and whose modes
 * come out. A single-source selection still hands back the parser's own arrays:
 * `mergeSources` returns its one input untouched.
 *
 * `startTime`/`endTime` span every source whatever is selected, so the timeline
 * and every relative time printed against it hold still while the reader moves
 * between sources.
 *
 * An unknown key falls back to `ALL_SOURCES` rather than throwing: purging the
 * last message type of a source empties it, and a stale selection should show
 * the reader everything rather than nothing.
 */
export function projectLog(parsed: ParsedLog, selection: string): LogData {
  let keys = selectionKeys(parsed, selection);
  // A group with too few components names nothing the selector offers, so it
  // falls back the way any unknown key does.
  if (parseGroupKey(selection) !== null && keys.length < GROUP_MIN_COMPONENTS) keys = [];
  const resolved = keys.length ? selection : ALL_SOURCES;
  const use = keys.length ? keys : [...parsed.bySource.keys()];
  const all = use.map((k) => parsed.bySource.get(k)).filter((d): d is SourceData => !!d);
  const data = mergeSources(all, preferredIn(parsed, use), modeSourcesIn(parsed, resolved, use, all));
  return {
    source: parsed.source,
    ...data,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    sources: parsed.sources,
    selection: resolved,
  };
}

/**
 * A selection's sources merged into one `SourceData`.
 *
 * Everything, one system's components, or — the identity — a single source.
 *
 * Message types only one source sent are passed through by reference — the
 * common case by far, and what keeps this from doubling a 33 MB model. The
 * merge below runs for the handful that collide: on the sample log HEARTBEAT
 * (four senders), REQUEST_DATA_STREAM (two) and TIMESYNC (two).
 */
function mergeSources(
  all: SourceData[],
  preferred: SourceData | undefined,
  modeSources: SourceData[],
): SourceData {
  // Both early returns hand back an input untouched, so `modeSources` is not
  // consulted here: a one-source merge is the identity, and it is the caller's
  // job to have passed modes that belong to that source.
  if (all.length === 1) return all[0]; // a .bin, or a tlog with one talker
  if (all.length === 0) return EMPTY_SOURCE_DATA;

  const byName = new Map<string, MessageSeries[]>();
  for (const d of all) {
    for (const [name, series] of Object.entries(d.messages)) {
      const list = byName.get(name);
      if (list) list.push(series);
      else byName.set(name, [series]);
    }
  }
  const messages: Record<string, MessageSeries> = {};
  for (const [name, list] of byName) {
    messages[name] = list.length === 1 ? list[0] : mergeSeries(name, list);
  }

  // The source the reader would have been shown by default wins any collision,
  // so a merged view agrees with the single-source view about the things only
  // one of them can hold. `all[0]` covers a .bin, whose empty `sources` leaves
  // `primaryOf` with nothing to name.
  const base = preferred ?? all[0];
  const ordered = [base, ...all.filter((d) => d !== base)];

  const params: Record<string, number> = {};
  for (const d of ordered) {
    for (const [k, v] of Object.entries(d.params)) if (!(k in params)) params[k] = v;
  }

  return {
    messages,
    params,
    // Sorted, not deduplicated: these are filed by sender only, so there is
    // nothing to collapse — and two vehicles entering AUTO or reaching waypoint
    // 3 at the same instant are two events, not one seen twice.
    modes: sortByTime(modeSources.flatMap((d) => d.modes)),
    texts: sortByTime(all.flatMap((d) => d.texts)),
    missionSteps: sortByTime(all.flatMap((d) => d.missionSteps)),
    // Commands are the exception: one is filed under both ends of the exchange,
    // so merging brings the copies back. The same identity as within a source —
    // command, sender and target — which is what keeps a merged view from
    // collapsing two stations that issued the same order at the same instant.
    commands: normalizeEvents(all.flatMap((d) => d.commands), commandKey),
    // Not merged by seq. Two sources hold two plans, and interleaving them by
    // index produces a route neither vehicle ever had — the exact failure
    // MissionCollector refuses to make when a shorter plan replaces a longer
    // one. Take one plan whole.
    mission: firstNonEmpty(ordered.map((d) => d.mission)) ?? [],
    trajectory: ordered.find((d) => d.trajectory.lat.length > 0)?.trajectory ?? base.trajectory,
  };
}

/**
 * The sources a selection's mode history comes from.
 *
 * A group is one aircraft, and every component of it sends HEARTBEAT — a
 * peripheral's `customMode` is always 0, so merging them puts a mode the
 * aircraft never entered at the head of a row that claims to be the aircraft.
 * When no component names a vehicle (two ground stations under one SYSID) there
 * is nothing to prefer, so everything is kept rather than half of it dropped.
 *
 * `ALL_SOURCES` keeps every source's: it can hold several aircraft, and
 * preferring one would silently drop the rest — which `project.test.ts` pins.
 */
function modeSourcesIn(
  parsed: ParsedLog,
  selection: string,
  keys: string[],
  all: SourceData[],
): SourceData[] {
  if (parseGroupKey(selection) === null) return all;
  const want = new Set(keys);
  const members = parsed.sources.filter((s) => want.has(sourceKey(s)));
  const vehicles = members.filter(namesAVehicle);
  if (vehicles.length === 0) return all;
  return vehicles.map((s) => parsed.bySource.get(sourceKey(s))).filter((d): d is SourceData => !!d);
}

/**
 * `primaryOf` over a key set, resolved to its data.
 *
 * Filters `parsed.sources` rather than mapping `keys`, because `primaryOf`
 * depends on records-descending order and `bySource`'s keys are in the order
 * the parser met them.
 */
function preferredIn(parsed: ParsedLog, keys: string[]): SourceData | undefined {
  const want = new Set(keys);
  const p = primaryOf(parsed.sources.filter((s) => want.has(sourceKey(s))));
  return p && parsed.bySource.get(sourceKey(p));
}

function firstNonEmpty(lists: Waypoint[][]): Waypoint[] | null {
  for (const l of lists) if (l.length) return l;
  return null;
}

/** Stable sort by time; the input arrays are already per-source copies. */
function sortByTime<T extends ModeChange | TextMessage | MissionStep>(events: T[]): T[] {
  return events.sort((a, b) => a.time - b.time);
}

/**
 * Interleave one message type's rows from several senders.
 *
 * Every input is time-sorted (LogBuilder.finalize guarantees it), so this is a
 * k-way merge rather than a concatenate-and-sort — and the output stays sorted,
 * which is what the binary searches downstream rely on.
 *
 * Columns are taken as a union, and a row that never had one reads NaN rather
 * than shifting its neighbours. Today that union always has one member: the
 * parser caches a msgid's column layout across every source, so two senders of
 * the same message cannot disagree about its fields. The union is what keeps
 * that an implementation detail of the parser rather than something this
 * function silently depends on.
 */
function mergeSeries(name: string, list: MessageSeries[]): MessageSeries {
  const total = list.reduce((n, s) => n + s.time.length, 0);
  const labels: string[] = [];
  for (const s of list) for (const l of s.labels) if (!labels.includes(l)) labels.push(l);

  const numericNames = unionKeys(list.map((s) => s.fields));
  const textNames = unionKeys(list.map((s) => s.textFields ?? {}));

  const time = new Float64Array(total);
  const fields: Record<string, Float64Array> = {};
  for (const f of numericNames) fields[f] = new Float64Array(total).fill(NaN);
  const textFields: Record<string, string[]> = {};
  for (const f of textNames) textFields[f] = new Array<string>(total).fill('');

  // k-way merge on the head of each input, ordered by (time, input index) so a
  // tie keeps the order the sources were listed in. What that order is belongs
  // to the caller: `ALL_SOURCES` lists them as the parser met them, a SYSID
  // group lists them most-frames-first.
  //
  // Through a binary heap rather than a scan of every head per output row. The
  // scan was O(rows x sources), which is fine for the two or three components a
  // real aircraft carries but not for the ceiling: the parser admits 256
  // senders and nothing stops them sharing a SYSID, and 256 of them holding
  // 256,000 rows between them measured 613 ms — spent on the main thread, in
  // the parse-completion handler, after progress already read 100%. This is
  // O(rows x log sources): the same merge measures 173 ms, and the two or three
  // components of a real aircraft 13 ms.
  const heads = new Array<number>(list.length).fill(0);
  const heap: number[] = [];
  const before = (a: number, b: number): boolean => {
    const ta = list[a].time[heads[a]];
    const tb = list[b].time[heads[b]];
    return ta < tb || (ta === tb && a < b);
  };
  const up = (i: number) => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  };
  const down = (i: number) => {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < heap.length && before(heap[l], heap[small])) small = l;
      if (r < heap.length && before(heap[r], heap[small])) small = r;
      if (small === i) break;
      [heap[i], heap[small]] = [heap[small], heap[i]];
      i = small;
    }
  };
  // An input with no rows never enters, so the heap's root is always a live head.
  for (let i = 0; i < list.length; i++) {
    if (list[i].time.length === 0) continue;
    heap.push(i);
    up(heap.length - 1);
  }

  for (let out = 0; out < total; out++) {
    const pick = heap[0];
    const src = list[pick];
    const at = heads[pick]++;
    time[out] = src.time[at];
    for (const f of numericNames) {
      const col = src.fields[f];
      if (col) fields[f][out] = col[at];
    }
    for (const f of textNames) {
      const col = src.textFields?.[f];
      if (col) textFields[f][out] = col[at];
    }
    // Exhausted inputs leave the heap; the rest just re-sift on their new head.
    if (heads[pick] >= src.time.length) {
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        down(0);
      }
    } else {
      down(0);
    }
  }

  return { name, labels, time, fields, ...(textNames.length ? { textFields } : {}) };
}

function unionKeys(objs: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const o of objs) for (const k of Object.keys(o)) if (!out.includes(k)) out.push(k);
  return out;
}

/** For a log the reader opened that turned out to hold no framed records. */
const EMPTY_SOURCE_DATA: SourceData = {
  messages: {},
  params: {},
  modes: [] as ModeChange[],
  texts: [] as TextMessage[],
  commands: [] as CommandEvent[],
  missionSteps: [] as MissionStep[],
  mission: [] as Waypoint[],
  trajectory: EMPTY_TRAJECTORY,
};
