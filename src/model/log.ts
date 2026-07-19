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

export interface LogData {
  source: 'bin' | 'tlog';
  /** Message type name -> series. */
  messages: Record<string, MessageSeries>;
  params: Record<string, number>;
  modes: ModeChange[];
  texts: TextMessage[];
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
