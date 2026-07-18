import { describe, expect, it } from 'vitest';
import { rangeValueAtX } from './series.ts';

// The rect is the track element itself, so the value spans it edge to edge.
const RECT = { left: 100, width: 600 };
const at = (x: number, step = 0) => rangeValueAtX(x, RECT, 0, 1000, step);

describe('rangeValueAtX', () => {
  it('maps the measured track edge to edge', () => {
    expect(at(100)).toBe(0);
    expect(at(400)).toBe(500);
    expect(at(700)).toBe(1000);
  });

  it('clamps outside the track instead of extrapolating', () => {
    expect(at(RECT.left)).toBe(0);
    expect(at(-5000)).toBe(0);
    expect(at(RECT.left + RECT.width)).toBe(1000);
    expect(at(5000)).toBe(1000);
  });

  it('snaps to step, matching what a click would commit', () => {
    expect(at(340, 250)).toBe(500); // raw 400 -> nearest 250 multiple
    expect(at(280, 250)).toBe(250); // raw 300 -> rounds down
  });

  it('stops at the last reachable step when one does not land on max', () => {
    // Stops are 0/300/600/900: the far right rests on 900, not 1000.
    expect(at(700, 300)).toBe(900);
    expect(at(100, 300)).toBe(0);
    // Stops are 0/400/800. Rounding 1000 up would give 1200; clamping that to
    // max would report 1000 — a value the input can never hold.
    expect(at(700, 400)).toBe(800);
  });

  it('does not divide by zero on a collapsed input', () => {
    expect(Number.isFinite(rangeValueAtX(50, { left: 0, width: 0 }, 0, 1000, 1))).toBe(true);
  });

  it('leaves the value unsnapped when step is not positive', () => {
    expect(at(400, 0)).toBe(500);
  });
});
