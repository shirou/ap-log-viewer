// Normalized, columnar log model shared by both the DataFlash (.bin) and
// telemetry (.tlog) parsers. Numeric fields are stored as typed arrays so the
// UI (uPlot / deck.gl) can read them without per-point object overhead.

/** One message type's time series (e.g. all `GPS` or `ATT` records). */
export interface MessageSeries {
  /** Message/type name, e.g. "GPS", "ATT", "GLOBAL_POSITION_INT". */
  name: string;
  /** Field label -> column of values, aligned with `time`. */
  fields: Record<string, Float64Array>;
  /** Field labels in declaration order. */
  labels: string[];
  /** Timestamp per row, microseconds. Boot-relative for .bin, UNIX for .tlog. */
  time: Float64Array;
  /** Non-numeric (string) columns, e.g. text payloads. Aligned with `time`. */
  textFields?: Record<string, string[]>;
}

/** Flight path extracted from position messages. */
export interface Trajectory {
  time: Float64Array;
  lat: Float64Array; // degrees
  lon: Float64Array; // degrees
  alt: Float64Array; // meters (relative/AMSL depending on source)
  heading: Float64Array; // degrees clockwise from north; NaN where unknown
}

/**
 * One item of the uploaded flight plan that has a usable position.
 *
 * Non-positional commands (RTL, DO_JUMP, condition commands, ...) are dropped
 * while parsing, but `seq` is the vehicle's own mission index, so the numbers
 * drawn on the map still line up with the mission list in a GCS.
 */
export interface Waypoint {
  /** Mission sequence index as stored on the vehicle (0 is the planned home). */
  seq: number;
  /** MAV_CMD id — 16 = NAV_WAYPOINT, 22 = NAV_TAKEOFF, 21 = NAV_LAND, ... */
  command: number;
  lat: number; // degrees
  lon: number; // degrees
  alt: number; // meters, interpreted in `frame`
  /** MAV_FRAME the altitude is expressed in (3 = relative to home). */
  frame: number;
}

export interface ModeChange {
  time: number; // microseconds
  mode: string;
}

export interface TextMessage {
  time: number; // microseconds
  text: string;
  severity?: number;
}

/**
 * A MAVLink command as it was sent to the vehicle (COMMAND_LONG / COMMAND_INT).
 *
 * Only telemetry logs carry these: a .bin is written by the vehicle and records
 * what it *did*, not what it was asked to do, so `LogData.commands` is empty for
 * that source.
 *
 * Link housekeeping (REQUEST_*, SET_MESSAGE_INTERVAL) and a GCS's retries of an
 * unacknowledged command are left out — see `isLinkSetup` in the tlog parser for
 * why the raw stream is unusable as an annotation.
 */
export interface CommandEvent {
  time: number; // microseconds
  /** MAV_CMD id. */
  id: number;
  /** MAV_CMD name (e.g. "DO_SET_MODE"), or the bare id when it is unknown. */
  name: string;
}

/**
 * The instant the vehicle moved on to a new item of its flight plan: a tlog's
 * MISSION_CURRENT changing `seq`, or a .bin's `MISE` record.
 *
 * Not a command — nobody sent this, it is the vehicle reporting where it has got
 * to — which is why it is kept apart from `CommandEvent` and drawn as the
 * quieter of the two annotations. `seq` can go backwards: a plan that is
 * restarted or that loops through a DO_JUMP revisits indices it has already
 * passed, and each of those is its own step.
 *
 * `MISE` arrived in ArduPilot 4.6, so an older .bin yields none of these even
 * though it flew a mission.
 */
export interface MissionStep {
  time: number; // microseconds
  /** Mission sequence index the vehicle moved to. */
  seq: number;
}

export interface LogData {
  source: 'bin' | 'tlog';
  /** Message type name -> series. */
  messages: Record<string, MessageSeries>;
  params: Record<string, number>;
  modes: ModeChange[];
  texts: TextMessage[];
  /** Commands sent to the vehicle, in time order. Empty for .bin logs. */
  commands: CommandEvent[];
  /** Flight-plan progress, in time order. */
  missionSteps: MissionStep[];
  trajectory: Trajectory;
  /** Planned flight path, ordered by `seq`. Empty when the log carries none. */
  mission: Waypoint[];
  /** Microseconds. Same clock as `MessageSeries.time`. */
  startTime: number;
  endTime: number;
}

/** Progress / result protocol between the worker and the main thread. */
export type ParseProgress = { type: 'progress'; phase: string; ratio: number };
export type ParseDone = { type: 'done'; log: LogData };
export type ParseError = { type: 'error'; message: string };
export type ParseMessage = ParseProgress | ParseDone | ParseError;

/** A selectable `message.field` pair for plotting. */
export interface FieldRef {
  message: string;
  field: string;
}

export function fieldKey(ref: FieldRef): string {
  return `${ref.message}.${ref.field}`;
}
