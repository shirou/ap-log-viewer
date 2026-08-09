// Cutting a time window back out of the log file the reader opened.
//
// The output is a copy of the original bytes, never a re-serialization of the
// parsed model: `columnsFor` drops array and object fields, unknown msgids are
// never decoded at all, and MAVLink CRCs and DataFlash `Length` fields would
// have to be rebuilt. Copying bytes is the only route to a file Mission Planner
// or MAVExplorer will open, and it makes checksum correctness free.
//
// Three invariants hold the whole thing together:
//
//  1. A slice carrying only `structParts` reparses to exactly the rows
//     `rangeIndices(series.time, t0, t1)` selects from a full parse. Structure
//     alone adds no rows, so this is an equality with nothing to subtract.
//  2. A slice carrying `contextParts` as well reparses to those same rows plus
//     one row per hoisted record, all stamped `t0`.
//  3. Neither covers `params`, `modes`, `missionSteps` or `mission`. Those are
//     derived through change detection, transfer boundaries and normalizeEvents,
//     so cutting a window necessarily moves them.
//
// This module needs the parsers; everything about a slice that does not is in
// sliceTypes.ts, so the UI can talk about one without importing them.

import type { LogSource } from '../parsers/source.ts';
import type { LogKind, TimeWindow } from '../model/log.ts';
import { FMT_TYPE, scanDataflash, type ParseOptions } from '../parsers/dataflash.ts';
import { REGISTRY, scanTlog } from '../parsers/tlog.ts';
import { planDataflashSlice } from './sliceDataflash.ts';
import { planTlogSlice } from './sliceTlog.ts';
import type { SliceInspection, SliceScan } from './sliceTypes.ts';

export * from './sliceTypes.ts';

/**
 * Scan the file and plan the cut.
 *
 * `kind` comes from the caller — `log.source` — rather than being sniffed again:
 * `parse.ts` falls back to a content check precisely because a file's name can
 * lie about what is in it, and the answer it settled on is the one the rows on
 * screen came from.
 */
export function scanForSlice(
  source: LogSource,
  kind: LogKind,
  window: TimeWindow,
  opts: ParseOptions = {},
): Promise<SliceScan> {
  return kind === 'bin'
    ? planDataflashSlice(source, window, opts)
    : planTlogSlice(source, window, opts);
}

/**
 * Reframe an assembled slice and tally what is in it.
 *
 * Runs the same loop the parser does, so "this file reads back" means the same
 * thing here as it will when the reader opens the slice.
 */
export async function inspectSlice(source: LogSource, kind: LogKind): Promise<SliceInspection> {
  const rows = new Map<string, number>();
  let gapBytes = 0;
  let prevEnd = 0;
  let minTime = Infinity;
  let maxTime = -Infinity;

  const note = (
    name: string,
    start: number,
    end: number,
    time: number,
    counts: boolean,
    ownTime: boolean,
  ) => {
    if (start > prevEnd) gapBytes += start - prevEnd;
    prevEnd = end;
    if (!counts) return;
    rows.set(name, (rows.get(name) ?? 0) + 1);
    // Only a record carrying its own clock says anything about when the slice
    // covers. An inherited stamp is a copy of a neighbour's, and at the head of a
    // file it is 0 — a bound no record was written at.
    if (!ownTime) return;
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
  };

  if (kind === 'bin') {
    await scanDataflash(source, (r) => {
      // FMT is the table talking about itself; the reader never makes a row of
      // it, so neither does the tally it will be compared against.
      note(r.format.name, r.start, r.end, r.time, r.format.type !== FMT_TYPE, r.hasOwnTime);
    });
  } else {
    await scanTlog(source, (f) => {
      note(REGISTRY[f.msgid]?.MSG_NAME ?? `#${f.msgid}`, f.start, f.end, f.ts, true, true);
    });
  }

  // A trailing gap is as much a defect as one in the middle.
  if (source.size > prevEnd) gapBytes += source.size - prevEnd;

  return { rows, gapBytes, minTime, maxTime };
}
