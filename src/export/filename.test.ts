import { describe, expect, it } from 'vitest';
import { windowFilename } from './filename.ts';

const original = { format: 'original' as const };

describe('windowFilename', () => {
  it('names the window in the seconds the plot showed', () => {
    expect(windowFilename('2026-07-15_20-07-51.tlog', 'tlog', 41.234, 68.7, original)).toBe(
      '2026-07-15_20-07-51_41.2-68.7s.tlog',
    );
  });

  // A flight controller writes 00000008.BIN, and handing back a .bin would look
  // like a different file than the one that was opened.
  it('keeps the original extension when the reader recognises it', () => {
    expect(windowFilename('00000008.BIN', 'bin', 0, 10, original)).toBe('00000008_0.0-10.0s.BIN');
    expect(windowFilename('flight.log', 'bin', 0, 10, original)).toBe('flight_0.0-10.0s.log');
  });

  // parse.ts falls back to a content sniff precisely because a name can lie.
  it('falls back to the kind the parser settled on for an unrecognised extension', () => {
    expect(windowFilename('capture.dat', 'tlog', 0, 10, original)).toBe('capture_0.0-10.0s.tlog');
    expect(windowFilename('capture.dat', 'bin', 0, 10, original)).toBe('capture_0.0-10.0s.bin');
  });

  it('names a JSON export by its format, not the log\'s', () => {
    expect(windowFilename('00000008.BIN', 'bin', 1, 2, { format: 'json' })).toBe('00000008_1.0-2.0s.json');
    expect(windowFilename('00000008.BIN', 'bin', 1, 2, { format: 'json', gzip: true })).toBe(
      '00000008_1.0-2.0s.json.gz',
    );
  });

  // `a.download` is a hint the browser sanitizes too, differently per platform,
  // so doing it here is what keeps the name predictable.
  it('replaces anything a filesystem could misread', () => {
    // A directory part is dropped rather than flattened into the name.
    expect(windowFilename('logs/sub\\00000008.BIN', 'bin', 0, 1, original)).toBe('00000008_0.0-1.0s.BIN');
    expect(windowFilename('a:b*c?.tlog', 'tlog', 0, 1, original)).toBe('a_b_c_0.0-1.0s.tlog');
    expect(windowFilename('.hidden.tlog', 'tlog', 0, 1, original)).toBe('hidden_0.0-1.0s.tlog');
    expect(windowFilename('with\u0001control.tlog', 'tlog', 0, 1, original)).toBe(
      'with_control_0.0-1.0s.tlog',
    );
  });

  it('truncates an over-long name', () => {
    const name = windowFilename(`${'x'.repeat(400)}.tlog`, 'tlog', 0, 1, original);
    expect(name.length).toBeLessThan(130);
    expect(name.endsWith('_0.0-1.0s.tlog')).toBe(true);
  });

  it('falls back to a usable stem when there is nothing to work with', () => {
    expect(windowFilename('', 'tlog', 0, 1, original)).toBe('log_0.0-1.0s.tlog');
    expect(windowFilename('.tlog', 'tlog', 0, 1, original)).toBe('tlog_0.0-1.0s.tlog');
  });
});
