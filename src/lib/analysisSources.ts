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
