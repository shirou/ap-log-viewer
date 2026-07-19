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

import type { LogData, ModeChange, TextMessage } from '../model/log.ts';
import type { LogSource } from './source.ts';
import { FORMAT_TYPES, formatSize } from './formatChars.ts';
import { LogBuilder, extractTrajectory, type ColumnDef } from './columnar.ts';
import { MissionCollector, sniffDegrees } from './mission.ts';

const HEAD1 = 0xa3;
const HEAD2 = 0x95;
const FMT_TYPE = 0x80; // 128
const READ_CHUNK = 16 * 1024 * 1024; // 16 MiB

interface MsgFormat {
  type: number;
  name: string;
  format: string;
  labels: string[];
  columns: ColumnDef[];
  bodySize: number; // bytes after the 3-byte header
}

// The FMT message has a fixed, well-known layout used to bootstrap parsing.
const FMT_FORMAT = 'BBnNZ';
const FMT_LABELS = ['Type', 'Length', 'Name', 'Format', 'Columns'];

export interface ParseOptions {
  onProgress?: (ratio: number) => void;
  /** Override the streaming read size (bytes). Mainly for tests. */
  chunkBytes?: number;
}

interface ParseState {
  formats: Map<number, MsgFormat>;
  builder: LogBuilder;
  params: Record<string, number>;
  modes: ModeChange[];
  texts: TextMessage[];
  mission: MissionCollector;
  minTime: number;
  maxTime: number;
  lastTime: number;
}

function columnsFor(format: string, labels: string[]): ColumnDef[] {
  const cols: ColumnDef[] = [];
  for (let i = 0; i < format.length; i++) {
    cols.push({ label: labels[i] ?? `f${i}`, kind: FORMAT_TYPES[format[i]]?.kind ?? 'number' });
  }
  return cols;
}

export async function parseDataflash(source: LogSource, opts: ParseOptions = {}): Promise<LogData> {
  const st: ParseState = {
    formats: new Map(),
    builder: new LogBuilder(),
    params: {},
    modes: [],
    texts: [],
    mission: new MissionCollector(),
    minTime: Infinity,
    maxTime: -Infinity,
    lastTime: 0,
  };
  st.formats.set(FMT_TYPE, {
    type: FMT_TYPE,
    name: 'FMT',
    format: FMT_FORMAT,
    labels: FMT_LABELS,
    columns: columnsFor(FMT_FORMAT, FMT_LABELS),
    bodySize: formatSize(FMT_FORMAT),
  });

  const size = source.size;
  const chunkSize = opts.chunkBytes ?? READ_CHUNK;
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let filePos = 0;

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

    const consumed = parseChunk(buf, st, filePos >= size);
    carry = buf.subarray(consumed);
    // Copy the carry out of `buf` so the (up to 16 MiB) chunk can be freed.
    if (carry.length) carry = carry.slice();

    if (opts.onProgress && size > 0) opts.onProgress(filePos / size);
  }

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

  return {
    source: 'bin',
    messages,
    params: st.params,
    modes: st.modes,
    texts: st.texts,
    trajectory,
    mission: st.mission.finalize(),
    startTime: minTime,
    endTime: maxTime,
  };
}

// Parse as many complete messages as the buffer holds. Returns the number of
// bytes consumed; the unconsumed tail is a partial message to carry forward.
// `final` allows consuming a trailing message even if the buffer ends exactly
// at its boundary (no more chunks are coming).
function parseChunk(bytes: Uint8Array, st: ParseState, final: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
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

    if (type === FMT_TYPE) {
      registerFormat(st.formats, values);
    } else {
      const rawT = values['TimeUS'];
      let t: number;
      if (typeof rawT === 'number' && Number.isFinite(rawT)) {
        t = rawT;
        if (t < st.minTime) st.minTime = t;
        if (t > st.maxTime) st.maxTime = t;
        st.lastTime = t;
      } else {
        // Time-less messages (FMT/UNIT/MULT, some PARM): stamp with surrounding
        // log time so their fields remain plottable.
        t = st.lastTime;
      }
      st.builder.push(type, fmt.name, fmt.columns, values, t);
      extractSpecial(st, fmt.name, values, t);
    }

    offset = bodyStart + fmt.bodySize;
  }

  // At EOF, any leftover < 3 bytes (or a stray resync byte) can be dropped.
  if (final) return len;
  return offset;
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
    // The uploaded mission, re-dumped in full whenever the plan changes:
    //   TimeUS,CTot,CNum,CId,Prm1..Prm4,Lat,Lng,Alt,Frame
    //
    // 4.6 added a `MISE` message sharing this exact layout, and it is
    // deliberately not read here: MISE logs one item as it *starts executing*,
    // so it is not the plan but a trace through it — partial when a mission is
    // cut short, and repeating indices wherever a DO_JUMP loops.
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
