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
  TextMessage,
  Waypoint,
} from '../model/log.ts';
import { minimal } from 'mavlink-mappings';
import { ALL_SOURCES, sourceKey } from '../model/log.ts';
import { EMPTY_TRAJECTORY, normalizeEvents } from './columnar.ts';
import { commandKey } from './tlog.ts';
import { kindFromMavType } from '../lib/vehicleModes.ts';

/**
 * The source to show when a log is first opened.
 *
 * Three tests, narrowest first, because each one alone gets a real log wrong:
 *
 *  - The busiest source is not always the vehicle. On the sample log an
 *    external GPS injector sends 36,720 frames; a quieter autopilot would lose.
 *  - "Not a ground station" lets a gimbal or an ADSB transponder win.
 *  - But a vehicle announcing MAV_TYPE_GENERIC passes neither of the first two,
 *    and picking nothing at all would leave the reader staring at a mixture.
 *
 * So: prefer a source whose HEARTBEAT names a vehicle ArduPilot flies, fall
 * back to anything that is not a ground station, then to whatever spoke most.
 */
export function defaultSelection(parsed: ParsedLog): string {
  if (parsed.sources.length === 0) return ALL_SOURCES;
  // `sources` is already sorted by frame count, so the first match in each pass
  // is the busiest of that class.
  const vehicle = parsed.sources.find((s) => s.mavType !== undefined && kindFromMavType(s.mavType) !== null);
  if (vehicle) return sourceKey(vehicle);
  const notGcs = parsed.sources.find((s) => s.mavType !== minimal.MavType.GCS);
  return sourceKey(notGcs ?? parsed.sources[0]);
}

/**
 * Render one selection as the `LogData` every view already reads.
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
  const one = selection === ALL_SOURCES ? undefined : parsed.bySource.get(selection);
  const data = one ?? mergeSources(parsed);
  return {
    source: parsed.source,
    ...data,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    sources: parsed.sources,
    selection: one ? selection : ALL_SOURCES,
  };
}

/**
 * Every source at once.
 *
 * Message types only one source sent are passed through by reference — the
 * common case by far, and what keeps this from doubling a 33 MB model. The
 * merge below runs for the handful that collide: on the sample log HEARTBEAT
 * (four senders), REQUEST_DATA_STREAM (two) and TIMESYNC (two).
 */
function mergeSources(parsed: ParsedLog): SourceData {
  const all = [...parsed.bySource.values()];
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
  // so "all sources" agrees with the default view about the things only one of
  // them can hold.
  const preferred = parsed.bySource.get(defaultSelection(parsed)) ?? all[0];
  const ordered = [preferred, ...all.filter((d) => d !== preferred)];

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
    modes: sortByTime(all.flatMap((d) => d.modes)),
    texts: sortByTime(all.flatMap((d) => d.texts)),
    missionSteps: sortByTime(all.flatMap((d) => d.missionSteps)),
    // Commands are the exception: one is filed under both ends of the exchange,
    // so merging brings the copies back. Identity has to include the sender as
    // well as the target here — two ground stations can issue the same command
    // to the same vehicle, which per-source keying never has to tell apart.
    commands: normalizeEvents(
      all.flatMap((d) => d.commands),
      (c) => `${c.source.sysid}/${c.source.compid}:${commandKey(c)}`,
    ),
    // Not merged by seq. Two sources hold two plans, and interleaving them by
    // index produces a route neither vehicle ever had — the exact failure
    // MissionCollector refuses to make when a shorter plan replaces a longer
    // one. Take one plan whole.
    mission: firstNonEmpty(ordered.map((d) => d.mission)) ?? [],
    trajectory: ordered.find((d) => d.trajectory.lat.length > 0)?.trajectory ?? preferred.trajectory,
  };
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

  // k-way merge on the head of each input. Ties keep the order the sources are
  // listed in, which is the order the parser met them.
  const heads = new Array<number>(list.length).fill(0);
  for (let out = 0; out < total; out++) {
    let pick = -1;
    for (let i = 0; i < list.length; i++) {
      const at = heads[i];
      if (at >= list[i].time.length) continue;
      if (pick < 0 || list[i].time[at] < list[pick].time[heads[pick]]) pick = i;
    }
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
