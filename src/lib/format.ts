// Number formatting shared by the analysis readouts, so a missing value looks
// the same everywhere instead of surfacing as "NaN" in one table and "-" in the
// next.

/** Fixed-digit number; an em dash when the value is not finite. */
export function fmtNum(v: number, digits = 0): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

/**
 * Compact number for a dense table: whole and large values plain, the rest to
 * four significant digits so columns of differing magnitude still line up.
 */
export function fmtAuto(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000 || Number.isInteger(v)) return v.toFixed(0);
  return v.toPrecision(4);
}

/** A ratio rendered as a percentage. */
export function fmtPct(ratio: number, digits = 1): string {
  return Number.isFinite(ratio) ? (ratio * 100).toFixed(digits) : '—';
}
