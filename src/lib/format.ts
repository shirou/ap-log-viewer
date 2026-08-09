// Number and elapsed-time formatting shared by the readouts, the plot axes and
// the analysis tables, so a missing value looks the same everywhere instead of
// surfacing as "NaN" in one table and "-" in the next.

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

/**
 * A byte count for a file the reader is about to receive.
 *
 * Decimal units, not binary: this labels something their file manager will report
 * next, and those count in decimal. One decimal place from kB up, because the
 * number is never more precise than what it describes.
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0 ? '-' : '';
  let v = Math.abs(n);
  if (v < 1000) return `${neg}${v.toFixed(0)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let i = -1;
  // Step while the value still reads as at least 1000 of the current unit, so
  // 999_999 becomes "1.0 MB" rather than "1000.0 kB".
  do {
    v /= 1000;
    i++;
  } while (v >= 999.95 && i < units.length - 1);
  return `${neg}${v.toFixed(1)} ${units[i]}`;
}

/**
 * Elapsed seconds as a clock reading: `m:ss` up to an hour, `h:mm:ss` beyond it.
 *
 * Raw seconds are unreadable once a flight runs long — "2537s" has to be divided
 * in the reader's head before it means anything, and every axis tick costs that
 * same division.
 *
 * `decimals` adds fractional seconds. `withHours` forces the long form: a row of
 * axis ticks has to keep one shape, so an axis reaching past an hour asks for it
 * on every tick rather than letting the first few render two fields and the rest
 * three.
 */
export function formatElapsed(sec: number, decimals = 0, withHours = false): string {
  if (!Number.isFinite(sec)) return '—';
  // Round to the printed precision *before* splitting into fields. Splitting
  // first lets the seconds round up to 60 without carrying into the minute.
  const scale = 10 ** decimals;
  const total = Math.round(Math.abs(sec) * scale) / scale;
  // The sign comes off what will be *printed*, not off the input: a value that
  // rounds away to nothing is zero, and "-0:00" claims a direction it does not
  // have. An axis tick a hair below the origin is the way that arises.
  const neg = sec < 0 && total > 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total - h * 3600) / 60);
  const s = total - h * 3600 - m * 60;
  // toFixed gives "5.0"; pad to "05.0" so the seconds field is always two digits.
  const ss = s.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  const sign = neg ? '-' : '';
  return withHours || h > 0
    ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}`
    : `${sign}${m}:${ss}`;
}

/**
 * uPlot x-axis tick labels for an axis measured in seconds since log start.
 *
 * `incr` is the tick spacing uPlot settled on, which is what decides how many
 * decimal places a label needs — zoomed in far enough the ticks are fractions of
 * a second, and rounding them all to whole ones would print the same label
 * several times over.
 *
 * The hour field is decided once for the whole axis from its largest tick rather
 * than per tick: a row that switched from `59:00` to `1:00:00` halfway along
 * changes what its first field means mid-axis, which is exactly the misreading
 * clock labels exist to prevent.
 */
export function elapsedTicks(vals: number[], incr: number): string[] {
  // A spacing that is missing or nonsensical falls back to whole seconds rather
  // than to the finest precision, which is what a bare `incr >= 1` test would do
  // with an undefined and would print `0:20.00` across an hour-long axis.
  const decimals = !(incr > 0) || incr >= 1 ? 0 : incr >= 0.1 ? 1 : 2;
  const withHours = vals.some((v) => Math.abs(v) >= 3600);
  return vals.map((v) => formatElapsed(v, decimals, withHours));
}
