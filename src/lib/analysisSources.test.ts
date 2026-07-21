import { describe, expect, it } from 'vitest';
import { detectDriverSources, detectMagSources } from './analysisSources.ts';
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
