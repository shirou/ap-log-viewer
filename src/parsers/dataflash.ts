// DataFlash (.bin) parser. The format is self-describing: FMT messages at (or
// near) the start define the layout of every other message type, so this works
// across ArduPilot versions with no hardcoded message table.
//
// Wire layout of one message: 0xA3 0x95 <type:u8> <body...>
// The FMT message (type 128) declares: Type, Length, Name, Format, Columns.
//
// The file is read in chunks via LogSource.read(range) and parsed incrementally,
// carrying any partial trailing message into the next chunk. This keeps peak
// memory bounded by ~one chunk instead of loading a multi-GB file at once.
//
// The framing loop is exposed on its own as `scanDataflash`, and `parseDataflash`
// is one of its consumers. The other is the window slicer (src/export), which has
// to agree with this reader byte for byte — including where it resyncs through
// damage and which records inherit a timestamp. Sharing the loop makes that
// agreement structural instead of something a test has to keep watch over.

import type { LogData, MissionStep, ModeChange, TextMessage } from '../model/log.ts';
import type { LogSource } from './source.ts';
import { FORMAT_TYPES, formatSize } from './formatChars.ts';
import { LogBuilder, extractTrajectory, normalizeEvents, type ColumnDef } from './columnar.ts';
import { MissionCollector, sniffDegrees } from './mission.ts';

export const HEAD1 = 0xa3;
export const HEAD2 = 0x95;
export const FMT_TYPE = 0x80; // 128
const READ_CHUNK = 16 * 1024 * 1024; // 16 MiB

export interface MsgFormat {
  type: number;
  name: string;
  format: string;
  labels: string[];
  columns: ColumnDef[];
  bodySize: number; // bytes after the 3-byte header
}

// The FMT message has a fixed, well-known layout used to bootstrap parsing.
export const FMT_FORMAT = 'BBnNZ';
export const FMT_LABELS = ['Type', 'Length', 'Name', 'Format', 'Columns'];

export interface ParseOptions {
  onProgress?: (ratio: number) => void;
  /** Override the streaming read size (bytes). Mainly for tests. */
  chunkBytes?: number;
}

/**
 * One message as the reader framed it.
 *
 * `start`/`end` are absolute file offsets, so a caller can copy the exact bytes
 * back out. FMT records are visited too — the slicer has to re-emit them, and
 * `fmtAccepted` says whether this declaration is the one the registry took.
 */
export interface DataflashRecord {
  /** Absolute file offsets; [start, end) is every byte of this record. */
  start: number;
  end: number;
  /** The type definition this record was framed with. */
  format: MsgFormat;
  /** Decoded body, label -> value. */
  values: Record<string, number | string>;
  /**
   * Effective timestamp, microseconds. A record with no usable `TimeUS` column
   * inherits the last one seen, which is what keeps its fields plottable.
   */
  time: number;
  /** False when `time` was inherited rather than read from this record. */
  hasOwnTime: boolean;
  /** FMT records only: whether `registerFormat` accepted this declaration. */
  fmtAccepted: boolean;
}

/**
 * Called once per framed message.
 *
 * `chunk` is the buffer the record was framed in and `chunkOffset` is where the
 * record starts inside it, so `chunk.subarray(chunkOffset, chunkOffset + (end - start))`
 * is its bytes without going back to the source.
 *
 * The record object is REUSED between calls — copy anything you need to keep.
 * Framing a 65 MiB log visits 1.6 million records, and allocating one object per
 * record would double this loop's garbage for the sake of a convenience neither
 * consumer wants.
 */
export type DataflashVisitor = (r: DataflashRecord, chunk: Uint8Array, chunkOffset: number) => void;

function columnsFor(format: string, labels: string[]): ColumnDef[] {
  const cols: ColumnDef[] = [];
  for (let i = 0; i < format.length; i++) {
    cols.push({ label: labels[i] ?? `f${i}`, kind: FORMAT_TYPES[format[i]]?.kind ?? 'number' });
  }
  return cols;
}

/** A format table seeded with FMT itself, which is how every reader bootstraps. */
function createFormats(): Map<number, MsgFormat> {
  const formats = new Map<number, MsgFormat>();
  formats.set(FMT_TYPE, {
    type: FMT_TYPE,
    name: 'FMT',
    format: FMT_FORMAT,
    labels: FMT_LABELS,
    columns: columnsFor(FMT_FORMAT, FMT_LABELS),
    bodySize: formatSize(FMT_FORMAT),
  });
  return formats;
}

interface ScanState {
  formats: Map<number, MsgFormat>;
  lastTime: number;
  /** Reused across records; see DataflashVisitor. */
  rec: DataflashRecord;
}

/**
 * Frame every message in the source and hand each one to `visit`.
 *
 * This owns the parts a second reader must not re-derive: chunked reads with a
 * carry, byte-wise resync through damage, FMT registration, and the timestamp
 * inheritance that time-less records depend on.
 */
export async function scanDataflash(
  source: LogSource,
  visit: DataflashVisitor,
  opts: ParseOptions = {},
): Promise<void> {
  const formats = createFormats();
  const st: ScanState = {
    formats,
    lastTime: 0,
    // Filled in per record. Every field is written before each visit, so this
    // initial value is never observed.
    rec: {
      start: 0,
      end: 0,
      format: formats.get(FMT_TYPE)!,
      values: {},
      time: 0,
      hasOwnTime: false,
      fmtAccepted: false,
    },
  };

  const size = source.size;
  const chunkSize = opts.chunkBytes ?? READ_CHUNK;
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let filePos = 0;
  // Absolute file offset of buf[0]. Kept as its own running total rather than
  // derived from filePos and the buffer length: every record offset handed to a
  // visitor is `base + offset`, and that is not a place to be clever.
  let base = 0;

  while (filePos < size) {
    const end = Math.min(filePos + chunkSize, size);
    const chunk = await source.read({ start: filePos, end });
    filePos = end;

    // Prepend any partial message left from the previous chunk.
    let buf: Uint8Array<ArrayBufferLike>;
    if (carry.length) {
      const joined = new Uint8Array(carry.length + chunk.length);
      joined.set(carry, 0);
      joined.set(chunk, carry.length);
      buf = joined;
    } else {
      buf = chunk;
    }

    const consumed = scanChunk(buf, base, st, visit, filePos >= size);
    base += consumed;
    carry = buf.subarray(consumed);
    // Copy the carry out of `buf` so the (up to 16 MiB) chunk can be freed.
    if (carry.length) carry = carry.slice();

    if (opts.onProgress && size > 0) opts.onProgress(filePos / size);
  }
}

// Frame as many complete messages as the buffer holds. Returns the number of
// bytes consumed; the unconsumed tail is a partial message to carry forward.
// `final` allows consuming a trailing message even if the buffer ends exactly
// at its boundary (no more chunks are coming).
function scanChunk(
  bytes: Uint8Array,
  base: number,
  st: ScanState,
  visit: DataflashVisitor,
  final: boolean,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const rec = st.rec;
  let offset = 0;

  while (offset + 3 <= len) {
    if (bytes[offset] !== HEAD1 || bytes[offset + 1] !== HEAD2) {
      offset++; // resync on corruption / padding
      continue;
    }
    const type = bytes[offset + 2];
    const fmt = st.formats.get(type);
    if (!fmt) {
      offset++; // unknown type (FMT not seen yet) — skip a byte and resync
      continue;
    }
    const bodyStart = offset + 3;
    if (bodyStart + fmt.bodySize > len) break; // incomplete: carry to next chunk

    const values = readBody(view, bodyStart, fmt);
    const end = bodyStart + fmt.bodySize;

    rec.start = base + offset;
    rec.end = base + end;
    rec.format = fmt;
    rec.values = values;
    rec.fmtAccepted = false;

    if (type === FMT_TYPE) {
      // A declaration, not a sample. It carries no TimeUS and must not disturb
      // the inherited clock.
      const declared = values['Type'];
      const known = typeof declared === 'number' && st.formats.has(declared);
      registerFormat(st.formats, values);
      rec.fmtAccepted =
        !known && typeof declared === 'number' && st.formats.has(declared);
      rec.time = st.lastTime;
      rec.hasOwnTime = false;
    } else {
      const rawT = values['TimeUS'];
      if (typeof rawT === 'number' && Number.isFinite(rawT)) {
        rec.time = rawT;
        rec.hasOwnTime = true;
        st.lastTime = rawT;
      } else {
        // Time-less messages (FMT/UNIT/MULT, some PARM): stamp with surrounding
        // log time so their fields remain plottable.
        rec.time = st.lastTime;
        rec.hasOwnTime = false;
      }
    }

    visit(rec, bytes, offset);
    offset = end;
  }

  // At EOF, any leftover < 3 bytes (or a stray resync byte) can be dropped.
  if (final) return len;
  return offset;
}

interface ParseState {
  builder: LogBuilder;
  params: Record<string, number>;
  modes: ModeChange[];
  texts: TextMessage[];
  missionSteps: MissionStep[];
  mission: MissionCollector;
  minTime: number;
  maxTime: number;
}

export async function parseDataflash(source: LogSource, opts: ParseOptions = {}): Promise<LogData> {
  const st: ParseState = {
    builder: new LogBuilder(),
    params: {},
    modes: [],
    texts: [],
    missionSteps: [],
    mission: new MissionCollector(),
    minTime: Infinity,
    maxTime: -Infinity,
  };

  await scanDataflash(
    source,
    (r) => {
      // FMT is the format table talking about itself; it is not a sample.
      if (r.format.type === FMT_TYPE) return;
      // Only a record's own stamp bounds the log. An inherited one is a copy of a
      // bound already counted, and at the head of a file it is 0 — a floor no
      // record was ever written at.
      if (r.hasOwnTime) {
        if (r.time < st.minTime) st.minTime = r.time;
        if (r.time > st.maxTime) st.maxTime = r.time;
      }
      st.builder.push(r.format.type, r.format.name, r.format.columns, r.values, r.time);
      extractSpecial(st, r.format.name, r.values, r.time);
    },
    opts,
  );

  const messages = st.builder.finalize();
  const trajectory = extractTrajectory(
    messages,
    [
      { msg: 'POS', lat: 'Lat', lon: 'Lng', alt: 'Alt', latScale: 1, altScale: 1 },
      { msg: 'GPS', lat: 'Lat', lon: 'Lng', alt: 'Alt', latScale: 1, altScale: 1 },
      { msg: 'AHR2', lat: 'Lat', lon: 'Lng', alt: 'Alt', latScale: 1, altScale: 1 },
    ],
    // Heading (degrees): attitude yaw is best; fall back to GPS ground course.
    [
      { msg: 'ATT', field: 'Yaw', scale: 1 },
      { msg: 'AHR2', field: 'Yaw', scale: 1 },
      { msg: 'GPS', field: 'GCrs', scale: 1 },
    ],
  );

  let { minTime, maxTime } = st;
  if (!Number.isFinite(minTime)) {
    minTime = trajectory.time.length ? trajectory.time[0] : 0;
    maxTime = trajectory.time.length ? trajectory.time[trajectory.time.length - 1] : 0;
  }

  // TimeUS climbs steadily in a healthy .bin, but this reader resyncs through
  // damage and a corrupt row can carry any stamp at all. A mission item does not
  // start twice within one microsecond, so a repeat there is the reader's, not
  // the vehicle's.
  const missionSteps = normalizeEvents(st.missionSteps, (s) => s.seq);

  return {
    source: 'bin',
    messages,
    params: st.params,
    modes: st.modes,
    texts: st.texts,
    // A .bin records what the vehicle did, not what a GCS asked of it: there is
    // no COMMAND_LONG equivalent on disk. `CMD` looks like one but is the
    // uploaded plan re-dumped, which is already surfaced as `mission`.
    commands: [],
    missionSteps,
    trajectory,
    mission: st.mission.finalize(),
    startTime: minTime,
    endTime: maxTime,
  };
}

function readBody(view: DataView, start: number, fmt: MsgFormat): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  let o = start;
  for (let i = 0; i < fmt.format.length; i++) {
    const ch = fmt.format[i];
    const t = FORMAT_TYPES[ch];
    const label = fmt.labels[i] ?? `f${i}`;
    out[label] = t.read(view, o);
    o += t.size;
  }
  return out;
}

function registerFormat(formats: Map<number, MsgFormat>, values: Record<string, number | string>): void {
  const type = values['Type'] as number;
  const name = String(values['Name'] ?? '').trim();
  const format = String(values['Format'] ?? '');
  const labels = String(values['Columns'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!format || formats.has(type)) return;
  try {
    formats.set(type, { type, name, format, labels, columns: columnsFor(format, labels), bodySize: formatSize(format) });
  } catch {
    // Unknown format char — skip this message type rather than abort the log.
  }
}

/**
 * Where a record's `TimeUS` column sits within its body, or null when it has
 * none the reader would use.
 *
 * The `kind === 'number'` test is not belt-and-braces: a log that declares
 * `TimeUS` with a string format char reads as time-less in `scanDataflash`, so a
 * caller that located the column by label alone would rewrite bytes the reader
 * never looks at, and leave the row on its inherited clock.
 *
 * `char` comes back too because a caller writing a new stamp has to match the
 * declared width — every log in the wild uses `Q`, but writing eight bytes over
 * a four-byte column would run into the next field.
 */
export function timeOffsetOf(fmt: MsgFormat): { offset: number; char: string } | null {
  let acc = 0;
  for (let i = 0; i < fmt.format.length; i++) {
    const ch = fmt.format[i];
    const t = FORMAT_TYPES[ch];
    if (!t) return null;
    if (fmt.labels[i] === 'TimeUS') return t.kind === 'number' ? { offset: acc, char: ch } : null;
    acc += t.size;
  }
  return null;
}

function extractSpecial(
  st: ParseState,
  name: string,
  values: Record<string, number | string>,
  time: number,
): void {
  switch (name) {
    case 'PARM': {
      const n = values['Name'];
      const v = values['Value'];
      if (typeof n === 'string' && typeof v === 'number') st.params[n] = v;
      break;
    }
    case 'MSG': {
      const m = values['Message'];
      if (typeof m === 'string') st.texts.push({ time, text: m });
      break;
    }
    case 'MODE': {
      const mode = values['Mode'];
      const num = values['ModeNum'];
      const label = typeof mode === 'number' ? `Mode ${mode}` : String(mode ?? num ?? '?');
      // Collapse consecutive identical modes (MODE can be logged periodically).
      if (st.modes[st.modes.length - 1]?.mode !== label) st.modes.push({ time, mode: label });
      break;
    }
    // One item as it *starts executing* (4.6+). Shares CMD's layout but means
    // the opposite thing: a trace through the plan rather than the plan, which
    // makes it useless for `mission` — partial when a flight is cut short, and
    // repeating indices wherever a DO_JUMP loops — and exactly right here. It
    // is the .bin's answer to a tlog's MISSION_CURRENT.
    //
    // Every record is already an event, so unlike MISSION_CURRENT there is no
    // change filter: a plan that runs the same item twice in a row did so.
    case 'MISE': {
      const seq = values['CNum'];
      if (typeof seq !== 'number' || !Number.isFinite(seq)) break;
      // A record the reader decoded twice after resyncing across damage is
      // collapsed by normalizeEvents at the end, where the list is sorted and
      // the two copies are guaranteed to be neighbours.
      st.missionSteps.push({ time, seq });
      break;
    }
    // The uploaded mission, re-dumped in full whenever the plan changes:
    //   TimeUS,CTot,CNum,CId,Prm1..Prm4,Lat,Lng,Alt,Frame
    //
    // Deliberately not the source of `missionSteps` — see `MISE` above for the
    // difference, which is the whole reason both messages exist.
    case 'CMD': {
      const num = (label: string): number => {
        const v = values[label];
        return typeof v === 'number' ? v : NaN;
      };
      const seq = num('CNum');
      if (!Number.isFinite(seq)) break;
      // Lat/Lng are int32 degE7 on disk; the `L` format char already unscales
      // them, so sniffDegrees is here for logs that declare them otherwise.
      const { lat, lon } = sniffDegrees(num('Lat'), num('Lng'));
      st.mission.add({
        seq,
        command: num('CId'),
        lat,
        lon,
        alt: num('Alt'), // metres, in `Frame`
        frame: num('Frame'),
      });
      break;
    }
  }
}
