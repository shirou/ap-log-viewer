// DataFlash fixtures whose parse is frozen as a golden file.
//
// These exist for one invariant: splitting a log by MAVLink source must not
// change what a `.bin` parses to. A `.bin` has no sysid/compid, so it becomes a
// `ParsedLog` holding a single source, and projecting that back out has to
// reproduce exactly what `parseDataflash` returns today.
//
// The golden was generated *before* any of that work started, against the
// parser as it stood. Comparing against expectations written afterwards would
// only prove the new code agrees with itself.
//
// Apart from testFixtures.ts because these are frozen: a fixture the golden
// depends on must not be edited to suit a later test, or the comparison
// silently stops meaning anything.

import {
  CMD_COLUMNS,
  CMD_FORMAT,
  GPS_COLUMNS,
  GPS_FORMAT,
  MODE_COLUMNS,
  MODE_FORMAT,
  MSG_COLUMNS,
  MSG_FORMAT,
  PARM_COLUMNS,
  PARM_FORMAT,
  PARM_NOTIME_COLUMNS,
  PARM_NOTIME_FORMAT,
  cmdMessage,
  fmtForFmtMessage,
  fmtMessage,
  gpsMessage,
  modeMessage,
  msgMessage,
  parmMessage,
  parmNoTimeMessage,
  record,
  sizeOf,
  strBytes,
} from './testFixtures.ts';

/**
 * `VER` carrying the firmware string.
 *
 * testFixtures' `verMessage` predates this and stops at `Min`, because nothing
 * read further. The vehicle kind comes out of `FWS`, so the golden needs a
 * record that actually has it — and needs it frozen here rather than bolted
 * onto the shared helper, whose other callers pin byte offsets.
 */
export const VER_FWS_FORMAT = 'QBBHHZ';
export const VER_FWS_COLUMNS = 'TimeUS,BT,BST,Maj,Min,FWS';

export function verFwsMessage(type: number, timeUS: number, fws: string): number[] {
  const { u, dv } = record(type, sizeOf(VER_FWS_FORMAT));
  dv.setBigUint64(3, BigInt(timeUS), true);
  dv.setUint8(11, 10); // BT = HAL_BOARD_CHIBIOS, deliberately equal to MAV_TYPE_GROUND_ROVER
  dv.setUint8(12, 0);
  dv.setUint16(13, 4, true);
  dv.setUint16(15, 6, true);
  u.set(strBytes(fws, 64), 17);
  return [...u];
}

const GPS = 130;
const PARM = 131;
const MODE = 132;
const MSG = 133;
const VER = 134;
const CMD = 135;
const MISE = 136;
const PARM_NOTIME = 137;

/**
 * A rounded `.bin`: firmware banner, parameters, a mode change, a mission and a
 * step through it, and enough GPS to make a trajectory.
 *
 * `MODE` carries 0, which for a Rover is `MANUAL` — so this fixture is also
 * what proves the firmware string reaches the mode table.
 */
const TYPICAL = new Uint8Array([
  ...fmtForFmtMessage(),
  ...fmtMessage(GPS, 'GPS', GPS_FORMAT, GPS_COLUMNS),
  ...fmtMessage(PARM, 'PARM', PARM_FORMAT, PARM_COLUMNS),
  ...fmtMessage(MODE, 'MODE', MODE_FORMAT, MODE_COLUMNS),
  ...fmtMessage(MSG, 'MSG', MSG_FORMAT, MSG_COLUMNS),
  ...fmtMessage(VER, 'VER', VER_FWS_FORMAT, VER_FWS_COLUMNS),
  ...fmtMessage(CMD, 'CMD', CMD_FORMAT, CMD_COLUMNS),
  ...fmtMessage(MISE, 'MISE', CMD_FORMAT, CMD_COLUMNS),

  ...msgMessage(MSG, 1_000_000, 'ArduRover V4.6.3 (3fc7011a)'),
  ...verFwsMessage(VER, 1_010_000, 'ArduRover V4.6.3 (3fc7011a)'),
  ...msgMessage(MSG, 1_020_000, 'ChibiOS: 88b84600'),
  ...parmMessage(PARM, 1_030_000, 'WP_SPEED', 2.5),
  ...parmMessage(PARM, 1_040_000, 'BATT_CAPACITY', 5000),
  ...modeMessage(MODE, 1_050_000, 0),

  ...cmdMessage(CMD, { seq: 0, total: 3, timeUS: 1_060_000, lat: 35.0, lon: 139.0, alt: 0 }),
  ...cmdMessage(CMD, { seq: 1, total: 3, timeUS: 1_070_000, lat: 35.01, lon: 139.01, alt: 30 }),
  ...cmdMessage(CMD, { seq: 2, total: 3, timeUS: 1_080_000, lat: 35.02, lon: 139.02, alt: 30 }),

  ...gpsMessage(GPS, 2_000_000, 35.0, 139.0, 100),
  ...gpsMessage(GPS, 3_000_000, 35.001, 139.001, 110),
  ...gpsMessage(GPS, 4_000_000, 35.002, 139.002, 120),

  ...cmdMessage(MISE, { seq: 1, timeUS: 3_500_000, lat: 35.01, lon: 139.01 }),
  ...modeMessage(MODE, 4_500_000, 10),
]);

/**
 * A `.bin` in which no record carries `TimeUS`.
 *
 * The only fixture that reaches `parseDataflash`'s time fallback, which reads
 * the trajectory's ends when `minTime` never became finite. There is no
 * trajectory here either, so it settles on 0/0 — and that is the number the
 * golden freezes, because moving the trajectory out of the parser would change
 * it silently.
 */
const TIMELESS = new Uint8Array([
  ...fmtForFmtMessage(),
  ...fmtMessage(PARM_NOTIME, 'PARM', PARM_NOTIME_FORMAT, PARM_NOTIME_COLUMNS),
  ...parmNoTimeMessage(PARM_NOTIME, 'WP_SPEED', 2.5),
  ...parmNoTimeMessage(PARM_NOTIME, 'BATT_CAPACITY', 5000),
]);

export const GOLDEN_BIN_CASES: ReadonlyArray<{ name: string; bytes: Uint8Array }> = [
  { name: 'typical', bytes: TYPICAL },
  { name: 'timeless', bytes: TIMELESS },
];
