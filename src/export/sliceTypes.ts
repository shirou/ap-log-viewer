// The vocabulary of a slice, and the parts of it that are pure.
//
// Split out from slice.ts, which reaches for the parsers' framing loops, so that
// the two planners can share these helpers without importing the module that
// imports them — a cycle that happens to work today and breaks the first time
// someone gives one of these files module-level state.
//
// Nothing in the UI imports this: what a component needs to talk about a slice
// (`LogKind`, `TimeWindow`, `SliceRequest`, `SliceStats`) lives in model/log.ts
// precisely so it can be reached without pulling the MAVLink dialect tables into
// the main bundle. Keep it that way — adding a UI import here would undo that.

import type { ByteRange, LogSource } from '../parsers/source.ts';
import type { LogKind, SliceStats } from '../model/log.ts';

/** How many rows one message type should contribute to the slice. */
export interface ExpectedRows {
  /** Rows copied from inside the window. */
  window: number;
  /** Rows carried in from outside it, all restamped to the window start. */
  hoisted: number;
}

export interface SliceScan {
  kind: LogKind;
  /**
   * Structure: the FMT records for a .bin, nothing for a .tlog. Emitted for both
   * output modes because a .bin without its format table reparses to an empty
   * log — and emitted apart from the context because FMT is the one record type
   * the reader never turns into a row, so it cannot pollute a JSON export.
   */
  structParts: Uint8Array<ArrayBuffer>[];
  /**
   * Context from outside the window — unit tables, parameters, the mode in force,
   * the flight plan — already restamped to the window start.
   */
  contextParts: Uint8Array<ArrayBuffer>[];
  /** Byte ranges of the original file, ascending, disjoint, adjacent ones merged. */
  ranges: ByteRange[];
  /** Message name -> the rows a correct slice must reparse to. */
  expected: Map<string, ExpectedRows>;
  stats: {
    windowRecords: number;
    hoistedRecords: number;
    rangeCount: number;
    /** Bytes the reader skipped between records in the *original* file. */
    resyncBytes: number;
  };
}

export type SliceMode = 'original' | 'data';

/**
 * Tally of what a slice actually contains, produced by reframing it.
 *
 * Deliberately not a parse: building a `LogData` for a window covering most of a
 * large log roughly doubles the memory of one, and a dedicated worker shares its
 * renderer process with the page — a V8 OOM there takes the tab down and the
 * reader loses the log they already loaded.
 */
export interface SliceInspection {
  /** Message name -> rows. Excludes .bin FMT records, which never become rows. */
  rows: Map<string, number>;
  /**
   * Bytes no record accounted for.
   *
   * A slice is nothing but whole records, so this is zero for a correct one. It
   * is the sharpest single check available: a missing FMT, an off-by-one byte
   * range or a mangled preamble all show up here, and a .bin missing its FMT
   * table reframes as *nothing but* skipped bytes.
   */
  gapBytes: number;
  minTime: number;
  maxTime: number;
}

export interface SliceMismatch {
  reason: string;
}

/**
 * Copy `length` bytes out of a buffer into one of their own.
 *
 * A copy rather than a view because the caller is holding on to these while the
 * scan moves on, and a .bin scan frees each 16 MiB chunk as it goes. Built over a
 * fresh ArrayBuffer so the result is a Blob part: a view into a possibly-shared
 * buffer is not.
 */
export function copyBytes(src: Uint8Array, start: number, length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  out.set(src.subarray(start, start + length));
  return out;
}

/**
 * Append a byte range, extending the previous one when they touch.
 *
 * Both framing loops jump to the end of the record they accepted, so ranges
 * arrive ascending and disjoint and merging is a single comparison. Without it a
 * healthy window would become one Blob part per record — hundreds of thousands
 * of them.
 */
export function pushRange(ranges: ByteRange[], start: number, end: number): void {
  const last = ranges[ranges.length - 1];
  if (last && last.end === start) last.end = end;
  else ranges.push({ start, end });
}

/** Count a row against a message type's expected total. */
export function countExpected(
  expected: Map<string, ExpectedRows>,
  name: string,
  where: 'window' | 'hoisted',
): void {
  let e = expected.get(name);
  if (!e) expected.set(name, (e = { window: 0, hoisted: 0 }));
  e[where]++;
}

/**
 * Largest slice this will assemble, in bytes.
 *
 * Assembling one costs more than its own size. The original format holds the
 * bytes and a Blob over them at once, so roughly twice. JSON is heavier again:
 * the bytes, the model reparsed from them, and the text — measured at about 2.4
 * times the slice for columnar numbers — though the model half is bounded by a
 * parse the reader already paid for when they opened the log.
 *
 * 256 MiB leaves the added footprint under about a gigabyte on the heavier path,
 * and is two orders of magnitude above any window worth cutting: the largest
 * measured here is 1.4 MB, from a 23-second window of a 65 MiB log. Refusing
 * loudly past it beats an out-of-memory kill, which takes the tab down and the
 * loaded log with it — and which a worker cannot reliably report.
 */
export const MAX_SLICE_BYTES = 256 * 1024 * 1024;

/**
 * The size a slice would come to when that is more than can be assembled, or
 * null when it fits.
 *
 * Answered before a byte is read, so the refusal costs nothing. Returns the size
 * rather than a boolean so the caller can say how far over it is — "too large"
 * with no number leaves the reader guessing how much to zoom in.
 */
export function sliceTooLarge(scan: SliceScan, mode: SliceMode): number | null {
  const size = sliceByteLength(scan, mode);
  return size > MAX_SLICE_BYTES ? size : null;
}

/** Total bytes the slice will occupy, known before any of them are read. */
function sliceByteLength(scan: SliceScan, mode: SliceMode): number {
  const head = mode === 'original' ? [...scan.structParts, ...scan.contextParts] : scan.structParts;
  let n = 0;
  for (const p of head) n += p.byteLength;
  for (const r of scan.ranges) n += r.end - r.start;
  return n;
}

/**
 * Read the slice out into bytes of its own.
 *
 * The original-format download goes through here rather than handing over a lazy
 * Blob over the source file: `saveBlob` would make the browser read that file a
 * *second* time, and File API snapshot state means a log moved or rewritten in
 * between fails that read — silently, from inside the download manager, after this
 * code has already said the slice checked out. Materializing once makes
 * "verified" and "saved" the same bytes.
 */
export async function readSliceBytes(
  source: LogSource,
  scan: SliceScan,
  mode: SliceMode,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(sliceByteLength(scan, mode));
  let at = 0;
  const head = mode === 'original' ? [...scan.structParts, ...scan.contextParts] : scan.structParts;
  for (const part of head) {
    out.set(part, at);
    at += part.byteLength;
  }
  for (const r of scan.ranges) {
    out.set(await source.read(r), at);
    at += r.end - r.start;
  }
  return out;
}

/**
 * True when the window caught nothing, so there is no slice worth making.
 *
 * Testing the type count instead would be no test at all: a window that falls
 * between samples still produces a preamble, and on a .bin that is seven or eight
 * message types and a thousand-odd rows whose start time is the window start by
 * construction.
 *
 * Lives here rather than in the worker so it can be exercised — a worker module
 * assigns `self.onmessage` as it loads, and there is no `self` under node.
 */
export function isEmptyWindow(scan: SliceScan): boolean {
  return scan.stats.windowRecords === 0 || scan.ranges.length === 0;
}

/**
 * What to tell the reader a verified slice contains.
 *
 * Carried-in rows are reported apart from the window's own, and are zero for a
 * data slice, which takes the structure and none of the context. Here for the
 * same reason as `isEmptyWindow`: these numbers go straight onto the screen, so
 * they are worth a test, and the worker cannot have one.
 */
export function sliceStats(
  scan: SliceScan,
  got: SliceInspection,
  mode: SliceMode,
  bytes: number,
): SliceStats {
  return {
    windowRows: scan.stats.windowRecords,
    hoistedRows: mode === 'original' ? scan.stats.hoistedRecords : 0,
    messageTypes: got.rows.size,
    startTime: got.minTime,
    endTime: got.maxTime,
    bytes,
  };
}

/**
 * Compare a slice against what the scan said it should be.
 *
 * Counting without comparing would be theatre: a .bin whose FMT table failed to
 * come across still reframes without throwing — the reader simply skips a byte at
 * a time and finds nothing — so "the rescan finished" says nothing on its own.
 */
export function checkSlice(
  scan: SliceScan,
  got: SliceInspection,
  window: { startUs: number; endUs: number },
  mode: SliceMode,
): SliceMismatch | null {
  if (got.gapBytes > 0) {
    return { reason: `${got.gapBytes} bytes of the slice did not frame as records` };
  }

  for (const [name, want] of scan.expected) {
    const expectedRows = mode === 'original' ? want.window + want.hoisted : want.window;
    if (expectedRows === 0) continue;
    const actual = got.rows.get(name) ?? 0;
    if (actual !== expectedRows) {
      return { reason: `${name}: expected ${expectedRows} rows, the slice has ${actual}` };
    }
  }
  for (const name of got.rows.keys()) {
    if (!scan.expected.has(name)) return { reason: `${name}: the slice has rows the scan did not plan` };
  }

  // Hoisted rows are stamped exactly on the window start, so every record that
  // carries its own clock should land in [t0, t1]. One outside it came from
  // somewhere the plan did not account for.
  if (Number.isFinite(got.minTime)) {
    if (got.minTime < window.startUs) {
      return { reason: `a record is stamped before the window (${got.minTime} < ${window.startUs})` };
    }
    if (got.maxTime > window.endUs) {
      return { reason: `a record is stamped after the window (${got.maxTime} > ${window.endUs})` };
    }
  }

  return null;
}
