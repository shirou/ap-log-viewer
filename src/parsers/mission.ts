// Mission (flight-plan) extraction, shared by the DataFlash and tlog parsers.
//
// The two sources carry the same structure: ArduPilot builds a
// `mavlink_mission_item_int_t` and copies its fields straight into the
// DataFlash `CMD` packet, so a tlog's MISSION_ITEM_INT and a .bin's CMD row
// describe an item identically and can share the normalising done here.

import type { Waypoint } from '../model/log.ts';

/**
 * MAV_CMD values that are vertices of the planned path.
 *
 * This is the subset of ArduPilot's `AP_Mission::stored_in_location()`
 * (libraries/AP_Mission/AP_Mission.cpp) that belongs on a route line. The
 * predicate matters beyond tidiness: it is the same test the firmware uses to
 * decide whether an item's x/y are coordinates at all. For everything else —
 * DO_JUMP most visibly, whose x/y hold a target index and a repeat count —
 * ArduPilot passes the fields through unscaled, so treating them as a position
 * would plot a waypoint at a number that was never a place.
 *
 * Deliberately excluded although `stored_in_location()` accepts them: DO_SET_ROI
 * (195, 201), DO_SET_HOME (179) and DO_GO_AROUND (191). Those carry a real
 * location but are not a leg of the route — an ROI is a camera look-at target
 * that can sit kilometres away and would drag the line sideways.
 *
 * The fence (5000-5004) and rally (5100) commands are omitted for a different
 * reason: they describe separate overlays, and a tlog delivers them through
 * this same message with only `mission_type` to tell them apart.
 */
const PATH_VERTEX_COMMANDS = new Set([
  16, // NAV_WAYPOINT
  17, // NAV_LOITER_UNLIM
  18, // NAV_LOITER_TURNS
  19, // NAV_LOITER_TIME
  21, // NAV_LAND
  22, // NAV_TAKEOFF
  30, // NAV_CONTINUE_AND_CHANGE_ALT
  31, // NAV_LOITER_TO_ALT
  36, // NAV_ARC_WAYPOINT
  82, // NAV_SPLINE_WAYPOINT
  84, // NAV_VTOL_TAKEOFF
  85, // NAV_VTOL_LAND
  92, // NAV_GUIDED_ENABLE
  94, // NAV_PAYLOAD_PLACE
  // Sequence markers rather than destinations, but Plane flies through them in
  // order on an automated landing, so leaving them out makes the drawn route
  // cut the corner on the approach.
  188, // DO_RETURN_PATH_START
  189, // DO_LAND_START
]);

/**
 * Read a DataFlash lat/lon pair as degrees, undoing 1e7 scaling if it is still
 * applied.
 *
 * Only DataFlash needs the guess. A `.bin` describes its own layout, so whether
 * the coordinate arrives pre-scaled depends on the format char the firmware
 * declared — `L` is unscaled to degrees while decoding (see formatChars.ts) but
 * a plain integer char would not be. MAVLink needs none of this: the message id
 * fixes the unit, and tlog.ts scales explicitly.
 *
 * The pair is judged together and scaled together. Deciding per axis lets one
 * coordinate be scaled while the other is not, which does not fail loudly — it
 * silently relocates the waypoint instead.
 *
 * The threshold is "too large to be degE7-shaped", not merely "out of range for
 * degrees", so that damage cannot be mistaken for an unscaled value. An int32
 * that has already been through the `L` char cannot exceed ±214.7 however
 * corrupt it is, and rescaling such a row would quietly convert nonsense into a
 * valid-looking coordinate a few metres off Null Island. Below the threshold
 * the value is left alone and an out-of-range check rejects it.
 */
const DEG_E7_FLOOR = 1e5; // 0.01° once scaled; far above any `L`-decoded value

export function sniffDegrees(lat: number, lon: number): { lat: number; lon: number } {
  const unscaled = Math.abs(lat) > DEG_E7_FLOOR || Math.abs(lon) > DEG_E7_FLOOR;
  return unscaled ? { lat: lat * 1e-7, lon: lon * 1e-7 } : { lat, lon };
}

/**
 * Accumulates mission items and yields the most recently transferred plan.
 *
 * A log can hold several plans. ArduPilot re-dumps the whole mission to `CMD`
 * every time it changes, and a GCS re-reads it over MAVLink on each reconnect.
 * The earlier plan is dropped whole rather than merged into, because merging is
 * wrong in a way that is easy to miss: re-uploading a *shorter* plan overwrites
 * seq 0..N-1 but leaves the longer plan's tail behind, leaving the map showing
 * waypoints the vehicle no longer holds.
 *
 * Where a caller can see a transfer begin it should say so via beginTransfer();
 * otherwise the boundary is inferred from seq 0, since a full transfer always
 * walks 0..N-1. Inferring is the weaker of the two and is only a fallback: it
 * cannot tell a fresh plan from a MISSION_WRITE_PARTIAL_LIST that happens to
 * rewrite a range starting at 0, and reads the latter as a plan that just got
 * much shorter. What it must not do is treat *any* repeated index as a new
 * plan — a MISSION_ITEM_INT retried mid-download (0,1,2,2,3) repeats one
 * without starting anything, and discarding the plan there loses its head.
 */
export class MissionCollector {
  private items = new Map<number, Waypoint>();
  /** Set once a caller reports a real transfer, retiring the seq-0 guess. */
  private explicitBoundaries = false;

  /**
   * Declare that a complete plan is about to be sent, discarding the last one.
   * Driven by MISSION_COUNT, which precedes every full MAVLink transfer in
   * either direction — including a transfer of zero items, which is how a
   * mission gets cleared.
   */
  beginTransfer(): void {
    this.explicitBoundaries = true;
    this.items.clear();
  }

  /** Record one item. Items that are not part of the planned path are ignored. */
  add(wp: Waypoint): void {
    // Judged before the filters below, so that whichever command happens to sit
    // at index 0 cannot decide whether a new plan is noticed.
    if (!this.explicitBoundaries && wp.seq === 0 && this.items.size > 0) this.items.clear();

    if (!PATH_VERTEX_COMMANDS.has(wp.command)) return;
    if (!Number.isFinite(wp.lat) || !Number.isFinite(wp.lon)) return;
    // Reject anything off the globe outright. DataFlash has no per-message
    // checksum and the reader resyncs through damage, so a corrupt row can
    // arrive with a plausible command id and nonsense coordinates — and one
    // such row is enough to throw the route line and the initial camera.
    if (Math.abs(wp.lat) > 90 || Math.abs(wp.lon) > 180) return;
    // Copter stores a zero position on TAKEOFF and LAND to mean "here", and
    // those are real path vertices with nothing to plot. Null Island is 600 km
    // off the Gulf of Guinea, so leaving them in is conspicuous.
    if (wp.lat === 0 && wp.lon === 0) return;
    this.items.set(wp.seq, wp);
  }

  /** The plan, ordered by sequence number. */
  finalize(): Waypoint[] {
    return [...this.items.values()].sort((a, b) => a.seq - b.seq);
  }
}
