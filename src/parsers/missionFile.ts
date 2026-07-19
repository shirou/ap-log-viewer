// Standalone flight-plan files, for the common case where the log itself
// carries no mission: a tlog only records one if a transfer happened to occur
// while the GCS was recording.
//
// Two formats are accepted, told apart by content rather than by extension —
// Mission Planner writes the text format as .waypoints or .txt, and neither
// name is reliable:
//   * QGC WPL   — the tab-separated text format (Mission Planner, MAVProxy)
//   * QGC .plan — QGroundControl's JSON format

import type { Waypoint } from '../model/log.ts';
import { MissionCollector } from './mission.ts';

export interface MissionFile {
  waypoints: Waypoint[];
  /**
   * Items that are part of the plan but whose waypoints the file does not
   * contain, so they cannot be drawn. Surfaced rather than dropped quietly:
   * the map would otherwise be missing a chunk of the plan with no hint why.
   */
  unreadable: number;
}

/** MAV_FRAME_GLOBAL — what the text format's home row uses. */
const FRAME_GLOBAL = 0;
const NAV_WAYPOINT = 16;

export function parseMissionFile(text: string): MissionFile {
  // A UTF-8 BOM survives File.text() and would defeat both the header match
  // and JSON.parse.
  const body = text.replace(/^﻿/, '');
  const head = body.trimStart();
  if (head.startsWith('{')) return parsePlan(head);
  if (head.startsWith('QGC WPL')) return parseWpl(body);
  throw new Error('Not a mission file (expected a "QGC WPL" header or QGC .plan JSON)');
}

/**
 * QGC WPL text format.
 *
 * Columns are fixed and positional:
 *   0 index  1 current  2 frame  3 command  4-7 param1..4
 *   8 lat    9 lon      10 alt   11 autocontinue
 *
 * Latitude and longitude are plain decimal degrees here, not the degE7 the
 * MAVLink and DataFlash paths carry.
 */
function parseWpl(text: string): MissionFile {
  const lines = text.split(/\r?\n/);
  const into = new MissionCollector();
  let seen = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue; // blank and comment lines
    const f = line.split(/\s+/);
    // Splitting on any whitespace rather than tabs alone, since the writers
    // disagree; but the count is checked exactly. A file written with decimal
    // commas shatters into far more fields than this and would otherwise parse
    // into plausible, wrong coordinates instead of failing.
    if (f.length !== 12) {
      throw new Error(`Line ${i + 1}: expected 12 fields, found ${f.length}`);
    }
    const seq = Number(f[0]);
    let command = Number(f[3]);
    // Mission Planner writes command 0 at index 0 when its home fields were
    // left blank; every other reader treats that as a plain waypoint.
    if (command === 0 && seq === 0) command = NAV_WAYPOINT;
    into.add({
      seq,
      command,
      lat: Number(f[8]),
      lon: Number(f[9]),
      alt: Number(f[10]),
      frame: Number(f[2]),
    });
    seen++;
  }
  if (seen === 0) throw new Error('No waypoints in this file');
  return { waypoints: into.finalize(), unreadable: 0 };
}

/** JSON `null` means NaN — "unspecified" — and must not collapse to 0. */
function jsonNumber(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}

/**
 * QGroundControl .plan.
 *
 * Home lives outside the item list, in `plannedHomePosition`, and is sequence
 * 0; `items[0]` is therefore sequence 1. Items carry `doJumpId`, which really
 * is the MAVLink sequence number — it is not the array index, because a
 * complex item expands into several and the numbering skips ahead.
 */
function parsePlan(text: string): MissionFile {
  const doc: unknown = JSON.parse(text);
  const root = doc as { fileType?: unknown; mission?: unknown };
  if (root.fileType !== 'Plan') throw new Error('Not a QGC .plan file');
  const mission = root.mission as { plannedHomePosition?: unknown; items?: unknown } | undefined;
  if (!mission) throw new Error('.plan file has no mission');

  const into = new MissionCollector();
  const home = mission.plannedHomePosition;
  if (Array.isArray(home) && home.length >= 2) {
    into.add({
      seq: 0,
      command: NAV_WAYPOINT,
      lat: jsonNumber(home[0]),
      lon: jsonNumber(home[1]),
      alt: jsonNumber(home[2]) || 0,
      frame: FRAME_GLOBAL,
    });
  }

  const items = Array.isArray(mission.items) ? mission.items : [];
  const ctx = { unreadable: 0, nextSeq: 1 };
  for (const item of items) collectPlanItem(item, into, ctx);
  if (!Array.isArray(home) && items.length === 0) throw new Error('No waypoints in this file');

  return { waypoints: into.finalize(), unreadable: ctx.unreadable };
}

function collectPlanItem(
  item: unknown,
  into: MissionCollector,
  ctx: { unreadable: number; nextSeq: number },
): void {
  if (!item || typeof item !== 'object') return;
  const o = item as Record<string, unknown>;

  if (o.type === 'ComplexItem') {
    // Surveys and corridor scans store their generated waypoints in the file,
    // so they can be read back exactly. Structure scans store only the
    // parameters QGC regenerates them from, and are genuinely unreadable here.
    const inner = o.TransectStyleComplexItem as { Items?: unknown } | undefined;
    if (Array.isArray(inner?.Items)) {
      for (const sub of inner.Items) collectPlanItem(sub, into, ctx);
      return;
    }
    ctx.unreadable++;
    return;
  }

  // Older files use a separate `coordinate` and carry only param1..4, so the
  // position is not always at params[4..6].
  const params = Array.isArray(o.params) ? o.params : [];
  const coord = Array.isArray(o.coordinate) ? o.coordinate : null;
  const lat = coord ? jsonNumber(coord[0]) : jsonNumber(params[4]);
  const lon = coord ? jsonNumber(coord[1]) : jsonNumber(params[5]);
  const alt = coord ? jsonNumber(coord[2]) : jsonNumber(params[6]);

  const doJumpId = jsonNumber(o.doJumpId);
  const seq = Number.isFinite(doJumpId) ? doJumpId : ctx.nextSeq;
  ctx.nextSeq = seq + 1;

  into.add({
    seq,
    command: jsonNumber(o.command),
    lat,
    lon,
    alt,
    frame: jsonNumber(o.frame),
  });
}
