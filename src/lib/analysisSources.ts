// Auto-detection of the message/field sources the analysis modules consume.
//
// Detection is presence-based, never keyed off a vehicle type: a source is
// offered when its fields actually exist in the loaded log, so the same code
// serves ArduSub, Rover, Copter, tlog and .bin alike. Absent sources simply
// yield an empty list, and the UI hides the section rather than erroring.

import type { MessageSeries } from '../model/log.ts';

export interface MagSource {
  message: string;
  xField: string;
  yField: string;
  zField: string;
  label: string;
}

// Magnetometer triples across .bin (MagX/MagY/MagZ) and MAVLink (xmag/ymag/zmag).
const MAG_TRIPLES: ReadonlyArray<readonly [string, string, string]> = [
  ['MagX', 'MagY', 'MagZ'],
  ['xmag', 'ymag', 'zmag'],
];

/** Every message carrying a full magnetometer triple, primary compass first. */
export function detectMagSources(messages: Record<string, MessageSeries>): MagSource[] {
  const out: MagSource[] = [];
  for (const m of Object.values(messages)) {
    if (m.time.length === 0) continue;
    for (const [xField, yField, zField] of MAG_TRIPLES) {
      if (m.fields[xField] && m.fields[yField] && m.fields[zField]) {
        out.push({ message: m.name, xField, yField, zField, label: m.name });
        break;
      }
    }
  }
  return out.sort((a, b) => magRank(a.message) - magRank(b.message) || a.message.localeCompare(b.message));
}

// A trailing number > 1 marks a secondary compass (MAG2, SCALED_IMU2); those
// sort after the primary (MAG, RAW_IMU), which has no trailing digit.
function magRank(name: string): number {
  const m = /([0-9]+)$/.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

export type DriverKind = 'current' | 'throttle';

export interface DriverSource {
  message: string;
  field: string;
  kind: DriverKind;
  label: string;
  unit: string;
}

// Current / throttle signals for the COMPASS_MOT-style interference check,
// ordered by preference; the first match is the sensible default.
const DRIVER_CANDIDATES: ReadonlyArray<Omit<DriverSource, 'label'>> = [
  { message: 'BAT', field: 'Curr', kind: 'current', unit: 'A' },
  { message: 'BAT', field: 'Cur', kind: 'current', unit: 'A' },
  { message: 'BATTERY_STATUS', field: 'currentBattery', kind: 'current', unit: 'cA' },
  { message: 'SYS_STATUS', field: 'currentBattery', kind: 'current', unit: 'cA' },
  { message: 'VFR_HUD', field: 'throttle', kind: 'throttle', unit: '%' },
  { message: 'CTUN', field: 'ThO', kind: 'throttle', unit: '' },
];

/** Available current/throttle sources, in preference order. Empty when none. */
export function detectDriverSources(messages: Record<string, MessageSeries>): DriverSource[] {
  const out: DriverSource[] = [];
  for (const c of DRIVER_CANDIDATES) {
    const m = messages[c.message];
    if (m && m.time.length > 0 && m.fields[c.field]) {
      out.push({ ...c, label: `${c.message}.${c.field}` });
    }
  }
  return out;
}

// ---- Actuator channels (thruster / servo balance) ----

export interface ActuatorChannel {
  field: string;
  /** Channel number as the vehicle knows it, e.g. 3 for SERVO3_FUNCTION. */
  index: number;
}

export interface ActuatorSource {
  message: string;
  label: string;
  /** Outputs the autopilot commands, or the pilot's inputs to it. */
  kind: 'output' | 'input';
  channels: ActuatorChannel[];
  /**
   * Parameter family holding this bank's endpoints — `SERVO3_MIN` for an output,
   * `RC3_MIN` for an input. The two are different parameters on the vehicle, and
   * reading an output's limits for an input channel silently mis-scales every
   * saturation figure in the table.
   */
  paramPrefix: 'SERVO' | 'RC';
  /** Endpoints for the saturation check when the log carries no such parameters. */
  defaultMin: number;
  defaultMax: number;
}

// Channel column conventions: .bin RCOU/RCIN use C1..C14, MAVLink spells the
// same thing servo1Raw.. / chan1Raw.. . Matched by pattern rather than by a
// fixed channel count so a 16-output frame is not truncated to 8.
const ACTUATOR_PATTERNS: ReadonlyArray<{ test: RegExp; field: RegExp; kind: 'output' | 'input' }> = [
  { test: /^RCOU/, field: /^C(\d+)$/, kind: 'output' },
  { test: /^SERVO_OUTPUT_RAW$/, field: /^servo(\d+)Raw$/, kind: 'output' },
  { test: /^RCIN/, field: /^C(\d+)$/, kind: 'input' },
  { test: /^RC_CHANNELS(_RAW)?$/, field: /^chan(\d+)Raw$/, kind: 'input' },
];

/**
 * Messages carrying a bank of PWM channels, autopilot outputs first.
 *
 * 1100/1900 are ArduPilot's default SERVOn_MIN/MAX; the caller should prefer the
 * log's own parameters when it has them, since a vehicle with narrowed limits
 * saturates well before the defaults say it does.
 */
export function detectActuatorSources(messages: Record<string, MessageSeries>): ActuatorSource[] {
  const out: ActuatorSource[] = [];
  for (const m of Object.values(messages)) {
    if (m.time.length === 0) continue;
    for (const p of ACTUATOR_PATTERNS) {
      if (!p.test.test(m.name)) continue;
      const channels: ActuatorChannel[] = [];
      for (const field of Object.keys(m.fields)) {
        const hit = p.field.exec(field);
        if (hit) channels.push({ field, index: parseInt(hit[1], 10) });
      }
      if (channels.length >= 2) {
        channels.sort((a, b) => a.index - b.index);
        out.push({
          message: m.name,
          label: m.name,
          kind: p.kind,
          channels,
          paramPrefix: p.kind === 'output' ? 'SERVO' : 'RC',
          defaultMin: 1100,
          defaultMax: 1900,
        });
      }
      break;
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.message.localeCompare(b.message) : a.kind === 'output' ? -1 : 1));
}

// ---- Commanded vs achieved pairs (tracking) ----

/** One side of a tracking pair, with the factor that brings it into `unit`. */
export interface PairSide {
  message: string;
  field: string;
  /** Multiplier onto the pair's common unit (e.g. 180/π for a radian column). */
  scale: number;
}

export interface TrackingPair {
  label: string;
  desired: PairSide;
  actual: PairSide;
  unit: string;
  /** Wrap period in `unit`, or 0 when the quantity is not angular. */
  wrap: number;
  /** Whether the desired column varies at all across the whole log. */
  varies: boolean;
}

const RAD2DEG = 180 / Math.PI;

// Candidate pairs across both logging conventions. Units are NOT normalized by
// the parsers — a tlog keeps ATTITUDE.roll in radians and GLOBAL_POSITION_INT.vx
// in cm/s — so each side carries the factor that brings it to the pair's unit.
// Getting this wrong would not error; it would quietly report a gain of 57.
const PAIR_CANDIDATES: ReadonlyArray<Omit<TrackingPair, 'varies'>> = [
  // DataFlash: rate controller, the pair that matters most for tuning.
  { label: 'Roll rate', desired: { message: 'RATE', field: 'RDes', scale: 1 }, actual: { message: 'RATE', field: 'R', scale: 1 }, unit: 'deg/s', wrap: 0 },
  { label: 'Pitch rate', desired: { message: 'RATE', field: 'PDes', scale: 1 }, actual: { message: 'RATE', field: 'P', scale: 1 }, unit: 'deg/s', wrap: 0 },
  { label: 'Yaw rate', desired: { message: 'RATE', field: 'YDes', scale: 1 }, actual: { message: 'RATE', field: 'Y', scale: 1 }, unit: 'deg/s', wrap: 0 },
  { label: 'Vertical accel', desired: { message: 'RATE', field: 'ADes', scale: 1 }, actual: { message: 'RATE', field: 'A', scale: 1 }, unit: 'm/s²', wrap: 0 },
  // DataFlash: attitude.
  { label: 'Roll', desired: { message: 'ATT', field: 'DesRoll', scale: 1 }, actual: { message: 'ATT', field: 'Roll', scale: 1 }, unit: 'deg', wrap: 0 },
  { label: 'Pitch', desired: { message: 'ATT', field: 'DesPitch', scale: 1 }, actual: { message: 'ATT', field: 'Pitch', scale: 1 }, unit: 'deg', wrap: 0 },
  { label: 'Yaw', desired: { message: 'ATT', field: 'DesYaw', scale: 1 }, actual: { message: 'ATT', field: 'Yaw', scale: 1 }, unit: 'deg', wrap: 360 },
  // DataFlash: PID logs, when LOG_BITMASK enables them.
  { label: 'PID roll', desired: { message: 'PIDR', field: 'Tar', scale: 1 }, actual: { message: 'PIDR', field: 'Act', scale: 1 }, unit: '', wrap: 0 },
  { label: 'PID pitch', desired: { message: 'PIDP', field: 'Tar', scale: 1 }, actual: { message: 'PIDP', field: 'Act', scale: 1 }, unit: '', wrap: 0 },
  { label: 'PID yaw', desired: { message: 'PIDY', field: 'Tar', scale: 1 }, actual: { message: 'PIDY', field: 'Act', scale: 1 }, unit: '', wrap: 0 },
  { label: 'PID steering', desired: { message: 'PIDS', field: 'Tar', scale: 1 }, actual: { message: 'PIDS', field: 'Act', scale: 1 }, unit: '', wrap: 0 },
  // MAVLink: navigation demand against the attitude actually held.
  { label: 'Roll (nav)', desired: { message: 'NAV_CONTROLLER_OUTPUT', field: 'navRoll', scale: 1 }, actual: { message: 'ATTITUDE', field: 'roll', scale: RAD2DEG }, unit: 'deg', wrap: 0 },
  { label: 'Pitch (nav)', desired: { message: 'NAV_CONTROLLER_OUTPUT', field: 'navPitch', scale: 1 }, actual: { message: 'ATTITUDE', field: 'pitch', scale: RAD2DEG }, unit: 'deg', wrap: 0 },
  { label: 'Heading', desired: { message: 'NAV_CONTROLLER_OUTPUT', field: 'targetBearing', scale: 1 }, actual: { message: 'VFR_HUD', field: 'heading', scale: 1 }, unit: 'deg', wrap: 360 },
  { label: 'Yaw (target)', desired: { message: 'POSITION_TARGET_GLOBAL_INT', field: 'yaw', scale: RAD2DEG }, actual: { message: 'ATTITUDE', field: 'yaw', scale: RAD2DEG }, unit: 'deg', wrap: 360 },
  // MAVLink: velocity demand (m/s) against the estimate (cm/s).
  { label: 'Velocity north', desired: { message: 'POSITION_TARGET_GLOBAL_INT', field: 'vx', scale: 1 }, actual: { message: 'GLOBAL_POSITION_INT', field: 'vx', scale: 0.01 }, unit: 'm/s', wrap: 0 },
  { label: 'Velocity east', desired: { message: 'POSITION_TARGET_GLOBAL_INT', field: 'vy', scale: 1 }, actual: { message: 'GLOBAL_POSITION_INT', field: 'vy', scale: 0.01 }, unit: 'm/s', wrap: 0 },
  { label: 'Velocity down', desired: { message: 'POSITION_TARGET_GLOBAL_INT', field: 'vz', scale: 1 }, actual: { message: 'GLOBAL_POSITION_INT', field: 'vz', scale: 0.01 }, unit: 'm/s', wrap: 0 },
];

function columnOf(messages: Record<string, MessageSeries>, side: PairSide): Float64Array | null {
  const m = messages[side.message];
  if (!m || m.time.length === 0) return null;
  return m.fields[side.field] ?? null;
}

/** Whether a column ever moves; a constant demand carries nothing to track. */
function varies(col: Float64Array): boolean {
  let first = NaN;
  for (let i = 0; i < col.length; i++) {
    const v = col[i];
    if (!Number.isFinite(v)) continue;
    if (!Number.isFinite(first)) first = v;
    else if (v !== first) return true;
  }
  return false;
}

/**
 * Commanded/achieved pairs the log actually carries.
 *
 * Pairs whose demand never moves sort last and are flagged: an autopilot that
 * publishes a field it does not drive is common (this vehicle's tlog logs
 * NAV_CONTROLLER_OUTPUT.navRoll as a constant zero), and offering that as a
 * default would hand the user a gain of NaN and no explanation.
 */
export function detectTrackingPairs(messages: Record<string, MessageSeries>): TrackingPair[] {
  const out: TrackingPair[] = [];
  for (const c of PAIR_CANDIDATES) {
    const des = columnOf(messages, c.desired);
    const act = columnOf(messages, c.actual);
    if (!des || !act) continue;
    out.push({ ...c, varies: varies(des) && varies(act) });
  }
  return out.sort((a, b) => Number(b.varies) - Number(a.varies));
}

// ---- Scatter presets (X against Y with a line fit) ----

export interface ScatterAxis {
  message: string;
  field: string;
  /** Multiplier onto `unit`. */
  scale: number;
  unit: string;
  label: string;
}

export interface ScatterPreset {
  label: string;
  x: ScatterAxis;
  y: ScatterAxis;
  /** Turns the fitted slope into a physical quantity in the readout. */
  interpret?: 'internal-resistance';
  note?: string;
}

const ax = (message: string, field: string, scale: number, unit: string, label: string): ScatterAxis => ({
  message,
  field,
  scale,
  unit,
  label,
});

// Each preset is offered only when both of its columns exist. Voltage/current
// come in three spellings across .bin and MAVLink, and the MAVLink ones are in
// mV and cA, so the scale factors matter as much as the field names.
const SCATTER_PRESETS: ReadonlyArray<ScatterPreset> = [
  {
    label: 'Battery internal resistance',
    x: ax('BAT', 'Curr', 1, 'A', 'current'),
    y: ax('BAT', 'Volt', 1, 'V', 'voltage'),
    interpret: 'internal-resistance',
  },
  {
    label: 'Battery internal resistance',
    x: ax('SYS_STATUS', 'currentBattery', 0.01, 'A', 'current'),
    y: ax('SYS_STATUS', 'voltageBattery', 0.001, 'V', 'voltage'),
    interpret: 'internal-resistance',
  },
  {
    label: 'Throttle vs speed',
    x: ax('VFR_HUD', 'throttle', 1, '%', 'throttle'),
    y: ax('VFR_HUD', 'groundspeed', 1, 'm/s', 'ground speed'),
    note: 'The intercept on the throttle axis is roughly where the vehicle starts to move — its deadband plus drag.',
  },
  {
    label: 'Throttle vs speed',
    x: ax('CTUN', 'ThO', 1, '', 'throttle out'),
    y: ax('GPS', 'Spd', 1, 'm/s', 'ground speed'),
    note: 'The intercept on the throttle axis is roughly where the vehicle starts to move — its deadband plus drag.',
  },
  {
    label: 'Throttle vs current',
    x: ax('VFR_HUD', 'throttle', 1, '%', 'throttle'),
    y: ax('SYS_STATUS', 'currentBattery', 0.01, 'A', 'current'),
  },
  {
    label: 'Throttle vs current',
    x: ax('CTUN', 'ThO', 1, '', 'throttle out'),
    y: ax('BAT', 'Curr', 1, 'A', 'current'),
  },
  {
    label: 'Speed vs current',
    x: ax('VFR_HUD', 'groundspeed', 1, 'm/s', 'ground speed'),
    y: ax('SYS_STATUS', 'currentBattery', 0.01, 'A', 'current'),
  },
];

/** Presets whose two columns both exist, first spelling of each label wins. */
export function detectScatterPresets(messages: Record<string, MessageSeries>): ScatterPreset[] {
  const out: ScatterPreset[] = [];
  const seen = new Set<string>();
  for (const p of SCATTER_PRESETS) {
    if (seen.has(p.label)) continue;
    if (!columnOf(messages, p.x) || !columnOf(messages, p.y)) continue;
    seen.add(p.label);
    out.push(p);
  }
  return out;
}

// ---- Spectrum sources ----

export interface SpectrumSources {
  /** Onboard-FFT result messages (FFT_ENABLE). Already spectral: show, don't transform. */
  onboardFft: { message: string; fields: string[] }[];
  /** Batch IMU sampling present (INS_LOG_BAT_MASK), i.e. genuine high-rate data. */
  hasBatchImu: boolean;
}

/**
 * What the log offers for vibration work, as opposed to what can merely be
 * transformed.
 *
 * VIBE/VIBRATION is deliberately absent: it is already a filtered amplitude
 * envelope, so its spectrum describes the filter, not the airframe. Ordinary
 * telemetry (ATT, RATE, RCOU) is logged at tens of hertz at best, which puts
 * every propeller order above Nyquist where it folds back to a plausible-looking
 * low-frequency peak — the classic way to end up notching the wrong frequency.
 */
export function detectSpectrumSources(messages: Record<string, MessageSeries>): SpectrumSources {
  const onboardFft: { message: string; fields: string[] }[] = [];
  for (const name of ['FTN1', 'FTN2', 'FTNS']) {
    const m = messages[name];
    if (!m || m.time.length === 0) continue;
    const fields = Object.keys(m.fields).filter((f) => /^Pk|^Fr|^En|Freq/i.test(f));
    if (fields.length) onboardFft.push({ message: name, fields });
  }
  const isbh = messages['ISBH'];
  const isbd = messages['ISBD'];
  return {
    onboardFft,
    hasBatchImu: Boolean(isbh && isbh.time.length > 0 && isbd && isbd.time.length > 0),
  };
}
