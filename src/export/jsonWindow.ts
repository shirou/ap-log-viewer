// Serializing a sliced log as columnar JSON.
//
// Takes a `LogData` and writes it out whole: the windowing already happened when
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

import type { LogData, MessageSeries } from '../model/log.ts';
import type { TimeWindow } from '../model/log.ts';

/** Bumped when the shape below changes in a way a consumer could trip over. */
export const JSON_FORMAT_VERSION = 1;

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

export function* jsonParts(log: LogData, meta: JsonMeta): Generator<string> {
  const { window } = meta;
  const durationSec = (t1: number, t0: number) => (t1 - t0) / 1e6;

  yield '{';
  yield `${key('generator')}:{${key('name')}:"ap-log-viewer",${key('format')}:${JSON_FORMAT_VERSION}},`;
  yield `${key('source')}:{${key('file')}:${JSON.stringify(meta.fileName)},${key('kind')}:${JSON.stringify(log.source)}},`;
  yield `${key('timeUnit')}:"microseconds",`;
  // A .bin counts from boot and a tlog from the epoch; the numbers alone cannot
  // say which, and a consumer turning them into wall-clock times needs to know.
  yield `${key('timeBase')}:${log.source === 'bin' ? '"boot"' : '"unix"'},`;
  yield `${key('nonFinite')}:"null",${key('negativeZero')}:"normalized",`;
  yield `${key('note')}:${JSON.stringify(NOTE)},`;
  // The window that was asked for, and separately what the slice turned out to
  // hold. They differ whenever the window opens or closes between samples, and
  // printing only one of them would hide that.
  yield `${key('window')}:{${key('start')}:${window.startUs},${key('end')}:${window.endUs},`;
  yield `${key('durationSec')}:${num(durationSec(window.endUs, window.startUs))}},`;
  yield `${key('data')}:{${key('start')}:${num(log.startTime)},${key('end')}:${num(log.endTime)},`;
  yield `${key('durationSec')}:${num(durationSec(log.endTime, log.startTime))}},`;

  yield `${key('messages')}:{`;
  let firstMsg = true;
  for (const name of Object.keys(log.messages).sort()) {
    if (!firstMsg) yield ',';
    firstMsg = false;
    yield `${key(name)}:`;
    yield* series(log.messages[name]);
  }
  yield '},';

  // Small enough to hand to JSON.stringify whole, which also gets the escaping
  // and the non-finite handling right for free.
  yield `${key('params')}:${JSON.stringify(log.params)},`;
  yield `${key('mission')}:${JSON.stringify(log.mission)},`;
  yield `${key('modes')}:${JSON.stringify(log.modes)},`;
  yield `${key('texts')}:${JSON.stringify(log.texts)},`;
  yield `${key('commands')}:${JSON.stringify(log.commands)},`;
  yield `${key('missionSteps')}:${JSON.stringify(log.missionSteps)},`;

  // Derived rather than raw, and worth carrying: the source preference
  // (POS -> GPS -> AHR2), the scaling and the heading fallback in
  // extractTrajectory are not obvious enough to leave a consumer to redo.
  yield `${key('trajectory')}:{`;
  const t = log.trajectory;
  const cols: [string, Float64Array][] = [
    ['time', t.time],
    ['lat', t.lat],
    ['lon', t.lon],
    ['alt', t.alt],
    ['heading', t.heading],
  ];
  let firstCol = true;
  for (const [name, col] of cols) {
    if (!firstCol) yield ',';
    firstCol = false;
    yield `${key(name)}:`;
    yield* numberArray(col);
  }
  yield '}';
  yield '}';
}

/**
 * Feed `jsonParts` into a Blob, optionally through gzip.
 *
 * The stream is what keeps the fragments from piling up: with gzip on, nothing
 * larger than one fragment plus the compressor's window is ever live, and a
 * columnar numeric JSON compresses five to eight times over.
 */
export async function jsonBlob(log: LogData, meta: JsonMeta, gzip: boolean): Promise<Blob> {
  const it = jsonParts(log, meta);
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
