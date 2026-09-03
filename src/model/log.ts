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
  /** Display label: the resolved name ("AUTO"), or `Mode ${modeNum}` when the
   *  vehicle kind or the number itself is unknown. */
  mode: string;
  /** Raw value: a tlog's HEARTBEAT.customMode, a .bin's MODE.Mode. */
  modeNum: number;
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
  /**
   * Who sent it.
   *
   * Not optional, and not inferable from where the event is stored: one command
   * is filed under both its sender and its target (see `SourceData.commands`),
   * so the map key it was found under says nothing about who sent it. On a real
   * session every command comes from the GCS, so reading the key instead would
   * label all of them as having come from the vehicle.
   */
  source: SourceId;
  /** Who it was aimed at. sysid 0 is a broadcast; compid 0 is every component
   *  of that system. Absent on a .bin, which records no commands at all. */
  target?: SourceId;
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

/**
 * A MAVLink address: who a frame came from.
 *
 * Only a tlog has these. A .bin is written by the vehicle about itself, so
 * there is nothing to tell apart and `LogData.sources` is empty for one.
 */
export interface SourceId {
  sysid: number;
  compid: number;
}

/** Map key and `<select>` value for one address. */
export function sourceKey(s: SourceId): string {
  return `${s.sysid}/${s.compid}`;
}

/**
 * `<select>` value for every component of one system.
 *
 * A SYSID is one aircraft; its COMPIDs are the autopilot, the gimbal, the
 * companion computer riding on it. This names the aircraft rather than one of
 * the boxes bolted to it. Never a key of `bySource` — a group is resolved to
 * its members and merged on demand (see `selectionKeys` in the projection).
 */
export function groupKey(sysid: number): string {
  return `${sysid}/*`;
}

/**
 * The sysid a group key names, or null when the key is not one.
 *
 * Strict, because this is the only place a string from outside — a `<select>`
 * value — becomes a number. `Number('')` is 0, so a lax test would read a bare
 * `'/*'` as system 0.
 */
export function parseGroupKey(key: string): number | null {
  return /^\d+\/\*$/.test(key) ? Number(key.slice(0, -2)) : null;
}

/**
 * Stands for "don't split — show every source at once".
 *
 * Also the sole key a .bin's `bySource` uses, which is what lets both formats
 * take the same path through `projectLog` instead of branching on the kind.
 * `/` separates a real address's two halves, so no address can collide with it.
 */
export const ALL_SOURCES = '*';

/**
 * One selectable MAVLink address.
 *
 * The material a selector row is built from rather than the row itself: a row
 * can stand for a whole system, which is more than one of these (see
 * `SourceOption` in the projection).
 */
export interface SourceInfo extends SourceId {
  /** MAV_TYPE from this source's HEARTBEAT, or undefined when it sent none. */
  mavType?: number;
  /** MAV_TYPE's name ("SURFACE_BOAT", "GCS"), when the dialect knows it. */
  typeLabel?: string;
  /** COMPID's name ("AUTOPILOT1", "MISSIONPLANNER"), when the dialect knows it. */
  compLabel?: string;
  /**
   * Frames sent by this source, including msgids no dialect defines.
   *
   * Counted separately from the decode, so the total does not depend on which
   * frame of a source happened to arrive first. A source only reaches this list
   * at all once it has produced one frame that decoded — resync and a truncated
   * tail can both invent an address, and a list built from raw framing alone
   * would offer the reader a vehicle that does not exist.
   */
  records: number;
  /** This source's own extent. Not the timeline's — see `LogData.startTime`. */
  startTime: number;
  endTime: number;
}

/**
 * One source's share of the log.
 *
 * Everything here is filtered by sender, except `commands` and `mission`, which
 * are filed under both ends of the exchange: a GCS sends every command, so
 * filtering those by sender would leave the vehicle with none, and a mission
 * transfer runs GCS->vehicle on upload and vehicle->GCS on download.
 */
export interface SourceData {
  /** Message type name -> series. */
  messages: Record<string, MessageSeries>;
  params: Record<string, number>;
  modes: ModeChange[];
  texts: TextMessage[];
  /** Commands this source sent or was sent, in time order. Empty for .bin logs. */
  commands: CommandEvent[];
  /** Flight-plan progress, in time order. */
  missionSteps: MissionStep[];
  /** Planned flight path, ordered by `seq`. Empty when the log carries none. */
  mission: Waypoint[];
  /**
   * This source's flight path, built while parsing.
   *
   * Derived, but stored rather than recomputed on demand: `purgeMessage`
   * promises the map keeps its track (see logStore), and rebuilding it from
   * whatever messages survive a purge would break that promise the moment the
   * position message is the one dropped.
   */
  trajectory: Trajectory;
}

/**
 * What a parser returns: every source, unmerged.
 *
 * The UI never renders this. `projectLog` picks one source (or merges them all)
 * into a `LogData`, which is the shape every view already knows.
 */
export interface ParsedLog {
  source: LogKind;
  /** Extent of every source together — the timeline's ends, fixed across
   *  selections so switching source cannot move the clock under the reader. */
  startTime: number;
  endTime: number;
  /** Selectable sources, most frames first. Empty for a .bin. */
  sources: SourceInfo[];
  /** Keyed by `sourceKey`; a .bin holds exactly one entry, at `ALL_SOURCES`. */
  bySource: Map<string, SourceData>;
}

/**
 * One source, wrapped in what the views need on top of it.
 *
 * Extends `SourceData` rather than repeating its eight fields, so that
 * `projectLog`'s `{...data}` is checked by the compiler instead of merely
 * happening to line up — a field added to `SourceData` now has to be accounted
 * for here too.
 */
export interface LogData extends SourceData {
  source: LogKind;
  /**
   * Microseconds. Same clock as `MessageSeries.time`.
   *
   * Spans every source, not just the selected one, so the timeline's ends and
   * every relative time printed against them hold still while the reader
   * switches between sources.
   */
  startTime: number;
  endTime: number;
  /** Selectable sources, most frames first. Empty for a .bin. */
  sources: SourceInfo[];
  /** Which source the fields above describe: a `sourceKey`, a `groupKey`, or
   *  `ALL_SOURCES`. */
  selection: string;
}

/** Which reader a log is for. Lives here so the UI can name one without
 *  importing the parsers, whose dialect tables are a third of a megabyte. */
export type LogKind = 'bin' | 'tlog';

/** A span of log time, inclusive at both ends — the same convention as `rangeIndices`. */
export interface TimeWindow {
  startUs: number;
  endUs: number;
}

/** Progress / result protocol between the worker and the main thread. */
export type ParseProgress = { type: 'progress'; phase: string; ratio: number };
/** Every source, unprojected: the main thread picks one without re-parsing. */
export type ParseDone = { type: 'done'; parsed: ParsedLog };
export type ParseError = { type: 'error'; message: string };
export type ParseMessage = ParseProgress | ParseDone | ParseError;

/** What a verified slice turned out to hold, for the reader to see before saving. */
export interface SliceStats {
  /** Rows copied from inside the window. */
  windowRows: number;
  /** Rows carried in from outside it, all stamped on the window start. */
  hoistedRows: number;
  messageTypes: number;
  /** Extent of the window rows, microseconds on the log's own clock. */
  startTime: number;
  endTime: number;
  bytes: number;
}

/**
 * What the worker can be asked to do.
 *
 * Declared here rather than in the worker module so a component can post one
 * without importing that module — which would drag both parsers, and the MAVLink
 * dialect tables with them, into the main bundle.
 */
export type ParseRequest = { op?: 'parse'; file: File };
export type SliceRequest = {
  op: 'slice';
  file: File;
  kind: LogKind;
  window: TimeWindow;
  format: 'original' | 'json';
  gzip: boolean;
};
export type WorkerRequest = ParseRequest | SliceRequest;

/** Result protocol for a slice request. `Blob` is structured-cloneable. */
export type SliceProgress = { type: 'sliceProgress'; phase: 'scanning' | 'verifying' | 'writing'; ratio?: number };
export type SliceDone = { type: 'sliceDone'; blob: Blob; stats: SliceStats };
export type SliceFailed = { type: 'sliceError'; message: string };
export type SliceMessage = SliceProgress | SliceDone | SliceFailed;

/** A selectable `message.field` pair for plotting. */
export interface FieldRef {
  message: string;
  field: string;
}

export function fieldKey(ref: FieldRef): string {
  return `${ref.message}.${ref.field}`;
}
