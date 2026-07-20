// Small helpers over the columnar log model.

/** Index of the last sample whose time <= t (binary search on a sorted array). */
export function searchSortedLE(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}

/**
 * Index of the sample nearest `t`, or null when `t` falls outside the series.
 *
 * Outside means before the first sample or after the last, where the plot draws
 * no line at all — answering with the nearest end there would report a value the
 * series never held at that instant.
 *
 * Nearest, rather than the last-at-or-before that searchSortedLE gives the
 * views that replay state: this answers "what does this curve read here", where
 * the closer of the two samples the line is drawn between is the better answer,
 * and it halves the worst-case error. Playback cannot use it — a playhead must
 * not show a sample from the future — but a reader pointing at a curve can.
 *
 * The distinction only matters because an exact hit is the exception: series in
 * one plot usually come from different messages logged at different rates, so
 * insisting on `t` itself is how a reader ends up with a row that is blank
 * everywhere except on its own message's samples.
 *
 * Ties go to the earlier sample. Note that a run of samples sharing a timestamp
 * is not resolvable here — the answer is the last of the run — so a caller that
 * can address such samples by index should do that instead.
 */
export function nearestSampleIndex(times: ArrayLike<number>, t: number): number | null {
  const n = times.length;
  // The bounds test also covers the empty case, so searchSortedLE's -1 for an
  // empty array is unreachable below.
  if (n === 0 || t < times[0] || t > times[n - 1]) return null;
  const i = searchSortedLE(times, t);
  // searchSortedLE lands on or before t; the sample after it may be closer.
  return i + 1 < n && times[i + 1] - t < t - times[i] ? i + 1 : i;
}

export interface LatLngAlt {
  lat: number;
  lon: number;
  alt: number;
  /** Degrees clockwise from north, or NaN if the log has no heading. */
  heading: number;
}

/** Position (and heading) at time `t` from a trajectory, or null if empty. */
export function positionAt(
  traj: { time: Float64Array; lat: Float64Array; lon: Float64Array; alt: Float64Array; heading: Float64Array },
  t: number,
): LatLngAlt | null {
  if (traj.time.length === 0) return null;
  const i = searchSortedLE(traj.time, t);
  const idx = i < 0 ? 0 : i;
  return {
    lat: traj.lat[idx],
    lon: traj.lon[idx],
    alt: traj.alt[idx],
    heading: traj.heading.length ? traj.heading[idx] : NaN,
  };
}

/**
 * Value at pointer x along a track, snapped to `step` and clamped to the ends.
 *
 * `rect` must be the measured rect of the track element itself, so the mapping
 * needs no knowledge of how the control is drawn. Hovering, clicking and
 * dragging all call this with the same rect, which is what makes a preview and
 * the seek it turns into agree exactly rather than approximately. (A native
 * `<input type="range">` cannot offer that: its pixel-to-value mapping depends
 * on the rendered thumb width, which is not measurable from script —
 * getComputedStyle on ::-webkit-slider-thumb reports the input's own width.)
 */
export function rangeValueAtX(
  x: number,
  rect: { left: number; width: number },
  min: number,
  max: number,
  step: number,
): number {
  const ratio = Math.min(1, Math.max(0, (x - rect.left) / Math.max(1, rect.width)));
  const raw = min + ratio * (max - min);
  if (!(step > 0)) return raw;
  let v = min + Math.round((raw - min) / step) * step;
  // A step that does not divide the span leaves no multiple sitting on `max`.
  // Rounding up would then land past it, so drop to the last reachable stop —
  // which is where the native input's thumb also comes to rest.
  if (v > max) v -= step;
  return Math.min(max, Math.max(min, v));
}

export function formatDuration(microFromStart: number): string {
  // Round to the displayed precision *before* splitting into minutes and
  // seconds. Splitting first lets the seconds round up to 60 without carrying,
  // so every minute boundary flashed "0:60.0" instead of "1:00.0".
  const tenths = Math.round(Math.max(0, microFromStart) / 1e5);
  const m = Math.floor(tenths / 600);
  return `${m}:${((tenths - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
}
