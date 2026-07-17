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
 * Value of a horizontal `<input type="range">` at pointer x, mirroring the
 * native mapping so a hover preview and a click at the same x agree exactly:
 * the thumb's centre travels inset by half a thumb at each end, and the value
 * snaps to `step`. `thumbPx` must be the rendered thumb width — the caller
 * reads it from CSS rather than assuming a browser default.
 */
export function rangeValueAtX(
  x: number,
  rect: { left: number; width: number },
  min: number,
  max: number,
  step: number,
  thumbPx: number,
): number {
  const track = Math.max(1, rect.width - thumbPx);
  const ratio = Math.min(1, Math.max(0, (x - rect.left - thumbPx / 2) / track));
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
  const totalSec = Math.max(0, microFromStart) / 1e6;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
