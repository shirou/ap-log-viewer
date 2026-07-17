import { describe, expect, it } from 'vitest';
import { rangeValueAtX } from './series.ts';

// A 616px-wide input with a 16px thumb leaves exactly 600px of thumb travel,
// starting 8px in from the left edge of the box.
const RECT = { left: 100, width: 616 };
const THUMB = 16;
const at = (x: number, step = 0) => rangeValueAtX(x, RECT, 0, 1000, step, THUMB);

describe('rangeValueAtX', () => {
  it('maps the thumb-centre travel rather than the raw box', () => {
    expect(at(108)).toBe(0); // half a thumb in from the left
    expect(at(408)).toBe(500); // centre
    expect(at(708)).toBe(1000); // half a thumb in from the right
  });

  it('clamps outside the track instead of extrapolating', () => {
    expect(at(RECT.left)).toBe(0);
    expect(at(-5000)).toBe(0);
    expect(at(RECT.left + RECT.width)).toBe(1000);
    expect(at(5000)).toBe(1000);
  });

  it('snaps to step, matching what a click would commit', () => {
    expect(at(348, 250)).toBe(500); // raw 400 -> nearest 250 multiple
    expect(at(288, 250)).toBe(250); // raw 300 -> rounds down
  });

  it('stops at the last reachable step when one does not land on max', () => {
    // Stops are 0/300/600/900: the far right rests on 900, not 1000.
    expect(at(708, 300)).toBe(900);
    expect(at(108, 300)).toBe(0);
    // Stops are 0/400/800. Rounding 1000 up would give 1200; clamping that to
    // max would report 1000 — a value the input can never hold.
    expect(at(708, 400)).toBe(800);
  });

  it('does not divide by zero on a collapsed input', () => {
    expect(Number.isFinite(rangeValueAtX(50, { left: 0, width: 0 }, 0, 1000, 1, THUMB))).toBe(true);
  });

  it('leaves the value unsnapped when step is not positive', () => {
    expect(at(408, 0)).toBe(500);
  });
});
