import { describe, expect, it } from 'vitest';
import { elapsedTicks, formatElapsed } from './format.ts';

describe('formatElapsed', () => {
  it('reads as m:ss below an hour', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9)).toBe('0:09');
    expect(formatElapsed(125)).toBe('2:05');
    expect(formatElapsed(3599)).toBe('59:59');
  });

  it('grows an hours field at an hour', () => {
    expect(formatElapsed(3600)).toBe('1:00:00');
    expect(formatElapsed(3725)).toBe('1:02:05');
    expect(formatElapsed(45296)).toBe('12:34:56');
  });

  it('takes the long form on request, so a row of ticks keeps one shape', () => {
    expect(formatElapsed(65, 0, true)).toBe('0:01:05');
    expect(formatElapsed(0, 0, true)).toBe('0:00:00');
  });

  it('pads fractional seconds to two whole digits', () => {
    expect(formatElapsed(5.25, 1)).toBe('0:05.3');
    expect(formatElapsed(65.04, 1)).toBe('1:05.0');
    expect(formatElapsed(3600.5, 2)).toBe('1:00:00.50');
  });

  // Rounding after splitting would let the seconds reach 60 without carrying.
  it('carries a rounded-up second into the minute and the hour', () => {
    expect(formatElapsed(59.98, 1)).toBe('1:00.0');
    expect(formatElapsed(3599.98, 1)).toBe('1:00:00.0');
    expect(formatElapsed(59.6)).toBe('1:00');
  });

  it('keeps a negative offset signed rather than wrapping it', () => {
    expect(formatElapsed(-65)).toBe('-1:05');
    expect(formatElapsed(-3665)).toBe('-1:01:05');
  });

  // An axis tick a hair below the origin would otherwise read "-0:00", claiming
  // a direction the value does not have once it is rounded for printing.
  it('drops the sign from a value that rounds away to zero', () => {
    expect(formatElapsed(-0.001, 2)).toBe('0:00.00');
    expect(formatElapsed(-0.4)).toBe('0:00');
    expect(formatElapsed(-0)).toBe('0:00');
  });

  it('reports a non-finite value as an em dash', () => {
    expect(formatElapsed(NaN)).toBe('—');
    expect(formatElapsed(Infinity)).toBe('—');
  });
});

describe('elapsedTicks', () => {
  it('drops the fraction when the ticks are whole seconds apart', () => {
    expect(elapsedTicks([0, 60, 120], 60)).toEqual(['0:00', '1:00', '2:00']);
  });

  it('keeps enough decimals for a sub-second tick spacing', () => {
    expect(elapsedTicks([0, 0.5, 1], 0.5)).toEqual(['0:00.0', '0:00.5', '0:01.0']);
    expect(elapsedTicks([0, 0.05, 0.1], 0.05)).toEqual(['0:00.00', '0:00.05', '0:00.10']);
  });

  it('falls back to whole seconds when uPlot reports no spacing', () => {
    expect(elapsedTicks([0, 60], undefined as unknown as number)).toEqual(['0:00', '1:00']);
    expect(elapsedTicks([0, 60], 0)).toEqual(['0:00', '1:00']);
  });

  // Half the axis in m:ss and half in h:mm:ss would change what the leading
  // field means partway along the row.
  it('puts the hours field on every tick once any of them reaches an hour', () => {
    expect(elapsedTicks([3000, 3600, 4200], 600)).toEqual(['0:50:00', '1:00:00', '1:10:00']);
  });
});
