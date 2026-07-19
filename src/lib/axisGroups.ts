// Deciding which plotted series share a y axis.
//
// Selected fields often have wildly different ranges (GPS.Alt ~500 next to
// ATT.Roll ±30), and on one shared axis the smaller one renders as a flat line.
// uPlot gives us a second axis; the job here is to use it only when it earns
// its keep, so series that do sit comfortably together are left alone.

import uPlot from 'uplot';

/** Which y scale a plotted column is drawn against. 0 = left ('y'), 1 = right ('y2'). */
export type AxisSide = 0 | 1;

export interface AxisAssignment {
  /** One entry per input column, in the same order. */
  side: AxisSide[];
  /** True when at least one column ended up on the right axis. */
  split: boolean;
}

/** A plotted column: Float64Array (fast path, gaps are NaN) or (number|null)[] (union path). */
export type Col = ArrayLike<number | null | undefined>;

export interface Extent {
  lo: number;
  hi: number;
}

/**
 * Smallest share of the axis a series may occupy before it counts as crushed.
 *
 * uPlot reserves 50px of the plot's height for the x axis, so on a 240px panel
 * a series sitting exactly at this threshold still travels ~24px — thin, but
 * enough to read its shape. Raising it to 1/4 would separate ATT.Roll (±30)
 * from ATT.Pitch (±5), which share a message and a unit and plainly belong on
 * one axis. This is the only tuning knob in the file.
 */
const MIN_FRACTION = 1 / 8;

/** Above this many series, 2^(n-1) partitions is too many; fall back to cuts. */
const MAX_EXHAUSTIVE = 12;

const mid = (e: Extent) => (e.lo + e.hi) / 2;

/** True min/max over the finite samples, or null when the column has none. */
export function extentOf(col: Col): Extent | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < col.length; i++) {
    const v = col[i];
    // Rejects the union path's nulls and the fast path's NaN gaps alike.
    if (v == null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? { lo, hi } : null;
}

/**
 * Each series' share of the axis the group would be drawn on, unsorted.
 *
 * The denominator is uPlot's own range for the group rather than the raw union
 * of the extents: the default y range pads by 10% a side, snaps to nice numbers
 * and snaps single-signed data to a zero baseline, which inflates the span by
 * 1.10-1.39x. Measuring against the raw union would call series readable that
 * actually render crushed — the exact mismatch this module exists to avoid.
 *
 * Constant series are left out. They are flat on any axis, so no axis can crush
 * them, but they still widen the union (a constant 520 crushes everything else),
 * which is why they are dropped here and not by the caller.
 */
function fractions(exts: Extent[]): number[] {
  if (exts.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of exts) {
    if (e.lo < lo) lo = e.lo;
    if (e.hi > hi) hi = e.hi;
  }
  // MinMax is nullable because the type covers custom range functions too;
  // rangeNum itself always answers with numbers for finite input.
  const [rLo, rHi] = uPlot.rangeNum(lo, hi, 0.1, true);
  const denom = rLo != null && rHi != null ? rHi - rLo : hi - lo;
  const out: number[] = [];
  for (const e of exts) {
    if (e.hi <= e.lo) continue;
    out.push(denom > 0 ? (e.hi - e.lo) / denom : Infinity);
  }
  return out;
}

/**
 * Share of the axis taken by the least visible series in `exts`.
 *
 * Infinity when nothing here can be crushed — an empty group, or one holding
 * only constants. Note that `reduce(Math.min, 0)` would give 0 instead and
 * report a group of flat lines as maximally crushed.
 */
export function minFraction(exts: Extent[]): number {
  let m = Infinity;
  for (const f of fractions(exts)) if (f < m) m = f;
  return m;
}

/** Per rankable series: 0 = left, 1 = right. */
type Part = Uint8Array;

/**
 * Every series' share of its own axis under `p`, ascending.
 *
 * Compared lexicographically, so the primary objective is "make the most
 * crushed series as visible as possible" and ties fall through to the next most
 * crushed. A bare minimum would not do: it sees only one series, so genuinely
 * different partitions score identically (A[0,10] B[0,100] C[0,100] D[0,1000]
 * has three cuts at 0.1) and the winner would come down to whether the scan was
 * written with `>` or `>=`.
 */
function profile(exts: Extent[], p: Part): number[] {
  const l: Extent[] = [];
  const r: Extent[] = [];
  for (let i = 0; i < exts.length; i++) (p[i] ? r : l).push(exts[i]);
  return [...fractions(l), ...fractions(r)].sort((a, b) => a - b);
}

// Both profiles hold one entry per non-constant series, a count no partition
// changes, so the lengths always match and a single loop bound is enough.
function lexGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * The two-way split that leaves the least visible series as visible as possible.
 *
 * Every partition is tried, not just cuts through a sorted order. Sorting by
 * magnitude or midpoint and cutting once can only reach n-1 of the 2^(n-1)-1
 * partitions, and the ones it misses are not exotic: it can never isolate the
 * series whose midpoint sits in the middle. That is the shape of a Des/actual
 * pair around a smaller centred signal, which ArduPilot logs are full of —
 * ATT.DesRoll [-45,40] + IMU.GyrX [-0.4,0.5] + ATT.Roll [-40,45] scores 0.009
 * under adjacent cuts (GyrX flat) against 0.787 for the reachable-only-by-
 * enumeration {DesRoll, Roll} | {GyrX}.
 */
function bestPartition(exts: Extent[]): Part {
  const n = exts.length;
  let best: Part | null = null;
  let bestProfile: number[] | null = null;

  const consider = (p: Part) => {
    // A partition and its complement are the same grouping, so normalise the
    // first series onto the left. Only the fallback below can hand us the other
    // representative; the exhaustive loop never sets bit 0.
    if (p[0] === 1) for (let i = 0; i < n; i++) p[i] = p[i] ? 0 : 1;
    if (!p.some((s) => s === 1)) return;
    const prof = profile(exts, p);
    if (bestProfile === null || lexGreater(prof, bestProfile)) {
      bestProfile = prof;
      best = p;
    }
  };

  if (n <= MAX_EXHAUSTIVE) {
    // Even masks only: bit 0 clear is exactly one representative per partition.
    for (let mask = 2; mask < (1 << n) - 1; mask += 2) {
      const p = new Uint8Array(n);
      for (let i = 0; i < n; i++) p[i] = (mask >> i) & 1;
      consider(p);
    }
  } else {
    // Enumeration would run away here, so settle for adjacent cuts in midpoint
    // order — the best cheap approximation, with the blind spot described above.
    const order = [...exts.keys()].sort((a, b) => mid(exts[a]) - mid(exts[b]) || a - b);
    for (let k = 1; k < n; k++) {
      const p = new Uint8Array(n);
      for (let j = k; j < n; j++) p[order[j]] = 1;
      consider(p);
    }
  }

  return best ?? new Uint8Array(n);
}

/**
 * Split series across a left and a right y axis, or leave them all on the left.
 *
 * Takes extents rather than columns so the caller can scan the columns once and
 * re-run this cheaply — the assignment changes with every manual override, but
 * the data behind it does not. A null extent is a series with no finite sample.
 *
 * `overrides` is parallel to `exts`; a defined entry pins that series to a side
 * and is applied last, so a manual choice survives whatever the automatic pass
 * decided — including the case where it decided not to split at all.
 *
 * Note that group membership is recomputed from scratch every call, so adding a
 * series can move an existing one across (Pitch|Roll becomes Pitch,Roll|RCOU
 * once RCOU joins). That is inherent — the best split of a different set is a
 * different split — and `overrides` is the way out when it is not what you want.
 */
export function assignAxes(
  exts: ReadonlyArray<Extent | null>,
  overrides?: ReadonlyArray<AxisSide | undefined>,
): AxisAssignment {
  const side: AxisSide[] = new Array(exts.length).fill(0);

  // Series with no finite sample cannot be ranked, and stay on the left.
  const rankable: number[] = [];
  for (let i = 0; i < exts.length; i++) if (exts[i]) rankable.push(i);

  if (rankable.length >= 2) {
    const e = rankable.map((i) => exts[i] as Extent);
    // Everything already visible on one axis: this is "same range, one axis".
    if (minFraction(e) < MIN_FRACTION) {
      const p = bestPartition(e);
      for (let k = 0; k < rankable.length; k++) side[rankable[k]] = p[k] ? 1 : 0;
    }
  }

  if (overrides) {
    for (let i = 0; i < side.length; i++) {
      const o = overrides[i];
      if (o != null) side[i] = o;
    }
  }

  return { side, split: side.some((s) => s === 1) };
}
