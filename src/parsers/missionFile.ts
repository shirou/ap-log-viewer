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
import { MissionCollector, isPathVertex } from './mission.ts';

/**
 * A collector for file input, sharing the log paths' command allow-list and
 * coordinate filters so a plan is judged the same however it arrived.
 *
 * beginTransfer() up front is what makes it safe to reuse: a file is one whole
 * plan, so the guess the log paths need — a sequence number restarting at 0
 * means a *new* plan, discard the last one — must not run here. Left on, a file
 * that repeats an index part-way through loses every waypoint before it.
 */
function fileCollector(): MissionCollector {
  const into = new MissionCollector();
  into.beginTransfer();
  return into;
}

export interface MissionFile {
  waypoints: Waypoint[];
  /**
   * Items that belong on the route but could not be drawn — because the file
   * stores only the parameters they are regenerated from (structure scans and
   * landing patterns), or because their coordinates were unreadable.
   *
   * Counted rather than dropped quietly. A plan missing a chunk of itself, with
   * nothing on screen saying so, is worse than one that failed to load: it
   * looks like it worked.
   */
  unreadable: number;
}

/** MAV_FRAME_GLOBAL — what the text format's home row uses. */
const FRAME_GLOBAL = 0;
const NAV_WAYPOINT = 16;

export function parseMissionFile(text: string): MissionFile {
  // trimStart carries the UTF-8 BOM with it — U+FEFF is whitespace as far as
  // ECMAScript is concerned — and a BOM survives File.text(), where it would
  // otherwise defeat both the header match and JSON.parse. Both readers get the
  // trimmed text, so the header really is line 0 of what parseWpl sees: passing
  // the raw text would let a blank first line shift every row by one and report
  // the header itself as a malformed record.
  const head = text.trimStart();
  if (head.startsWith('{')) return parsePlan(head);
  if (head.startsWith('QGC WPL')) return parseWpl(head);
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
  const into = fileCollector();
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

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
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

  const into = fileCollector();
  const home = mission.plannedHomePosition;
  if (Array.isArray(home) && home.length >= 2) {
    into.add({
      seq: 0,
      command: NAV_WAYPOINT,
      lat: jsonNumber(home[0]),
      lon: jsonNumber(home[1]),
      alt: finiteOr(jsonNumber(home[2]), 0),
      frame: FRAME_GLOBAL,
    });
  }

  const items = Array.isArray(mission.items) ? mission.items : [];
  // Home alone is not a plan — it would draw as a single "0" chip sitting on
  // the launch point, which reads as a mission of one waypoint rather than as
  // the empty mission it is.
  if (items.length === 0) throw new Error('No waypoints in this file');
  const ctx = { unreadable: 0, nextSeq: 1 };
  for (const item of items) collectPlanItem(item, into, ctx);

  return { waypoints: into.finalize(), unreadable: ctx.unreadable };
}

function collectPlanItem(
  item: unknown,
  into: MissionCollector,
  ctx: { unreadable: number; nextSeq: number },
): void {
  if (!item || typeof item !== 'object') return;
  const o = item as Record<string, unknown>;

  // `type` is "ComplexItem" today, but a survey saved at version 2 put its own
  // name there instead, and QGC still converts those on load.
  if (o.type === 'ComplexItem' || o.type === 'survey') {
    // Surveys and corridor scans store their generated waypoints in the file
    // and are recovered exactly. Structure scans and landing patterns store
    // only the geometry QGC regenerates them from, so they cannot be.
    const inner = o.TransectStyleComplexItem as { Items?: unknown } | undefined;
    if (Array.isArray(inner?.Items) && inner.Items.length > 0) {
      for (const sub of inner.Items) collectPlanItem(sub, into, ctx);
      return;
    }
    ctx.unreadable++;
    return;
  }

  // Older files put the position in a separate `coordinate` rather than in
  // params[4..6]; V1 also spells its params as param1..param4 keys, but those
  // are never a position, so `coordinate` is the only extra place to look.
  const params = Array.isArray(o.params) ? o.params : [];
  const coord = Array.isArray(o.coordinate) ? o.coordinate : null;
  const lat = coord ? jsonNumber(coord[0]) : jsonNumber(params[4]);
  const lon = coord ? jsonNumber(coord[1]) : jsonNumber(params[5]);
  const alt = coord ? jsonNumber(coord[2]) : jsonNumber(params[6]);
  const command = jsonNumber(o.command);

  // doJumpId is the real sequence number, but it comes from a file that may not
  // have been written by QGC. A negative or fractional one would sort ahead of
  // home or collide on the way into the map, so anything unusable falls back to
  // counting, which is also what genuine V1 files need — they spell it `id`.
  const doJumpId = jsonNumber(o.doJumpId);
  const seq = Number.isInteger(doJumpId) && doJumpId >= 0 ? doJumpId : ctx.nextSeq;
  ctx.nextSeq = seq + 1;

  // Report a route vertex whose position could not be read. Commands that are
  // not vertices at all (DO_JUMP and friends) are expected omissions and stay
  // silent; this is the case where part of the plan really is missing.
  if (isPathVertex(command) && !(Number.isFinite(lat) && Number.isFinite(lon))) {
    ctx.unreadable++;
    return;
  }

  into.add({ seq, command, lat, lon, alt, frame: jsonNumber(o.frame) });
}
