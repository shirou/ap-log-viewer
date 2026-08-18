import { describe, it, expect } from 'vitest';
import { ardupilotmega, minimal } from 'mavlink-mappings';
import { kindFromFirmware, kindFromMavType, modeLabel } from './vehicleModes.ts';

describe('kindFromMavType', () => {
  it('maps the vehicles ArduPilot flies', () => {
    expect(kindFromMavType(minimal.MavType.SURFACE_BOAT)).toBe('rover');
    expect(kindFromMavType(minimal.MavType.GROUND_ROVER)).toBe('rover');
    expect(kindFromMavType(minimal.MavType.QUADROTOR)).toBe('copter');
    expect(kindFromMavType(minimal.MavType.HEXAROTOR)).toBe('copter');
    expect(kindFromMavType(minimal.MavType.FIXED_WING)).toBe('plane');
    expect(kindFromMavType(minimal.MavType.VTOL_TILTROTOR)).toBe('plane');
    expect(kindFromMavType(minimal.MavType.SUBMARINE)).toBe('sub');
    expect(kindFromMavType(minimal.MavType.ANTENNA_TRACKER)).toBe('tracker');
  });

  // This is also the "which source is the vehicle" test, so the non-vehicles
  // matter as much as the vehicles: a gimbal is no more a flight source than a
  // ground station is.
  it('rejects everything that is not a vehicle', () => {
    expect(kindFromMavType(minimal.MavType.GCS)).toBeNull();
    expect(kindFromMavType(minimal.MavType.GIMBAL)).toBeNull();
    expect(kindFromMavType(minimal.MavType.ADSB)).toBeNull();
    expect(kindFromMavType(minimal.MavType.CAMERA)).toBeNull();
    expect(kindFromMavType(minimal.MavType.ONBOARD_CONTROLLER)).toBeNull();
    expect(kindFromMavType(minimal.MavType.GENERIC)).toBeNull();
    expect(kindFromMavType(9999)).toBeNull();
  });

  it('reads the real log: sysid 1 is a SURFACE_BOAT, the other three are GCSs', () => {
    // Measured from 2026-07-15_20-07-51.tlog: 1/1 announces MAV_TYPE 11 and the
    // other three announce 6. That split is what the default source selection
    // rests on, so pin the two numbers rather than only the names.
    expect(minimal.MavType.SURFACE_BOAT).toBe(11);
    expect(minimal.MavType.GCS).toBe(6);
    expect(kindFromMavType(11)).toBe('rover');
    expect(kindFromMavType(6)).toBeNull();
  });
});

describe('kindFromFirmware', () => {
  it('reads both generations of banner', () => {
    expect(kindFromFirmware('ArduRover V4.6.3 (3fc7011a)')).toBe('rover');
    expect(kindFromFirmware('APM:Copter V3.2.1')).toBe('copter');
    expect(kindFromFirmware('ArduPlane V4.5.7')).toBe('plane');
    expect(kindFromFirmware('ArduSub V4.1.0')).toBe('sub');
    expect(kindFromFirmware('AntennaTracker V1.1')).toBe('tracker');
  });

  // A .bin opens with several banner lines and the vehicle one is not always
  // first — 00000008.BIN starts with "EKF variance". A caller walks MSG rows
  // until one answers, so the others have to answer null.
  it('ignores the other banner lines', () => {
    expect(kindFromFirmware('ChibiOS: 88b84600')).toBeNull();
    expect(kindFromFirmware('Pixhawk6C 0022002D 33335111 33323335')).toBeNull();
    expect(kindFromFirmware('Param space used: 1038/5120')).toBeNull();
    expect(kindFromFirmware('EKF variance')).toBeNull();
    expect(kindFromFirmware('')).toBeNull();
  });
});

describe('modeLabel', () => {
  it('names the modes the sample log actually flew', () => {
    // The whole point of splitting by source: 1/1's customMode goes 0,10,0,10,
    // which on a SURFACE_BOAT reads MANUAL -> AUTO -> MANUAL -> AUTO.
    expect(modeLabel('rover', 0)).toBe('MANUAL');
    expect(modeLabel('rover', 10)).toBe('AUTO');
  });

  it('reads the same number differently per vehicle', () => {
    expect(modeLabel('copter', 3)).toBe('AUTO');
    expect(modeLabel('rover', 3)).toBe('STEERING');
    expect(modeLabel('plane', 3)).toBe('TRAINING');
    expect(modeLabel('sub', 3)).toBe('AUTO');
  });

  it('falls back to the current wording, never to an invented name', () => {
    expect(modeLabel('rover', 99)).toBe('Mode 99');
    expect(modeLabel(null, 10)).toBe('Mode 10');
    expect(modeLabel(null, 0)).toBe('Mode 0');
    // Rover skips 2 and 13/14; an absent entry is not a resolvable mode.
    expect(modeLabel('rover', 2)).toBe('Mode 2');
    expect(modeLabel('rover', NaN)).toBe('Mode NaN');
  });
});

// A guard, not a behaviour test: every table here comes from the dialect, so a
// mavlink-mappings update that renamed or dropped one would leave modeLabel
// silently answering "Mode N" for every log.
describe('the dialect still carries the tables these rest on', () => {
  it.each([
    ['CopterMode', ardupilotmega.CopterMode],
    ['PlaneMode', ardupilotmega.PlaneMode],
    ['RoverMode', ardupilotmega.RoverMode],
    ['SubMode', ardupilotmega.SubMode],
    ['TrackerMode', ardupilotmega.TrackerMode],
  ])('%s exists and has numeric keys', (_name, table) => {
    expect(table).toBeDefined();
    const numeric = Object.keys(table as object).filter((k) => /^[0-9]+$/.test(k));
    expect(numeric.length).toBeGreaterThan(0);
  });

  it('MavType still names the types the mapping is written against', () => {
    for (const name of [
      'FIXED_WING', 'QUADROTOR', 'GROUND_ROVER', 'SURFACE_BOAT', 'SUBMARINE',
      'ANTENNA_TRACKER', 'HELICOPTER', 'HEXAROTOR', 'OCTOROTOR', 'TRICOPTER',
      'COAXIAL', 'DODECAROTOR', 'VTOL_TILTROTOR', 'VTOL_TAILSITTER',
      'VTOL_FIXEDROTOR', 'VTOL_TILTWING', 'VTOL_TAILSITTER_DUOROTOR',
      'VTOL_TAILSITTER_QUADROTOR', 'VTOL_RESERVED5',
    ]) {
      expect(typeof (minimal.MavType as unknown as Record<string, number>)[name]).toBe('number');
    }
  });
});
