import { describe, expect, it } from 'vitest';
import { common, minimal } from 'mavlink-mappings';
import { parseDataflash } from '../parsers/dataflash.ts';
import { parseTlog } from '../parsers/tlog.ts';
import { rangeIndices } from '../lib/series.ts';
import type { LogData } from '../model/log.ts';
import type { LogKind } from '../model/log.ts';
import {
  GPS_COLUMNS,
  GPS_FORMAT,
  MODE_COLUMNS,
  MODE_FORMAT,
  MSG_COLUMNS,
  MSG_FORMAT,
  MemorySource,
  PARM_COLUMNS,
  PARM_FORMAT,
  PARM_NOTIME_COLUMNS,
  PARM_NOTIME_FORMAT,
  UNIT_COLUMNS,
  UNIT_FORMAT,
  VER_COLUMNS,
  VER_FORMAT,
  cmdMessage,
  CMD_COLUMNS,
  CMD_FORMAT,
  fmtForFmtMessage,
  fmtMessage,
  gpsMessage,
  modeMessage,
  msgMessage,
  parmMessage,
  parmNoTimeMessage,
  tlogRecord,
  unitMessage,
  verMessage,
  type MavField,
} from '../parsers/testFixtures.ts';
import {
  MAX_SLICE_BYTES,
  checkSlice,
  inspectSlice,
  isEmptyWindow,
  readSliceBytes,
  scanForSlice,
  sliceStats,
  sliceTooLarge,
  type SliceMode,
  type SliceScan,
} from './slice.ts';
import { TLOG_SLICE_IDS } from './sliceTlog.ts';

// ---- harness ----

const GPS = 130;
const PARM = 129;
const UNIT = 131;
const MODE = 132;
const EXTRA = 140;
const MSG = 133;
const VER = 134;
const CMD = 135;

async function cut(
  bytes: number[],
  kind: LogKind,
  t0: number,
  t1: number,
  mode: SliceMode = 'original',
  opts: { chunkBytes?: number } = {},
) {
  const all = new Uint8Array(bytes);
  const source = new MemorySource(kind === 'bin' ? 's.bin' : 's.tlog', all);
  const scan = await scanForSlice(source, kind, { startUs: t0, endUs: t1 }, opts);
  const out = await readSliceBytes(source, scan, mode);
  return { all, source, scan, out };
}

const reparse = (out: Uint8Array, kind: LogKind): Promise<LogData> =>
  kind === 'bin'
    ? parseDataflash(new MemorySource('o.bin', out))
    : parseTlog(new MemorySource('o.tlog', out));

/** Reframe the assembled slice and hold it to what the scan planned. */
async function verify(scan: SliceScan, out: Uint8Array, t0: number, t1: number, mode: SliceMode = 'original') {
  const got = await inspectSlice(new MemorySource('v', out), scan.kind);
  return { got, mismatch: checkSlice(scan, got, { startUs: t0, endUs: t1 }, mode) };
}

/** Count `A3 95 80` headers, i.e. FMT records, in a run of parts. */
function countFmt(parts: Uint8Array[]): number {
  let n = 0;
  for (const p of parts) for (let i = 0; i + 2 < p.length; i++) if (p[i] === 0xa3 && p[i + 1] === 0x95 && p[i + 2] === 0x80) n++;
  return n;
}

// A log with structure, context on both sides of the window, and four samples.
const BIN_FIXTURE = [
  ...fmtForFmtMessage(),
  ...fmtMessage(PARM, 'PARM', PARM_FORMAT, PARM_COLUMNS),
  ...fmtMessage(GPS, 'GPS', GPS_FORMAT, GPS_COLUMNS),
  ...fmtMessage(UNIT, 'UNIT', UNIT_FORMAT, UNIT_COLUMNS),
  ...fmtMessage(MODE, 'MODE', MODE_FORMAT, MODE_COLUMNS),
  ...unitMessage(UNIT, 400, 1, 'm'),
  ...parmMessage(PARM, 100, 'P1', 1),
  ...parmMessage(PARM, 200, 'P1', 2),
  ...modeMessage(MODE, 250, 1),
  ...modeMessage(MODE, 300, 3),
  ...gpsMessage(GPS, 1_000_000, 35.0, 139.0, 10),
  ...gpsMessage(GPS, 2_000_000, 35.1, 139.1, 20),
  ...gpsMessage(GPS, 3_000_000, 35.2, 139.2, 30),
  ...gpsMessage(GPS, 4_000_000, 35.3, 139.3, 40),
  // A parameter this log only ever reports after the window.
  ...parmMessage(PARM, 3_500_000, 'LATE', 7),
];

// Context of every kind the .bin planner knows how to carry: a version line, more
// banner lines than the cap allows, and an uploaded plan.
const CONTEXT_FIXTURE = [
  ...fmtForFmtMessage(),
  ...fmtMessage(GPS, 'GPS', GPS_FORMAT, GPS_COLUMNS),
  ...fmtMessage(MSG, 'MSG', MSG_FORMAT, MSG_COLUMNS),
  ...fmtMessage(VER, 'VER', VER_FORMAT, VER_COLUMNS),
  ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
  ...verMessage(VER, 100, 4, 5),
  ...cmdMessage(CMD, { seq: 0, lat: 35, lon: 139, alt: 50, timeUS: 200 }),
  ...Array.from({ length: 40 }, (_, i) => msgMessage(MSG, 300 + i, `banner ${i}`)).flat(),
  ...gpsMessage(GPS, 2_000_000, 1, 2, 3),
  ...gpsMessage(GPS, 3_000_000, 1, 2, 3),
];

describe('slicing a .bin', () => {
  // The invariant the rest of this file is specific failures of.
  it('cuts a data slice that reparses to exactly rangeIndices of a full parse', async () => {
    const full = await reparse(new Uint8Array(BIN_FIXTURE), 'bin');
    const { out } = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000, 'data');
    const sliced = await reparse(out, 'bin');

    for (const [name, series] of Object.entries(full.messages)) {
      const [i0, i1] = rangeIndices(series.time, 2_000_000, 3_000_000);
      const want = Array.from(series.time.slice(i0, i1));
      const got = Array.from(sliced.messages[name]?.time ?? []);
      expect(got, name).toEqual(want);
    }
  });

  it('carries the structure but no context into a data slice', async () => {
    const { out } = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000, 'data');
    const sliced = await reparse(out, 'bin');
    expect(Object.keys(sliced.messages)).toEqual(['GPS']);
    expect(sliced.params).toEqual({});
  });

  // A data slice carries no context, so nothing sets the reader's clock before the
  // window's own records — which looks like it should leave a time-less record in
  // the window inheriting zero. It cannot: such a record is only *in* the window
  // when the record it inherits from is too, and that one precedes it in the byte
  // stream, so the slice carries it along and the clock is already right.
  it('keeps a time-less record in the window on its inherited clock, with no context to anchor it', async () => {
    const NOTIME = 141;
    const bytes = [
      ...fmtForFmtMessage(),
      ...fmtMessage(GPS, 'GPS', GPS_FORMAT, GPS_COLUMNS),
      ...fmtMessage(NOTIME, 'NOTM', PARM_NOTIME_FORMAT, PARM_NOTIME_COLUMNS),
      ...gpsMessage(GPS, 1_500_000, 1, 2, 3),
      ...parmNoTimeMessage(NOTIME, 'A', 1), // inherits 1.5s — outside the window
      ...gpsMessage(GPS, 2_500_000, 1, 2, 3),
      ...parmNoTimeMessage(NOTIME, 'B', 2), // inherits 2.5s — inside it
      ...gpsMessage(GPS, 3_000_000, 1, 2, 3),
    ];
    const { out } = await cut(bytes, 'bin', 2_000_000, 3_500_000, 'data');
    const sliced = await reparse(out, 'bin');
    expect(Array.from(sliced.messages.NOTM.time)).toEqual([2_500_000]);
    // And the log's own bounds come from records carrying their own clock, so a
    // time-less row can never drag them to zero either.
    expect(sliced.startTime).toBe(2_500_000);
    expect(sliced.endTime).toBe(3_000_000);
  });

  it('adds one row per hoisted record to an original slice, all on the window start', async () => {
    const { scan, out } = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'bin');

    expect(Array.from(sliced.messages.GPS.time)).toEqual([2_000_000, 3_000_000]);
    // One UNIT, one MODE, and one PARM per name: P1 as of the window start, LATE
    // as the only reading the log ever gives.
    expect(Array.from(sliced.messages.PARM.time)).toEqual([2_000_000, 2_000_000]);
    expect(Array.from(sliced.messages.UNIT.time)).toEqual([2_000_000]);
    expect(Array.from(sliced.messages.MODE.time)).toEqual([2_000_000]);
    expect(sliced.startTime).toBe(2_000_000);
    expect(scan.stats.windowRecords).toBe(2);
    expect(scan.stats.rangeCount).toBe(1);
  });

  it('keeps the parameter value in force at the window start, and the earliest of one reported later', async () => {
    const { out } = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'bin');
    expect(sliced.params).toEqual({ P1: 2, LATE: 7 });
  });

  it('keeps only the last mode before the window', async () => {
    const { out } = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'bin');
    expect(sliced.modes.map((m) => m.mode)).toEqual(['Mode 3']);
  });

  it('emits the file\'s own FMT-for-FMT record', async () => {
    const { scan } = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000);
    // Five declarations: FMT, PARM, GPS, UNIT, MODE.
    expect(countFmt(scan.structParts)).toBe(5);
  });

  // A resync through damage can forge one. In the original it lands after the
  // real declaration and is ignored; hoisted blindly it could land in front.
  it('does not promote a second declaration of a type ahead of the accepted one', async () => {
    const withDupe = [
      ...BIN_FIXTURE.slice(0, fmtForFmtMessage().length),
      // A conflicting GPS declaration, then the real one.
      ...fmtMessage(GPS, 'GPS', 'Qf', 'TimeUS,Alt'),
      ...BIN_FIXTURE.slice(fmtForFmtMessage().length),
    ];
    const { scan } = await cut(withDupe, 'bin', 2_000_000, 3_000_000);
    // Still one declaration per type: FMT, GPS(first accepted), PARM, UNIT, MODE.
    expect(countFmt(scan.structParts)).toBe(5);
  });

  it('rejects a forged FMT-for-FMT that does not describe the real layout', async () => {
    const forged = [
      ...fmtMessage(0x80, 'FMT', 'Qf', 'TimeUS,X'), // wrong Format for type 128
      ...BIN_FIXTURE,
    ];
    const { scan } = await cut(forged, 'bin', 2_000_000, 3_000_000);
    // The forged one is skipped; the genuine one inside BIN_FIXTURE is taken.
    expect(countFmt(scan.structParts)).toBe(5);
  });

  // The reader treats signed 64-bit `q` as a timestamp too (formatChars), so a log
  // declaring TimeUS that way must still be cuttable. Left unstamped, the carried
  // record keeps its pre-window clock and checkSlice refuses the whole slice.
  it('restamps a signed 64-bit TimeUS as well as an unsigned one', async () => {
    const bytes = [
      ...fmtForFmtMessage(),
      ...fmtMessage(GPS, 'GPS', GPS_FORMAT, GPS_COLUMNS),
      ...fmtMessage(PARM, 'PARM', `q${PARM_FORMAT.slice(1)}`, PARM_COLUMNS),
      ...parmMessage(PARM, 100, 'P1', 1),
      ...gpsMessage(GPS, 2_000_000, 1, 2, 3),
      ...gpsMessage(GPS, 3_000_000, 1, 2, 3),
    ];
    const { scan, out } = await cut(bytes, 'bin', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'bin');
    expect(Array.from(sliced.messages.PARM.time)).toEqual([2_000_000]);
    const { mismatch } = await verify(scan, out, 2_000_000, 3_000_000);
    expect(mismatch).toBeNull();
  });

  // The canonical check is the only thing standing between a corrupt region and
  // the front of the output, and this reader cannot notice: it seeds type 128
  // itself, so a wrong FMT-for-FMT only hurts whoever reads the slice next.
  it('does not let a forged FMT-for-FMT with wrong column names lock out the real one', async () => {
    const forged = [
      // Right type, length, name and format; only the labels are garbage.
      ...fmtMessage(0x80, 'FMT', 'BBnNZ', 'X'),
      ...BIN_FIXTURE,
    ];
    const { scan } = await cut(forged, 'bin', 2_000_000, 3_000_000);
    // The first declaration emitted is FMT's own; read its Columns field back.
    const first = scan.structParts[0];
    const columns = String.fromCharCode(...first.subarray(25, 25 + 32)).replace(/\0.*$/, '');
    expect(columns).toBe('Type,Length,Name,Format,Columns');
  });

  it('hoists a declaration that first appears inside the window', async () => {
    const late = [
      ...BIN_FIXTURE.slice(0, BIN_FIXTURE.length),
      ...fmtMessage(EXTRA, 'XTRA', GPS_FORMAT, GPS_COLUMNS),
      ...gpsMessage(EXTRA, 2_500_000, 1, 2, 3),
    ];
    // Put the new declaration and its record inside the window by cutting wide.
    const { scan, out } = await cut(late, 'bin', 2_000_000, 3_600_000);
    const sliced = await reparse(out, 'bin');
    expect(sliced.messages.XTRA.time.length).toBe(1);
    // Lifting the FMT out of the middle leaves a hole in the copied bytes.
    expect(scan.stats.rangeCount).toBeGreaterThan(1);
    const { mismatch } = await verify(scan, out, 2_000_000, 3_600_000);
    expect(mismatch).toBeNull();
  });

  it('leaves records that are already inside the window where they are', async () => {
    const inside = [
      ...BIN_FIXTURE,
      ...unitMessage(UNIT, 2_500_000, 2, 'deg'),
      ...parmMessage(PARM, 2_600_000, 'INWIN', 5),
    ];
    const { scan, out } = await cut(inside, 'bin', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'bin');
    // The in-window UNIT keeps its own stamp instead of being moved to t0.
    expect(Array.from(sliced.messages.UNIT.time)).toEqual([2_000_000, 2_500_000]);
    expect(Array.from(sliced.messages.PARM.time)).toContain(2_600_000);
    const { mismatch } = await verify(scan, out, 2_000_000, 3_000_000);
    expect(mismatch).toBeNull();
  });

  it('stamps a record with no TimeUS column onto the window start', async () => {
    const NOTIME = 141;
    const bytes = [
      ...fmtForFmtMessage(),
      ...fmtMessage(GPS, 'GPS', GPS_FORMAT, GPS_COLUMNS),
      ...fmtMessage(UNIT, 'UNIT', UNIT_FORMAT, UNIT_COLUMNS),
      ...fmtMessage(NOTIME, 'PARM', PARM_NOTIME_FORMAT, PARM_NOTIME_COLUMNS),
      ...unitMessage(UNIT, 400, 1, 'm'),
      ...parmNoTimeMessage(NOTIME, 'P1', 1),
      ...gpsMessage(GPS, 2_000_000, 1, 2, 3),
      ...gpsMessage(GPS, 3_000_000, 1, 2, 3),
    ];
    const { out } = await cut(bytes, 'bin', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'bin');
    // The UNIT, whose clock could be rewritten, is emitted first so the time-less
    // record inherits the window start rather than zero.
    expect(Array.from(sliced.messages.PARM.time)).toEqual([2_000_000]);
  });

  it('leaves a time-less record at zero when no hoisted record carries a clock', async () => {
    const NOTIME = 141;
    const bytes = [
      ...fmtForFmtMessage(),
      ...fmtMessage(GPS, 'GPS', GPS_FORMAT, GPS_COLUMNS),
      ...fmtMessage(NOTIME, 'PARM', PARM_NOTIME_FORMAT, PARM_NOTIME_COLUMNS),
      ...parmNoTimeMessage(NOTIME, 'P1', 1),
      ...gpsMessage(GPS, 2_000_000, 1, 2, 3),
    ];
    const { out } = await cut(bytes, 'bin', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'bin');
    // Documented limitation, not a defect to chase: with nothing to anchor to the
    // row keeps the reader's initial clock. The log's own start is unaffected,
    // because a time-less record never moves minTime.
    expect(Array.from(sliced.messages.PARM.time)).toEqual([0]);
    expect(sliced.startTime).toBe(2_000_000);
  });

  // The carry and the running absolute offset are the easy things to get wrong.
  it('plans the same cut however small the reads are', async () => {
    const a = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000);
    const b = await cut(BIN_FIXTURE, 'bin', 2_000_000, 3_000_000, 'original', { chunkBytes: 7 });
    expect(b.scan.ranges).toEqual(a.scan.ranges);
    expect(Array.from(b.out)).toEqual(Array.from(a.out));
  });

  it('reports no window records when the window lands between samples', async () => {
    const { scan } = await cut(BIN_FIXTURE, 'bin', 2_100_000, 2_900_000);
    expect(scan.ranges).toEqual([]);
    expect(scan.stats.windowRecords).toBe(0);
  });

  it('drops a truncated trailing record', async () => {
    const truncated = [...BIN_FIXTURE, 0xa3, 0x95, GPS, 1, 2, 3];
    const { scan, out } = await cut(truncated, 'bin', 2_000_000, 4_000_000);
    const { mismatch } = await verify(scan, out, 2_000_000, 4_000_000);
    expect(mismatch).toBeNull();
  });

  it('resyncs past corrupt bytes the way the reader does', async () => {
    const head = BIN_FIXTURE.length - gpsMessage(GPS, 0, 0, 0, 0).length - parmMessage(PARM, 0, '', 0).length;
    const damaged = [...BIN_FIXTURE.slice(0, head), 0x00, ...BIN_FIXTURE.slice(head)];
    const { scan, out } = await cut(damaged, 'bin', 2_000_000, 4_000_000);
    const sliced = await reparse(out, 'bin');
    // The junk byte is not copied, so the slice itself frames cleanly.
    expect(scan.stats.resyncBytes).toBe(1);
    const { got, mismatch } = await verify(scan, out, 2_000_000, 4_000_000);
    expect(got.gapBytes).toBe(0);
    expect(mismatch).toBeNull();
    expect(sliced.messages.GPS.time.length).toBeGreaterThan(0);
  });
});

describe('carrying context into a .bin slice', () => {
  const t0 = 2_000_000;
  const t1 = 3_000_000;

  it('carries the version line and the uploaded plan across', async () => {
    const { out } = await cut(CONTEXT_FIXTURE, 'bin', t0, t1);
    const sliced = await reparse(out, 'bin');
    expect(Array.from(sliced.messages.VER.time)).toEqual([t0]);
    expect(Array.from(sliced.messages.CMD.time)).toEqual([t0]);
    // CMD is how a .bin records the plan, so the slice can still draw it.
    expect(sliced.mission.map((w) => w.seq)).toEqual([0]);
    expect(sliced.mission[0].lat).toBeCloseTo(35, 5);
  });

  // MSG is also where a flight's text messages land — measured 35 of them spread
  // to 74% of a real log — so the cap is what stops a slice's preamble growing
  // without bound.
  it('stops carrying banner lines at the cap', async () => {
    const { scan, out } = await cut(CONTEXT_FIXTURE, 'bin', t0, t1);
    const sliced = await reparse(out, 'bin');
    expect(sliced.messages.MSG.time.length).toBe(32);
    expect(scan.expected.get('MSG')).toEqual({ window: 0, hoisted: 32 });
    expect(sliced.texts.length).toBe(32);
  });

  it('passes verification with every kind of context aboard', async () => {
    const { scan, out } = await cut(CONTEXT_FIXTURE, 'bin', t0, t1);
    const { got, mismatch } = await verify(scan, out, t0, t1);
    expect(got.gapBytes).toBe(0);
    expect(mismatch).toBeNull();
  });
});

describe('verifying a slice', () => {
  const window = { t0: 2_000_000, t1: 3_000_000 };

  it('accepts a slice the scan actually produced', async () => {
    const { scan, out } = await cut(BIN_FIXTURE, 'bin', window.t0, window.t1);
    const { got, mismatch } = await verify(scan, out, window.t0, window.t1);
    expect(got.gapBytes).toBe(0);
    expect(mismatch).toBeNull();
  });

  // Without this the "verification" is theatre: a .bin missing its format table
  // reframes without throwing, one skipped byte at a time, and finds nothing.
  it('rejects a slice whose format table lost a declaration', async () => {
    const { source, scan } = await cut(BIN_FIXTURE, 'bin', window.t0, window.t1);
    const broken: SliceScan = { ...scan, structParts: scan.structParts.slice(0, 2) };
    const out = await readSliceBytes(source, broken, 'original');
    const { mismatch } = await verify(scan, out, window.t0, window.t1);
    expect(mismatch?.reason).toMatch(/did not frame/);
  });

  it('rejects a slice whose byte ranges came out short', async () => {
    const { source, scan } = await cut(BIN_FIXTURE, 'bin', window.t0, window.t1);
    const short: SliceScan = {
      ...scan,
      ranges: scan.ranges.map((r) => ({ start: r.start, end: r.end - 1 })),
    };
    const out = await readSliceBytes(source, short, 'original');
    const { mismatch } = await verify(scan, out, window.t0, window.t1);
    expect(mismatch).not.toBeNull();
  });

  // The only check that says the window selection itself was right. Without a
  // negative test for it, copyRestamped could stamp context anywhere inside the
  // window — or the branch could be deleted — and nothing would notice.
  it('rejects a slice whose carried-in record is stamped outside the window', async () => {
    const { source, scan } = await cut(BIN_FIXTURE, 'bin', window.t0, window.t1);
    // The first context part is the UNIT record, whose TimeUS sits at the start
    // of its body: three bytes past the record header.
    const patched = scan.contextParts.map((p, i) => {
      if (i !== 0) return p;
      const copy = new Uint8Array(p);
      new DataView(copy.buffer).setBigUint64(3, BigInt(window.t1 + 1000), true);
      return copy;
    });
    const moved: SliceScan = { ...scan, contextParts: patched };
    const out = await readSliceBytes(source, moved, 'original');
    const { got, mismatch } = await verify(scan, out, window.t0, window.t1);
    // Row counts and framing are untouched, so this is the time check firing.
    expect(got.gapBytes).toBe(0);
    expect(mismatch?.reason).toMatch(/stamped after the window/);
  });

  it('rejects a slice that lost a hoisted record', async () => {
    const { source, scan } = await cut(BIN_FIXTURE, 'bin', window.t0, window.t1);
    const fewer: SliceScan = { ...scan, contextParts: scan.contextParts.slice(1) };
    const out = await readSliceBytes(source, fewer, 'original');
    const { mismatch } = await verify(scan, out, window.t0, window.t1);
    expect(mismatch?.reason).toMatch(/expected \d+ rows/);
  });
});

// These two decide what the worker refuses and what the reader is told a slice
// holds. They live outside the worker because a worker module assigns
// `self.onmessage` as it loads and there is no `self` under node, so anything left
// in there is untestable by construction.
describe('what the worker reports', () => {
  const t0 = 2_000_000;
  const t1 = 3_000_000;

  it('calls a window with no records empty, however the scan came out', async () => {
    const { scan } = await cut(BIN_FIXTURE, 'bin', t0, t1);
    expect(isEmptyWindow(scan)).toBe(false);
    // Either half is enough on its own: a preamble-only slice still frames into
    // message types, so counting those would never notice.
    expect(isEmptyWindow({ ...scan, stats: { ...scan.stats, windowRecords: 0 } })).toBe(true);
    expect(isEmptyWindow({ ...scan, ranges: [] })).toBe(true);

    const empty = await cut(BIN_FIXTURE, 'bin', 2_100_000, 2_900_000);
    expect(isEmptyWindow(empty.scan)).toBe(true);
  });

  it('refuses a slice too large to assemble, and says how large', async () => {
    const { scan } = await cut(BIN_FIXTURE, 'bin', t0, t1);
    // A real window is nowhere near the ceiling — the largest measured is 1.4 MB.
    expect(sliceTooLarge(scan, 'original')).toBeNull();
    expect(sliceTooLarge(scan, 'data')).toBeNull();

    // One range claiming more bytes than the ceiling allows. The answer is the
    // size, not a flag, so the message can tell the reader how far over they are.
    const huge: SliceScan = {
      ...scan,
      ranges: [{ start: 0, end: MAX_SLICE_BYTES + 1 }],
    };
    expect(sliceTooLarge(huge, 'original')).toBeGreaterThan(MAX_SLICE_BYTES);

    // The two modes are measured apart: a data slice leaves the context out, so
    // it can fit where the original does not.
    const context = scan.contextParts.reduce((n, p) => n + p.byteLength, 0);
    expect(context).toBeGreaterThan(0);
    const borderline: SliceScan = {
      ...scan,
      structParts: [],
      ranges: [{ start: 0, end: MAX_SLICE_BYTES }],
    };
    expect(sliceTooLarge(borderline, 'data')).toBeNull();
    expect(sliceTooLarge(borderline, 'original')).toBe(MAX_SLICE_BYTES + context);
  });

  it('reports the window rows apart from the carried-in ones', async () => {
    const { scan, out } = await cut(BIN_FIXTURE, 'bin', t0, t1);
    const got = await inspectSlice(new MemorySource('v', out), 'bin');
    const stats = sliceStats(scan, got, 'original', out.byteLength);

    expect(stats.windowRows).toBe(scan.stats.windowRecords);
    expect(stats.hoistedRows).toBe(scan.stats.hoistedRecords);
    expect(stats.hoistedRows).toBeGreaterThan(0);
    expect(stats.messageTypes).toBe(got.rows.size);
    expect(stats.startTime).toBe(t0);
    expect(stats.endTime).toBe(t1);
    expect(stats.bytes).toBe(out.byteLength);
  });

  // A data slice takes the structure and none of the context, so saying otherwise
  // would credit it with rows it does not carry.
  it('credits a data slice with no carried-in rows', async () => {
    const { scan, out } = await cut(BIN_FIXTURE, 'bin', t0, t1, 'data');
    const got = await inspectSlice(new MemorySource('v', out), 'bin');
    const stats = sliceStats(scan, got, 'data', out.byteLength);
    expect(scan.stats.hoistedRecords).toBeGreaterThan(0);
    expect(stats.hoistedRows).toBe(0);
  });
});

// ---- tlog ----

const cls = (c: unknown) => c as unknown as { MSG_ID: number; PAYLOAD_LENGTH: number; FIELDS: MavField[] };
const ATT = cls(common.Attitude);
const PV = cls(common.ParamValue);
const HB = cls(minimal.Heartbeat);
const MC = cls(common.MissionCount);
const MI = cls(common.MissionItemInt);
const deg = (d: number) => Math.round(d * 1e7);

const TLOG_FIXTURE = [
  ...tlogRecord(500_000, PV, { paramValue: 1 }, { strings: { paramId: 'A' } }),
  ...tlogRecord(1_500_000, PV, { paramValue: 2 }, { strings: { paramId: 'A' } }),
  // A ground station heartbeat, newer than the vehicle's, claiming mode 0.
  ...tlogRecord(1_800_000, HB, { type: 2, customMode: 5 }),
  ...tlogRecord(1_900_000, HB, { type: 6, customMode: 0 }, { sysid: 255, compid: 190 }),
  ...tlogRecord(1_000_000, ATT, { roll: 0.1 }),
  ...tlogRecord(2_000_000, ATT, { roll: 0.2 }),
  ...tlogRecord(3_000_000, ATT, { roll: 0.3 }),
  ...tlogRecord(4_000_000, ATT, { roll: 0.4 }),
  ...tlogRecord(3_500_000, PV, { paramValue: 9 }, { strings: { paramId: 'B' } }),
];

describe('slicing a .tlog', () => {
  it('cuts a data slice that reparses to exactly rangeIndices of a full parse', async () => {
    const full = await reparse(new Uint8Array(TLOG_FIXTURE), 'tlog');
    const { out } = await cut(TLOG_FIXTURE, 'tlog', 2_000_000, 3_000_000, 'data');
    const sliced = await reparse(out, 'tlog');

    for (const [name, series] of Object.entries(full.messages)) {
      const [i0, i1] = rangeIndices(series.time, 2_000_000, 3_000_000);
      const want = Array.from(series.time.slice(i0, i1));
      const got = Array.from(sliced.messages[name]?.time ?? []);
      expect(got, name).toEqual(want);
    }
  });

  it('needs no structural preamble at all', async () => {
    const { scan } = await cut(TLOG_FIXTURE, 'tlog', 2_000_000, 3_000_000);
    expect(scan.structParts).toEqual([]);
  });

  it('keeps the parameter in force at the window start, and the earliest of one reported later', async () => {
    const { out } = await cut(TLOG_FIXTURE, 'tlog', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'tlog');
    expect(sliced.params).toEqual({ A: 2, B: 9 });
    // Two names, one frame each: the repeats are dropped, and both land exactly
    // on the window start rather than merely inside it.
    expect(Array.from(sliced.messages.PARAM_VALUE.time)).toEqual([2_000_000, 2_000_000]);
  });

  // A GCS heartbeats about twice as often as the vehicle on a real session, so
  // "the newest heartbeat" is usually its mode 0, which the vehicle was never in.
  it('carries the vehicle heartbeat across, not the newer ground-station one', async () => {
    const { out } = await cut(TLOG_FIXTURE, 'tlog', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'tlog');
    expect(sliced.messages.HEARTBEAT.time.length).toBe(1);
    expect(sliced.modes.map((m) => m.mode)).toEqual(['Mode 5']);
  });

  it('carries a mission transfer across, boundaries and all', async () => {
    const item = (seq: number, lat: number) => ({ seq, command: 16, frame: 3, x: deg(lat), y: deg(139), z: 50, missionType: 0 });
    const bytes = [
      ...tlogRecord(100_000, MC, { count: 3, missionType: 0 }),
      ...tlogRecord(110_000, MI, item(0, 35.0)),
      ...tlogRecord(120_000, MI, item(1, 35.001)),
      ...tlogRecord(130_000, MI, item(2, 35.002)),
      // A shorter plan replaces it before the window opens.
      ...tlogRecord(140_000, MC, { count: 2, missionType: 0 }),
      ...tlogRecord(150_000, MI, item(0, 36.0)),
      ...tlogRecord(160_000, MI, item(1, 36.001)),
      ...tlogRecord(2_000_000, ATT, { roll: 0.2 }),
      ...tlogRecord(3_000_000, ATT, { roll: 0.3 }),
    ];
    const { out } = await cut(bytes, 'tlog', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'tlog');
    expect(sliced.mission.map((w) => w.seq)).toEqual([0, 1]);
    expect(sliced.mission[0].lat).toBeCloseTo(36.0, 5);
  });

  it('frames MAVLink 1 and 2 records alike', async () => {
    const bytes = [
      ...tlogRecord(2_000_000, ATT, { roll: 0.2 }, { v1: true }),
      ...tlogRecord(2_500_000, ATT, { roll: 0.25 }),
      ...tlogRecord(3_000_000, ATT, { roll: 0.3 }, { v1: true }),
    ];
    const { scan, out } = await cut(bytes, 'tlog', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'tlog');
    expect(sliced.messages.ATTITUDE.time.length).toBe(3);
    expect(scan.stats.rangeCount).toBe(1);
  });

  it('steps over a signed frame\'s 13-byte signature', async () => {
    const bytes = [
      ...tlogRecord(2_000_000, ATT, { roll: 0.2 }, { signed: true }),
      ...tlogRecord(2_500_000, ATT, { roll: 0.25 }),
    ];
    const { scan, out } = await cut(bytes, 'tlog', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'tlog');
    expect(sliced.messages.ATTITUDE.time.length).toBe(2);
    expect(scan.stats.rangeCount).toBe(1);
  });

  it('includes the records sitting exactly on each end of the window', async () => {
    const { out } = await cut(TLOG_FIXTURE, 'tlog', 2_000_000, 3_000_000, 'data');
    const sliced = await reparse(out, 'tlog');
    expect(Array.from(sliced.messages.ATTITUDE.time)).toEqual([2_000_000, 3_000_000]);
  });

  it('resyncs past a stray byte the way the reader does', async () => {
    const bytes = [
      ...tlogRecord(2_000_000, ATT, { roll: 0.2 }),
      0x00,
      ...tlogRecord(3_000_000, ATT, { roll: 0.3 }),
    ];
    const { scan, out } = await cut(bytes, 'tlog', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'tlog');
    expect(scan.stats.resyncBytes).toBe(1);
    expect(sliced.messages.ATTITUDE.time.length).toBe(2);
    // The stray byte is not copied, so the slice itself frames cleanly.
    const { got, mismatch } = await verify(scan, out, 2_000_000, 3_000_000);
    expect(got.gapBytes).toBe(0);
    expect(mismatch).toBeNull();
  });

  // MAVLink 2 trims trailing zeros off the wire, so a real PARAM_VALUE routinely
  // carries less than the sixteen bytes its name is declared with.
  it('reads a parameter name out of a frame whose zeros were trimmed', async () => {
    const bytes = [
      // Cut to twelve bytes: four characters of the name survive, with no
      // terminator to stop at.
      ...tlogRecord(1_000_000, PV, { paramValue: 3 }, { strings: { paramId: 'ABCD' }, truncateTo: 12 }),
      // Cut to the name's own offset: nothing of it is left to key on.
      ...tlogRecord(1_100_000, PV, { paramValue: 4 }, { strings: { paramId: 'GONE' }, truncateTo: 8 }),
      ...tlogRecord(2_000_000, ATT, { roll: 0.2 }),
      ...tlogRecord(3_000_000, ATT, { roll: 0.3 }),
    ];
    const { out } = await cut(bytes, 'tlog', 2_000_000, 3_000_000);
    const sliced = await reparse(out, 'tlog');
    expect(Object.keys(sliced.params)).toEqual(['ABCD']);
    expect(sliced.params.ABCD).toBe(3);
  });

  it('passes verification', async () => {
    const { scan, out } = await cut(TLOG_FIXTURE, 'tlog', 2_000_000, 3_000_000);
    const { got, mismatch } = await verify(scan, out, 2_000_000, 3_000_000);
    expect(got.gapBytes).toBe(0);
    expect(mismatch).toBeNull();
  });
});

// The ids and offsets are frozen by the MAVLink spec, but they are read out of
// the dialect rather than written down, and this is what says so.
describe('MAVLink constants', () => {
  it('match the dialect the parser uses', () => {
    expect(TLOG_SLICE_IDS.MSG_HEARTBEAT).toBe(minimal.Heartbeat.MSG_ID);
    expect(TLOG_SLICE_IDS.MSG_PARAM_VALUE).toBe(common.ParamValue.MSG_ID);
    expect(TLOG_SLICE_IDS.MSG_MISSION_COUNT).toBe(common.MissionCount.MSG_ID);
    expect(TLOG_SLICE_IDS.MSG_MISSION_ITEM).toBe(common.MissionItem.MSG_ID);
    expect(TLOG_SLICE_IDS.MSG_MISSION_ITEM_INT).toBe(common.MissionItemInt.MSG_ID);
    expect(TLOG_SLICE_IDS.PARAM_ID_OFFSET).toBe(
      common.ParamValue.FIELDS.find((f) => f.name === 'paramId')!.offset,
    );
    expect(TLOG_SLICE_IDS.HEARTBEAT_TYPE_OFFSET).toBe(
      minimal.Heartbeat.FIELDS.find((f) => f.name === 'type')!.offset,
    );
  });
});
