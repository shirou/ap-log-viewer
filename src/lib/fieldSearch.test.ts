import { describe, expect, it } from 'vitest';
import { parseQuery, searchMessages } from './fieldSearch.ts';
import type { MessageSeries } from '../model/log.ts';

// Only the field names matter here, so the columns stay empty.
function msg(name: string, ...fields: string[]): MessageSeries {
  return {
    name,
    fields: Object.fromEntries(fields.map((f) => [f, new Float64Array(0)])),
    labels: fields,
    time: new Float64Array(0),
  };
}

// Names taken from real logs: .bin abbreviations and MAVLink camelCase side by
// side, since the two conventions are what make field search worth having.
const LOG: Record<string, MessageSeries> = Object.fromEntries(
  [
    msg('GPS', 'TimeUS', 'Status', 'Lat', 'Lng', 'Alt', 'Spd', 'GCrs'),
    msg('GPS2', 'TimeUS', 'Status', 'Alt', 'GCrs'),
    msg('GPS_RAW_INT', 'timeUsec', 'lat', 'lon', 'alt', 'vel', 'cog'),
    msg('ATT', 'TimeUS', 'DesRoll', 'Roll', 'DesPitch', 'Pitch'),
    msg('VFR_HUD', 'airspeed', 'groundspeed', 'heading', 'throttle', 'alt'),
    msg('RAW_IMU', 'timeUsec', 'xacc', 'yacc', 'zacc', 'xmag', 'ymag', 'zmag'),
    // Its name is a substring of three of its own fields, which is the case
    // that decides whether a name hit or a field hit wins.
    msg('BATTERY_STATUS', 'id', 'batteryFunction', 'temperature', 'currentBattery', 'batteryRemaining'),
    msg('MSG', 'TimeUS'), // time only: nothing plottable
  ].map((m) => [m.name, m]),
);

const GPS_FIELDS = ['Status', 'Lat', 'Lng', 'Alt', 'Spd', 'GCrs'];
// localeCompare weighs the underscore below the digit, so GPS_RAW_INT lands
// before GPS2. That ordering predates this module (FieldTree sorted the same
// way) and is kept, so the expectations below spell it out rather than fight it.
const GPS_ORDER = ['GPS', 'GPS_RAW_INT', 'GPS2'];
const names = (raw: string) => searchMessages(LOG, raw).map((m) => m.series.name);
const find = (raw: string, name: string) => searchMessages(LOG, raw).find((m) => m.series.name === name);

describe('parseQuery', () => {
  it('is null while the box is effectively empty', () => {
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('   ')).toBeNull();
    expect(parseQuery('.')).toBeNull();
    // A one-letter field term with no message half leaves nothing to match on.
    expect(parseQuery('.c')).toBeNull();
  });

  it('lowercases and applies a bare term to both halves', () => {
    expect(parseQuery('XMag')).toEqual({ message: 'xmag', field: 'xmag', dotted: false });
  });

  it('splits on the first dot only', () => {
    expect(parseQuery('GPS.cog')).toEqual({ message: 'gps', field: 'cog', dotted: true });
    expect(parseQuery('a.b.c')).toEqual({ message: 'a', field: 'b.c', dotted: true });
  });

  it('keeps a trailing dot as "this message, all fields"', () => {
    expect(parseQuery('gps.')).toEqual({ message: 'gps', field: '', dotted: true });
  });

  it('drops field terms shorter than two characters', () => {
    expect(parseQuery('c')).toEqual({ message: 'c', field: '', dotted: false });
    expect(parseQuery('gps.c')).toEqual({ message: 'gps', field: '', dotted: true });
  });
});

describe('searchMessages', () => {
  it('shows every message with a plottable field when not searching', () => {
    const all = searchMessages(LOG, '');
    // MSG carries only a timestamp, so it never gets a row.
    expect(all.map((m) => m.series.name)).not.toContain('MSG');
    expect(all).toHaveLength(7);
    expect(all.every((m) => !m.autoExpand && m.hits.size === 0)).toBe(true);
  });

  it('sorts by message name', () => {
    expect(names('')[0]).toBe('ATT');
    expect(names('')[1]).toBe('BATTERY_STATUS');
  });

  it('never offers the time column as a field', () => {
    expect(find('', 'GPS')?.fields).toEqual(GPS_FIELDS);
  });

  it('finds a field name and opens the message showing only the hits', () => {
    expect(names('cog')).toEqual(['GPS_RAW_INT']);
    const m = find('cog', 'GPS_RAW_INT');
    expect(m?.fields).toEqual(['cog']);
    expect(m?.hits).toEqual(new Set(['cog']));
    expect(m?.autoExpand).toBe(true);
  });

  it('reaches every message carrying the field', () => {
    expect(names('alt')).toEqual([...GPS_ORDER, 'VFR_HUD']);
    expect(find('alt', 'GPS')?.fields).toEqual(['Alt']);
    expect(find('alt', 'VFR_HUD')?.fields).toEqual(['alt']);
  });

  it('matches case-insensitively', () => {
    expect(names('XMAG')).toEqual(['RAW_IMU']);
    expect(find('XMAG', 'RAW_IMU')?.fields).toEqual(['xmag']);
    expect(find('throttle', 'VFR_HUD')?.fields).toEqual(['throttle']);
  });

  it('leaves a name-only match collapsed with all of its fields', () => {
    const m = find('gps', 'GPS');
    expect(m?.autoExpand).toBe(false);
    expect(m?.fields).toEqual(GPS_FIELDS);
    expect(m?.hits.size).toBe(0);
  });

  it('lets a name hit keep the full field list while still flagging field hits', () => {
    const m = find('battery', 'BATTERY_STATUS');
    expect(m?.autoExpand).toBe(false);
    expect(m?.fields).toHaveLength(5);
    expect(m?.hits).toEqual(new Set(['batteryFunction', 'currentBattery', 'batteryRemaining']));
  });

  it('ANDs the two halves for a dotted query', () => {
    expect(names('gps.cog')).toEqual(['GPS_RAW_INT']);
    const m = find('gps.cog', 'GPS_RAW_INT');
    expect(m?.fields).toEqual(['cog']);
    expect(m?.autoExpand).toBe(true);
    // RAW_IMU matches the message half but carries no cog.
    expect(names('imu.cog')).toEqual([]);
  });

  it('narrows a dotted query even when the name alone would have matched', () => {
    // The bare form keeps every field (see above); the explicit form must not.
    expect(find('battery.battery', 'BATTERY_STATUS')?.fields).toEqual([
      'batteryFunction',
      'currentBattery',
      'batteryRemaining',
    ]);
  });

  it('treats a trailing dot as "all fields of these messages"', () => {
    expect(names('gps.')).toEqual(GPS_ORDER);
    const m = find('gps.', 'GPS');
    expect(m?.fields).toEqual(GPS_FIELDS);
    expect(m?.autoExpand).toBe(false);
  });

  it('searches fields across every message for a leading dot', () => {
    expect(names('.mag')).toEqual(['RAW_IMU']);
    expect(find('.mag', 'RAW_IMU')?.fields).toEqual(['xmag', 'ymag', 'zmag']);
  });

  it('does not match fields on a one-character term', () => {
    // "c" is in GCrs, cog and xacc, but one letter may only match message names.
    expect(names('c')).toEqual([]);
    expect(names('g')).toEqual(GPS_ORDER);
    expect(searchMessages(LOG, 'g').every((m) => !m.autoExpand)).toBe(true);
  });

  it('is empty when nothing matches', () => {
    expect(names('zzzz')).toEqual([]);
  });
});
