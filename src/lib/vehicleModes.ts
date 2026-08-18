// Turning a flight mode number into the name a pilot would recognise.
//
// ArduPilot's `customMode` is only meaningful once you know which vehicle sent
// it: 10 is `AUTO` on a Rover and `AUTOTUNE` on a Copter. Both log formats leave
// the number bare, so a reader currently sees "Mode 10" and has to know the
// firmware to read it.
//
// The tables are `mavlink-mappings`' own — the ArduPilot dialect ships one enum
// per vehicle — so nothing here is hand-copied and a dialect update carries new
// modes in for free. What this module adds is the two ways a log says which
// vehicle it came from: a tlog's HEARTBEAT `type` (a MAV_TYPE), and a .bin's
// firmware banner string.

import { minimal, ardupilotmega } from 'mavlink-mappings';

/** Which mode table a log's numbers should be read against. */
export type VehicleKind = 'copter' | 'plane' | 'rover' | 'sub' | 'tracker';

/**
 * Numeric half of one of mavlink-mappings' enum objects.
 *
 * They carry both directions — name -> id and id -> name — so the numeric keys
 * are the reverse map. Exported because the tlog parser needs the same
 * extraction for MAV_TYPE and MAV_COMPONENT, and two copies of six lines that
 * must agree is two chances to disagree.
 */
export function reverseMap(table: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [key, value] of Object.entries((table ?? {}) as Record<string, unknown>)) {
    const id = Number(key);
    if (Number.isInteger(id) && typeof value === 'string') out[id] = value;
  }
  return out;
}

const MODE_TABLES: Record<VehicleKind, Record<number, string>> = {
  copter: reverseMap(ardupilotmega.CopterMode),
  plane: reverseMap(ardupilotmega.PlaneMode),
  rover: reverseMap(ardupilotmega.RoverMode),
  sub: reverseMap(ardupilotmega.SubMode),
  tracker: reverseMap(ardupilotmega.TrackerMode),
};

/**
 * MAV_TYPE -> the firmware that flies it.
 *
 * Written against `minimal.MavType`'s names rather than the numbers, so a
 * renumbering in the dialect cannot silently point a vehicle at the wrong mode
 * table. Types with no ArduPilot mode table of their own — GCS, gimbals, ADSB
 * transponders, cameras, onboard controllers — are simply absent, which is what
 * makes this usable as "is this thing a vehicle?".
 */
const KIND_BY_MAV_TYPE: ReadonlyMap<number, VehicleKind> = (() => {
  const byName = ardupilotTypeNames();
  const out = new Map<number, VehicleKind>();
  const t = minimal.MavType as unknown as Record<string, number>;
  for (const [name, kind] of Object.entries(byName)) {
    const id = t[name];
    if (typeof id === 'number') out.set(id, kind);
  }
  return out;
})();

function ardupilotTypeNames(): Record<string, VehicleKind> {
  return {
    FIXED_WING: 'plane',
    VTOL_TAILSITTER_DUOROTOR: 'plane',
    VTOL_TAILSITTER_QUADROTOR: 'plane',
    VTOL_TILTROTOR: 'plane',
    VTOL_FIXEDROTOR: 'plane',
    VTOL_TAILSITTER: 'plane',
    VTOL_TILTWING: 'plane',
    VTOL_RESERVED5: 'plane',
    QUADROTOR: 'copter',
    COAXIAL: 'copter',
    HELICOPTER: 'copter',
    HEXAROTOR: 'copter',
    OCTOROTOR: 'copter',
    TRICOPTER: 'copter',
    DODECAROTOR: 'copter',
    GROUND_ROVER: 'rover',
    SURFACE_BOAT: 'rover',
    SUBMARINE: 'sub',
    ANTENNA_TRACKER: 'tracker',
  };
}

/**
 * The vehicle a HEARTBEAT's `type` field describes, or null when it is not a
 * vehicle ArduPilot flies.
 *
 * Null for MAV_TYPE_GCS, which is what makes this the test for "which source is
 * the vehicle" as well as the one for "which mode table". It is stricter than
 * `type !== GCS`: a gimbal or an ADSB transponder announces itself with its own
 * MAV_TYPE and is no more a vehicle than a ground station is.
 */
export function kindFromMavType(mavType: number): VehicleKind | null {
  return KIND_BY_MAV_TYPE.get(mavType) ?? null;
}

/**
 * The vehicle a DataFlash firmware banner describes.
 *
 * Matched on the bare vehicle word rather than the whole product name, so that
 * both generations of banner are read by one rule: current firmware writes
 * "ArduRover V4.6.3 (3fc7011a)" and older builds wrote "APM:Copter V3.2.1".
 * The five words are mutually exclusive — "AntennaTracker" contains "Tracker"
 * and nothing else — so the order of the tests carries no meaning.
 *
 * Returns null for the other banner lines a log opens with ("ChibiOS: ...",
 * board names, "Param space used: ..."), which is what lets a caller feed it
 * every MSG row until one answers.
 */
export function kindFromFirmware(banner: string): VehicleKind | null {
  if (banner.includes('Copter')) return 'copter';
  if (banner.includes('Plane')) return 'plane';
  if (banner.includes('Rover')) return 'rover';
  if (banner.includes('Tracker')) return 'tracker';
  if (banner.includes('Sub')) return 'sub';
  return null;
}

/**
 * A flight mode's name, or the number as it reads today when it cannot be
 * resolved.
 *
 * The fallback is deliberately the existing `Mode ${n}` text: an unknown mode
 * and an unknown vehicle both leave the reader exactly where they are now,
 * rather than inventing a label or dropping the value.
 */
export function modeLabel(kind: VehicleKind | null, modeNum: number): string {
  if (kind !== null && Number.isFinite(modeNum)) {
    const name = MODE_TABLES[kind][modeNum];
    if (name) return name;
  }
  return `Mode ${modeNum}`;
}
