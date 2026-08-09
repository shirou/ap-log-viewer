// Classifying a .bin's records into "inside the window" and "context the window
// needs to make sense on its own". The framing itself belongs to
// `scanDataflash`, which the reader uses too — that is what keeps the two in
// agreement about where records begin and how damage is resynced past.

import type { LogSource } from '../parsers/source.ts';
import type { ByteRange } from '../parsers/source.ts';
import {
  FMT_FORMAT,
  FMT_LABELS,
  FMT_TYPE,
  type MsgFormat,
  type ParseOptions,
  scanDataflash,
  timeOffsetOf,
} from '../parsers/dataflash.ts';
import { formatSize } from '../parsers/formatChars.ts';
import type { TimeWindow } from '../model/log.ts';
import { copyBytes, countExpected, pushRange, type ExpectedRows, type SliceScan } from './sliceTypes.ts';

/** Unit and multiplier tables. Tiny, and other readers use them for labels. */
const UNIT_TABLES = new Set(['FMTU', 'UNIT', 'MULT']);

/**
 * Firmware banner lines kept from before the window.
 *
 * `MSG` is also where a flight's text messages land — measured 35 of them
 * spread to 74% of a real log — so this is a cap, not a count.
 */
const MAX_BANNER_MSGS = 32;

interface ContextPart {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** Whether the window start was actually written into this record. */
  stamped: boolean;
}

/**
 * True for the file's own declaration of the FMT layout.
 *
 * Worth checking rather than trusting: `registerFormat` rejects every FMT for
 * type 128 because the table is seeded with it, so this record cannot be
 * validated the way the others are, and a byte-wise resync through damage can
 * forge one. Promoting a forged FMT-for-FMT to the front of the output would be
 * harmless to this reader — it bootstraps 128 itself — but would wreck every
 * reader that builds its table from the file, which is who slices exist for.
 */
function isCanonicalFmtDeclaration(values: Record<string, number | string>): boolean {
  return (
    values['Type'] === FMT_TYPE &&
    values['Format'] === FMT_FORMAT &&
    values['Name'] === 'FMT' &&
    // Column names too, not just the layout. Without this a record that happens
    // to carry the right type, length, name and format but garbage labels would
    // be taken as canonical, mark type 128 as seen, and lock the genuine
    // declaration out — leaving every reader that builds its table from the file
    // with the wrong names for FMT's own fields.
    values['Columns'] === FMT_LABELS.join(',') &&
    values['Length'] === 3 + formatSize(FMT_FORMAT)
  );
}

/**
 * Copy a record and move its clock to the window start.
 *
 * DataFlash carries no checksum, so the bytes can be rewritten in place. Only the
 * two eight-byte integer columns are touched: writing eight bytes over a narrower
 * one would run into the next field, and a record left unstamped keeps its
 * original clock, which `checkSlice` then reads as out of window and refuses the
 * whole slice. `Q` is what every log in the wild declares `TimeUS` as, but the
 * reader accepts `q` as a timestamp too (see formatChars), so this has to as well
 * or such a log could never be cut at all.
 */
function copyRestamped(
  chunk: Uint8Array,
  offset: number,
  length: number,
  fmt: MsgFormat,
  t0: number,
): ContextPart {
  const bytes = copyBytes(chunk, offset, length);
  const at = timeOffsetOf(fmt);
  if (at && (at.char === 'Q' || at.char === 'q')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stamp = BigInt(t0);
    if (at.char === 'Q') view.setBigUint64(3 + at.offset, stamp, true);
    else view.setBigInt64(3 + at.offset, stamp, true);
    return { name: fmt.name, bytes, stamped: true };
  }
  return { name: fmt.name, bytes, stamped: false };
}

export async function planDataflashSlice(
  source: LogSource,
  window: TimeWindow,
  opts: ParseOptions = {},
): Promise<SliceScan> {
  const { startUs: t0, endUs: t1 } = window;

  const structParts: Uint8Array<ArrayBuffer>[] = [];
  const fmtSeen = new Set<number>();

  // Context buckets, emitted in this order so an FMT always precedes any use of
  // it and the parameter block lands after the tables that describe it.
  const units: ContextPart[] = [];
  const versions: ContextPart[] = [];
  const banners: ContextPart[] = [];
  /**
   * One frame per parameter name: the last value at or before the window start,
   * or — for a name the log only ever reports later — its earliest. Without the
   * fallback a window over the first few seconds of a log carries no parameters
   * at all, measured on a real tlog whose first PARAM_VALUE lands at 14.7s.
   */
  const params = new Map<string, { part: ContextPart; fromBeforeWindow: boolean }>();
  const commands: ContextPart[] = [];
  let lastMode: ContextPart | null = null;

  const ranges: ByteRange[] = [];
  const expected = new Map<string, ExpectedRows>();
  let windowRecords = 0;
  let resyncBytes = 0;
  let prevEnd = 0;

  await scanDataflash(
    source,
    (r, chunk, chunkOffset) => {
      if (r.start > prevEnd) resyncBytes += r.start - prevEnd;
      prevEnd = r.end;
      const length = r.end - r.start;
      const fmt = r.format;

      // FMT first, before the window test. It is structure rather than a sample —
      // the reader never turns one into a row — so it is hoisted wherever it
      // sits, and it must not also be copied inside the window or the slice
      // would declare the type twice.
      if (fmt.type === FMT_TYPE) {
        const declared = r.values['Type'];
        if (typeof declared !== 'number' || fmtSeen.has(declared)) return;
        // Only declarations the registry accepted, so the slice's table is the
        // one this scan actually framed with. A forged duplicate lands after the
        // real one in the file and is ignored there; hoisting it blindly could
        // put it in front and misread every record of that type.
        if (r.fmtAccepted || isCanonicalFmtDeclaration(r.values)) {
          fmtSeen.add(declared);
          structParts.push(copyBytes(chunk, chunkOffset, length));
        }
        return;
      }

      // The window comes next, so nothing inside it is ever lifted into the
      // preamble. Hoisting a record that is already in view would move it to the
      // window start and drop it from where it belongs — measured at 340 lost
      // HEARTBEATs on one real window before this ordering was fixed.
      if (r.time >= t0 && r.time <= t1) {
        pushRange(ranges, r.start, r.end);
        countExpected(expected, fmt.name, 'window');
        windowRecords++;
        return;
      }

      const part = () => copyRestamped(chunk, chunkOffset, length, fmt, t0);

      // The two kinds of context that are worth taking from *either* side of the
      // window: the unit tables (a fixed table, measured at 240 records and
      // ~10 KB, that a reader needs whole to label anything) and parameters,
      // whose fallback is explicitly "the earliest reading anywhere" for a name
      // the log never reports before the window.
      if (UNIT_TABLES.has(fmt.name)) {
        units.push(part());
        return;
      }
      if (fmt.name === 'PARM') {
        const name = r.values['Name'];
        if (typeof name !== 'string') return;
        const cur = params.get(name);
        // A reading at or before the window start always wins: it is the value in
        // force there. Otherwise keep the earliest later one, and never let it
        // displace a pre-window reading.
        if (r.time <= t0) params.set(name, { part: part(), fromBeforeWindow: true });
        else if (!cur) params.set(name, { part: part(), fromBeforeWindow: false });
        return;
      }

      // Everything below describes the state the window opens in, so only what
      // came before it counts.
      if (r.time > t1) return;

      switch (fmt.name) {
        case 'VER':
          versions.push(part());
          return;
        case 'MSG':
          if (banners.length < MAX_BANNER_MSGS) banners.push(part());
          return;
        case 'MODE':
          lastMode = part();
          return;
        case 'CMD':
          commands.push(part());
          return;
        default:
          return;
      }
    },
    opts,
  );

  const ordered: ContextPart[] = [
    ...units,
    ...versions,
    ...banners,
    ...[...params.values()].map((p) => p.part),
    ...commands,
  ];
  if (lastMode) ordered.push(lastMode);

  // A record with no TimeUS column inherits the last stamp the reader saw, and
  // that starts at 0. Put the records whose clock could actually be rewritten
  // first, so a time-less one lands on the window start rather than at zero and
  // renders at a negative offset on the plot. Stable within each group, so the
  // bucket order above survives.
  const contextParts = [
    ...ordered.filter((p) => p.stamped),
    ...ordered.filter((p) => !p.stamped),
  ].map((p) => {
    countExpected(expected, p.name, 'hoisted');
    return p.bytes;
  });

  return {
    kind: 'bin',
    structParts,
    contextParts,
    ranges,
    expected,
    stats: {
      windowRecords,
      hoistedRecords: contextParts.length,
      rangeCount: ranges.length,
      resyncBytes,
    },
  };
}
