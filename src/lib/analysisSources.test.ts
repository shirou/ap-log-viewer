import { describe, expect, it } from 'vitest';
import {
  detectActuatorSources,
  detectDriverSources,
  detectMagSources,
  detectScatterPresets,
  detectSpectrumSources,
  detectTrackingPairs,
} from './analysisSources.ts';
import type { MessageSeries } from '../model/log.ts';

// Non-empty time so the presence checks (which require samples) pass.
function msg(name: string, ...fields: string[]): MessageSeries {
  return {
    name,
    fields: Object.fromEntries(fields.map((f) => [f, new Float64Array([0])])),
    labels: fields,
    time: new Float64Array([0]),
  };
}
const logOf = (...ms: MessageSeries[]): Record<string, MessageSeries> =>
  Object.fromEntries(ms.map((m) => [m.name, m]));

describe('detectMagSources', () => {
  it('finds .bin and MAVLink triples, primary compass first', () => {
    const sources = detectMagSources(
      logOf(
        msg('MAG2', 'MagX', 'MagY', 'MagZ'),
        msg('MAG', 'MagX', 'MagY', 'MagZ'),
        msg('SCALED_IMU2', 'xmag', 'ymag', 'zmag'),
        msg('RAW_IMU', 'xmag', 'ymag', 'zmag'),
      ),
    );
    expect(sources.map((s) => s.message)).toEqual(['MAG', 'RAW_IMU', 'MAG2', 'SCALED_IMU2']);
    expect(sources[0]).toMatchObject({ xField: 'MagX', yField: 'MagY', zField: 'MagZ' });
  });
  it('ignores partial triples and empty-time messages', () => {
    expect(detectMagSources(logOf(msg('MAG', 'MagX', 'MagY'))).length).toBe(0);
    const empty: MessageSeries = {
      name: 'MAG',
      fields: { MagX: new Float64Array(0), MagY: new Float64Array(0), MagZ: new Float64Array(0) },
      labels: [],
      time: new Float64Array(0),
    };
    expect(detectMagSources({ MAG: empty }).length).toBe(0);
  });
});

describe('detectDriverSources', () => {
  it('finds current/throttle in preference order', () => {
    const sources = detectDriverSources(logOf(msg('VFR_HUD', 'throttle'), msg('BAT', 'Curr')));
    expect(sources[0]).toMatchObject({ message: 'BAT', field: 'Curr', kind: 'current' });
    expect(sources.map((s) => s.kind)).toEqual(['current', 'throttle']);
  });
  it('is empty when nothing matches', () => {
    expect(detectDriverSources(logOf(msg('GPS', 'Alt'))).length).toBe(0);
  });
});

describe('detectActuatorSources', () => {
  it('finds .bin and MAVLink channel banks, outputs before inputs', () => {
    const sources = detectActuatorSources(
      logOf(
        msg('RC_CHANNELS', 'chan1Raw', 'chan2Raw', 'chan3Raw'),
        msg('SERVO_OUTPUT_RAW', 'servo1Raw', 'servo2Raw'),
      ),
    );
    expect(sources.map((s) => s.kind)).toEqual(['output', 'input']);
    expect(sources[0].channels.map((c) => c.index)).toEqual([1, 2]);
    expect(sources[1].channels.length).toBe(3);
  });

  it('orders channels numerically, not as strings', () => {
    const s = detectActuatorSources(logOf(msg('RCOU', 'C1', 'C10', 'C2', 'C9')))[0];
    expect(s.channels.map((c) => c.index)).toEqual([1, 2, 9, 10]);
  });

  it('ignores a message with fewer than two channels', () => {
    expect(detectActuatorSources(logOf(msg('RCOU', 'C1'))).length).toBe(0);
  });

  // Outputs and inputs keep their endpoints in different parameter families;
  // reading SERVOn_MIN for an RC channel mis-scales every saturation figure.
  it('points each bank at its own parameter family', () => {
    const [out, inp] = detectActuatorSources(logOf(msg('RCOU', 'C1', 'C2'), msg('RCIN', 'C1', 'C2')));
    expect(out).toMatchObject({ kind: 'output', paramPrefix: 'SERVO' });
    expect(inp).toMatchObject({ kind: 'input', paramPrefix: 'RC' });
  });
});

describe('detectTrackingPairs', () => {
  it('pairs a .bin rate demand with its response', () => {
    const pairs = detectTrackingPairs(logOf(msg('RATE', 'RDes', 'R', 'PDes', 'P')));
    expect(pairs.map((p) => p.label)).toContain('Roll rate');
    expect(pairs.find((p) => p.label === 'Roll rate')).toMatchObject({ unit: 'deg/s', wrap: 0 });
  });

  it('carries the factor that reconciles radians with degrees', () => {
    const pairs = detectTrackingPairs(logOf(msg('NAV_CONTROLLER_OUTPUT', 'navRoll'), msg('ATTITUDE', 'roll')));
    const p = pairs.find((x) => x.label === 'Roll (nav)')!;
    expect(p.desired.scale).toBe(1);
    expect(p.actual.scale).toBeCloseTo(180 / Math.PI, 9);
  });

  it('marks headings as wrapping so they get unwrapped before comparison', () => {
    const pairs = detectTrackingPairs(logOf(msg('NAV_CONTROLLER_OUTPUT', 'targetBearing'), msg('VFR_HUD', 'heading')));
    expect(pairs.find((p) => p.label === 'Heading')!.wrap).toBe(360);
  });

  // A constant demand is common (this vehicle logs navRoll as a flat zero) and
  // would otherwise be offered as the default pair with a gain of NaN.
  it('flags a demand that never moves and sorts it last', () => {
    const varying: MessageSeries = {
      name: 'RATE',
      fields: {
        RDes: new Float64Array([0, 1, 2]),
        R: new Float64Array([0, 1, 2]),
        PDes: new Float64Array([0, 0, 0]),
        P: new Float64Array([0, 1, 2]),
      },
      labels: [],
      time: new Float64Array([0, 1, 2]),
    };
    const pairs = detectTrackingPairs({ RATE: varying });
    expect(pairs[0].label).toBe('Roll rate');
    expect(pairs[0].varies).toBe(true);
    expect(pairs.find((p) => p.label === 'Pitch rate')!.varies).toBe(false);
  });

  it('needs both halves of a pair', () => {
    expect(detectTrackingPairs(logOf(msg('RATE', 'RDes'))).length).toBe(0);
  });
});

describe('detectScatterPresets', () => {
  it('offers the battery fit and scales MAVLink mV/cA into V/A', () => {
    const presets = detectScatterPresets(logOf(msg('SYS_STATUS', 'voltageBattery', 'currentBattery')));
    const p = presets.find((x) => x.label === 'Battery internal resistance')!;
    expect(p.interpret).toBe('internal-resistance');
    expect(p.x.scale).toBeCloseTo(0.01, 9); // cA -> A
    expect(p.y.scale).toBeCloseTo(0.001, 9); // mV -> V
  });

  it('prefers the .bin spelling and does not offer the same fit twice', () => {
    const presets = detectScatterPresets(
      logOf(msg('BAT', 'Volt', 'Curr'), msg('SYS_STATUS', 'voltageBattery', 'currentBattery')),
    );
    const battery = presets.filter((p) => p.label === 'Battery internal resistance');
    expect(battery.length).toBe(1);
    expect(battery[0].x.message).toBe('BAT');
  });

  it('offers nothing when neither column exists', () => {
    expect(detectScatterPresets(logOf(msg('GPS', 'Alt'))).length).toBe(0);
  });
});

describe('detectSpectrumSources', () => {
  it('reports onboard FFT results', () => {
    const s = detectSpectrumSources(logOf(msg('FTN1', 'PkAvg', 'PkX', 'PkY', 'PkZ', 'EnX')));
    expect(s.onboardFft[0].message).toBe('FTN1');
    expect(s.onboardFft[0].fields).toContain('PkAvg');
  });

  it('needs both halves of the batch-IMU pair', () => {
    expect(detectSpectrumSources(logOf(msg('ISBH', 'SampleUS'))).hasBatchImu).toBe(false);
    expect(detectSpectrumSources(logOf(msg('ISBH', 'SampleUS'), msg('ISBD', 'x'))).hasBatchImu).toBe(true);
  });

  // VIBE is already an amplitude envelope: its spectrum describes the filter
  // that produced it, not the airframe.
  it('never treats VIBE/VIBRATION as a spectrum source', () => {
    const s = detectSpectrumSources(logOf(msg('VIBE', 'VibeX', 'VibeY', 'VibeZ'), msg('VIBRATION', 'vibrationX')));
    expect(s.onboardFft.length).toBe(0);
    expect(s.hasBatchImu).toBe(false);
  });
});
