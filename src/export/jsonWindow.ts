// Serializing a sliced log as columnar JSON.
//
// Takes a `ParsedLog` and writes it out whole: the windowing already happened when
// the bytes were cut, so there is no range logic here and nothing to keep in step
// with `rangeIndices`. What arrives is the parse of a slice carrying structure
// only, which is why everything in the output was recorded inside the window.
//
// A generator of text fragments rather than one `JSON.stringify` call, for four
// reasons that each rule it out on their own:
//
//  1. A Float64Array stringifies as {"0":1.2,...}, not as an array. Converting
//     first means one full JS array per column, all live at once.
//  2. V8 caps a string at 2^29-24 ≈ 536M characters, so a large window throws
//     RangeError with every column already built.
//  3. `new Blob(parts)` copies each fragment into (in Chrome, disk-backed)
//     storage, so the peak is one fragment rather than the whole document twice.
//  4. Fragments feed a ReadableStream, which is what lets the gzip path avoid
//     materializing anything at all.

import type { MessageSeries, ParsedLog, SourceData, SourceInfo, Trajectory } from '../model/log.ts';
import type { TimeWindow } from '../model/log.ts';
import { sourceKey } from '../model/log.ts';
// The one empty track every source without a position shares, rather than a
// second copy of it here.
import { EMPTY_TRAJECTORY } from '../parsers/columnar.ts';

/**
 * Bumped when the shape below changes in a way a consumer could trip over.
 *
 * 2: a tlog is written per MAVLink source. `sources` lists them, `messages`
 * keys become "sysid/compid:TYPE", `params` and `mission` nest under the source
 * key, `trajectory` becomes an array, and each event carries the address it
 * came from. A .bin has no addresses and keeps the flat shape version 1 wrote —
 * its output was never ambiguous, so there is nothing to fix and no reason to
 * break a reader. `source.kind` says which layout a document uses; `sources`
 * can be empty for either, since a tlog window may catch nothing decodable.
 */
export const JSON_FORMAT_VERSION = 2;

/**
 * Values per emitted fragment. 4096 numbers is roughly 80 KB of text: large
 * enough that the per-fragment overhead is noise, small enough that the transient
 * string never matters.
 */
const CHUNK = 4096;

export interface JsonMeta {
  /** Name of the file the log was read from. */
  fileName: string;
  /** The window that was asked for, which the data may not fill. */
  window: TimeWindow;
}

/**
 * One numeric cell as JSON text.
 *
 * `String` gives the shortest decimal that round-trips to the same double, so
 * nothing is lost and nothing is padded — where `toFixed` would do both, flooring
 * 1e-9 to zero and writing useless zeros after every integer. Its exponent forms
 * ("1e+21", "5e-324") are inside JSON's number grammar.
 *
 * JSON has no NaN and no infinities, so those become null — which is what
 * `JSON.stringify` already does with one inside an array, and what pandas and
 * numpy read back as NaN. Negative zero comes out as "0"; nothing in flight data
 * distinguishes it, and the header says so rather than leaving a reader to find
 * out.
 */
function num(v: number): string {
  return Number.isFinite(v) ? String(v) : 'null';
}

function* numberArray(col: ArrayLike<number>, from = 0, to = col.length): Generator<string> {
  yield '[';
  const buf: string[] = [];
  let wrote = false;
  for (let i = from; i < to; i++) {
    buf.push(num(col[i]));
    if (buf.length === CHUNK) {
      yield (wrote ? ',' : '') + buf.join(',');
      wrote = true;
      buf.length = 0;
    }
  }
  if (buf.length) yield (wrote ? ',' : '') + buf.join(',');
  yield ']';
}

function* stringArray(col: readonly string[]): Generator<string> {
  yield '[';
  const buf: string[] = [];
  let wrote = false;
  for (const s of col) {
    // Through JSON.stringify, never hand-quoted: these come verbatim out of the
    // log, so they can hold a quote, a control character or a lone surrogate.
    buf.push(JSON.stringify(s ?? ''));
    if (buf.length === CHUNK) {
      yield (wrote ? ',' : '') + buf.join(',');
      wrote = true;
      buf.length = 0;
    }
  }
  if (buf.length) yield (wrote ? ',' : '') + buf.join(',');
  yield ']';
}

/** A key, escaped. Message and field names come from the log's own FMT records. */
const key = (k: string) => JSON.stringify(k);

function* series(m: MessageSeries): Generator<string> {
  // `labels` keeps the log's own declaration order, deliberately unsorted: that
  // order is what the file said, and a reader lining columns up against a FMT
  // record or another tool's output needs it as written. The `fields` and
  // `textFields` objects below are sorted instead, since their order is JS
  // insertion order and means nothing.
  yield `{${key('count')}:${m.time.length},${key('labels')}:${JSON.stringify(m.labels)},`;
  yield `${key('time')}:`;
  yield* numberArray(m.time);
  yield `,${key('fields')}:{`;
  let first = true;
  // Sorted, so two exports of the same slice are the same string.
  for (const name of Object.keys(m.fields).sort()) {
    if (!first) yield ',';
    first = false;
    yield `${key(name)}:`;
    yield* numberArray(m.fields[name]);
  }
  yield '}';
  // Omitted entirely when the series has none, mirroring the optional field on
  // the model rather than inventing an empty object.
  if (m.textFields) {
    yield `,${key('textFields')}:{`;
    let firstText = true;
    for (const name of Object.keys(m.textFields).sort()) {
      if (!firstText) yield ',';
      firstText = false;
      yield `${key(name)}:`;
      yield* stringArray(m.textFields[name]);
    }
    yield '}';
  }
  yield '}';
}

const NOTE =
  'Everything here was recorded inside the requested window. params and mission ' +
  'may be empty when the log only recorded them outside it.';

const NOTE_SPLIT =
  NOTE +
  ' Keys in `messages` are "sysid/compid:TYPE"; `params` and `mission` nest under ' +
  'the same source key. In `commands`, sysid/compid is the sender and ' +
  'targetSysid/targetCompid the recipient.';

export function* jsonParts(parsed: ParsedLog, meta: JsonMeta): Generator<string> {
  const { window } = meta;
  const durationSec = (t1: number, t0: number) => (t1 - t0) / 1e6;
  // Keyed off the file kind, not off what this particular window turned out to
  // hold: a tlog whose window caught only undecodable frames has no sources,
  // and emitting the flat shape for it would make the document's own `kind`
  // disagree with its layout. `source.kind` is what a consumer branches on too.
  const split = parsed.source === 'tlog';
  const entries = [...parsed.bySource.entries()];

  yield '{';
  yield `${key('generator')}:{${key('name')}:"ap-log-viewer",${key('format')}:${JSON_FORMAT_VERSION}},`;
  yield `${key('source')}:{${key('file')}:${JSON.stringify(meta.fileName)},${key('kind')}:${JSON.stringify(parsed.source)}},`;
  yield `${key('timeUnit')}:"microseconds",`;
  // A .bin counts from boot and a tlog from the epoch; the numbers alone cannot
  // say which, and a consumer turning them into wall-clock times needs to know.
  yield `${key('timeBase')}:${parsed.source === 'bin' ? '"boot"' : '"unix"'},`;
  yield `${key('nonFinite')}:"null",${key('negativeZero')}:"normalized",`;
  yield `${key('note')}:${JSON.stringify(split ? NOTE_SPLIT : NOTE)},`;
  // The window that was asked for, and separately what the slice turned out to
  // hold. They differ whenever the window opens or closes between samples, and
  // printing only one of them would hide that.
  yield `${key('window')}:{${key('start')}:${window.startUs},${key('end')}:${window.endUs},`;
  yield `${key('durationSec')}:${num(durationSec(window.endUs, window.startUs))}},`;
  yield `${key('data')}:{${key('start')}:${num(parsed.startTime)},${key('end')}:${num(parsed.endTime)},`;
  yield `${key('durationSec')}:${num(durationSec(parsed.endTime, parsed.startTime))}},`;

  // Type counts are taken from the data as it stands rather than from a number
  // recorded at parse time, so a document written after purging says what it
  // actually holds.
  yield `${key('sources')}:[`;
  let firstSrc = true;
  for (const info of parsed.sources) {
    if (!firstSrc) yield ',';
    firstSrc = false;
    yield JSON.stringify(sourceSummary(info, parsed.bySource.get(sourceKey(info))));
  }
  yield '],';

  // Keys carry the address for a tlog ("1/1:ATTITUDE") and stay bare for a
  // .bin. Sorted so two exports of the same slice are the same string.
  yield `${key('messages')}:{`;
  let firstMsg = true;
  const named: [string, MessageSeries][] = [];
  for (const [srcKey, data] of entries) {
    for (const [name, m] of Object.entries(data.messages)) {
      named.push([split ? `${srcKey}:${name}` : name, m]);
    }
  }
  named.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [label, m] of named) {
    if (!firstMsg) yield ',';
    firstMsg = false;
    yield `${key(label)}:`;
    yield* series(m);
  }
  yield '},';

  // Small enough to hand to JSON.stringify whole, which also gets the escaping
  // and the non-finite handling right for free.
  yield `${key('params')}:${JSON.stringify(perSource(entries, split, (d) => d.params, {}))},`;
  yield `${key('mission')}:${JSON.stringify(perSource(entries, split, (d) => d.mission, []))},`;

  // Events carry their address inline rather than nesting, because a reader
  // asking "what happened, in order" wants one list. `commands` is the reason
  // `CommandEvent.source` exists: a command is filed under its target as well
  // as its sender, so the key it sits under is not who sent it — and on a real
  // session every command comes from the ground station, so reading the key
  // would attribute all of them to the vehicle.
  yield `${key('modes')}:${JSON.stringify(stamped(parsed, entries, split, (d) => d.modes))},`;
  yield `${key('texts')}:${JSON.stringify(stamped(parsed, entries, split, (d) => d.texts))},`;
  yield `${key('commands')}:${JSON.stringify(commandList(entries, split))},`;
  yield `${key('missionSteps')}:${JSON.stringify(stamped(parsed, entries, split, (d) => d.missionSteps))},`;

  // Derived rather than raw, and worth carrying: the source preference
  // (POS -> GPS -> AHR2), the scaling and the heading fallback in
  // extractTrajectory are not obvious enough to leave a consumer to redo.
  //
  // An array for a tlog, where two vehicles have two tracks; an object for a
  // .bin, where there has only ever been one and a reader already reads it.
  if (split) {
    yield `${key('trajectory')}:[`;
    let firstTraj = true;
    for (const info of parsed.sources) {
      const data = parsed.bySource.get(sourceKey(info));
      if (!data || data.trajectory.lat.length === 0) continue;
      if (!firstTraj) yield ',';
      firstTraj = false;
      yield `{${key('sysid')}:${info.sysid},${key('compid')}:${info.compid},`;
      yield* trajectoryColumns(data.trajectory);
      yield '}';
    }
    yield ']';
  } else {
    yield `${key('trajectory')}:{`;
    yield* trajectoryColumns(entries[0]?.[1].trajectory ?? EMPTY_TRAJECTORY);
    yield '}';
  }
  yield '}';
}

function* trajectoryColumns(t: Trajectory): Generator<string> {
  const cols: [string, Float64Array][] = [
    ['time', t.time],
    ['lat', t.lat],
    ['lon', t.lon],
    ['alt', t.alt],
    ['heading', t.heading],
  ];
  let first = true;
  for (const [name, col] of cols) {
    if (!first) yield ',';
    first = false;
    yield `${key(name)}:`;
    yield* numberArray(col);
  }
}

function sourceSummary(info: SourceInfo, data: SourceData | undefined): Record<string, unknown> {
  return {
    sysid: info.sysid,
    compid: info.compid,
    ...(info.mavType === undefined ? {} : { mavType: info.mavType }),
    ...(info.typeLabel ? { type: info.typeLabel } : {}),
    ...(info.compLabel ? { component: info.compLabel } : {}),
    records: info.records,
    messageTypes: data ? Object.keys(data.messages).length : 0,
    start: info.startTime,
    end: info.endTime,
  };
}

/** Nest a per-source collection under its address, or hand back the one a .bin has. */
function perSource<T>(
  entries: [string, SourceData][],
  split: boolean,
  pick: (d: SourceData) => T,
  fallback: T,
): T | Record<string, T> {
  if (!split) return entries[0] ? pick(entries[0][1]) : fallback;
  const out: Record<string, T> = {};
  for (const [srcKey, data] of entries) out[srcKey] = pick(data);
  return out;
}

/**
 * Flatten a per-source event list, tagging each entry with where it came from.
 *
 * The address comes from `sources` rather than from taking a map key apart:
 * the key format is this module's business only for a tlog, and a .bin files
 * its one source under a sentinel that is not an address at all.
 */
function stamped<T extends { time: number }>(
  parsed: ParsedLog,
  entries: [string, SourceData][],
  split: boolean,
  pick: (d: SourceData) => T[],
): T[] | (T & { sysid: number; compid: number })[] {
  if (!split) return entries[0] ? pick(entries[0][1]) : [];
  const out: (T & { sysid: number; compid: number })[] = [];
  for (const info of parsed.sources) {
    const data = parsed.bySource.get(sourceKey(info));
    if (!data) continue;
    for (const e of pick(data)) out.push({ ...e, sysid: info.sysid, compid: info.compid });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Commands, once each, attributed to whoever sent them.
 *
 * A command is stored under its sender *and* its target, so walking every
 * source would emit it twice. Keeping only the copy sitting under its own
 * sender collapses that without a separate dedup pass.
 */
function commandList(entries: [string, SourceData][], split: boolean): Record<string, unknown>[] {
  if (!split) return entries[0] ? (entries[0][1].commands as unknown as Record<string, unknown>[]) : [];
  const out: Record<string, unknown>[] = [];
  for (const [srcKey, data] of entries) {
    for (const c of data.commands) {
      if (`${c.source.sysid}/${c.source.compid}` !== srcKey) continue;
      out.push({
        time: c.time,
        id: c.id,
        name: c.name,
        sysid: c.source.sysid,
        compid: c.source.compid,
        ...(c.target ? { targetSysid: c.target.sysid, targetCompid: c.target.compid } : {}),
      });
    }
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}

/**
 * Feed `jsonParts` into a Blob, optionally through gzip.
 *
 * The stream is what keeps the fragments from piling up: with gzip on, nothing
 * larger than one fragment plus the compressor's window is ever live, and a
 * columnar numeric JSON compresses five to eight times over.
 */
export async function jsonBlob(parsed: ParsedLog, meta: JsonMeta, gzip: boolean): Promise<Blob> {
  const it = jsonParts(parsed, meta);
  const enc = new TextEncoder();
  // Typed as BufferSource because that is what CompressionStream's writable side
  // accepts; a Uint8Array-typed stream will not pipe into it.
  const source = new ReadableStream<BufferSource>({
    pull(c) {
      const { value, done } = it.next();
      if (done) c.close();
      else c.enqueue(enc.encode(value));
    },
  });
  const stream: ReadableStream = gzip ? source.pipeThrough(new CompressionStream('gzip')) : source;
  const blob = await new Response(stream).blob();
  return gzip ? blob.slice(0, blob.size, 'application/gzip') : blob.slice(0, blob.size, 'application/json');
}
