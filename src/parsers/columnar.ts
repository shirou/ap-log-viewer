// Shared columnar accumulation used by both the DataFlash and tlog parsers.
//
// Numeric columns are stored in growable Float64Arrays rather than number[].
// This both halves steady-state memory and — crucially for multi-GB logs —
// avoids the finalize-time spike where every column was duplicated by
// `Float64Array.from(number[])` while the source array was still alive.

import type { MessageSeries, Trajectory } from '../model/log.ts';
import { searchSortedLE } from '../lib/series.ts';

export type ColKind = 'number' | 'string';
export interface ColumnDef {
  label: string;
  kind: ColKind;
}

const EMPTY_F64 = new Float64Array(0);

/** Append-only Float64 column that doubles capacity as needed. */
class GrowableF64 {
  private buf: Float64Array;
  length = 0;
  constructor(cap = 256) {
    this.buf = new Float64Array(cap);
  }
  push(v: number): void {
    if (this.length === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  view(): Float64Array {
    return this.buf.subarray(0, this.length);
  }
  /** Exact-length copy (optionally reordered), releasing the internal buffer. */
  take(order: Uint32Array | null): Float64Array {
    const n = this.length;
    const src = this.buf;
    const out = new Float64Array(n);
    if (order) for (let i = 0; i < n; i++) out[i] = src[order[i]];
    else out.set(src.subarray(0, n));
    this.buf = EMPTY_F64; // free the (possibly 2×-oversized) backing store
    this.length = 0;
    return out;
  }
}

// Returns a permutation sorting `time` ascending (stable), or null when it is
// already non-decreasing (the common case — no work, no reorder).
function sortOrder(time: Float64Array): Uint32Array | null {
  for (let i = 1; i < time.length; i++) {
    if (time[i] < time[i - 1]) {
      const idx = Array.from({ length: time.length }, (_, k) => k);
      idx.sort((a, b) => time[a] - time[b] || a - b);
      return Uint32Array.from(idx);
    }
  }
  return null;
}

function orderedStrings(src: string[], order: Uint32Array | null): string[] {
  if (!order) return src;
  const out = new Array<string>(order.length);
  for (let i = 0; i < order.length; i++) out[i] = src[order[i]];
  return out;
}

class SeriesBuilder {
  readonly labels: string[];
  private numeric: { label: string; col: GrowableF64 }[] = [];
  private strings: { label: string; col: string[] }[] = [];
  private time = new GrowableF64();

  constructor(readonly name: string, columns: ColumnDef[]) {
    this.labels = columns.map((c) => c.label);
    for (const c of columns) {
      if (c.kind === 'number') this.numeric.push({ label: c.label, col: new GrowableF64() });
      else this.strings.push({ label: c.label, col: [] });
    }
  }

  push(values: Record<string, unknown>, time: number): void {
    this.time.push(time);
    for (const n of this.numeric) {
      const v = values[n.label];
      n.col.push(typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN);
    }
    for (const s of this.strings) {
      const v = values[s.label];
      s.col.push(typeof v === 'string' ? v : String(v ?? ''));
    }
  }

  build(): MessageSeries {
    const order = sortOrder(this.time.view());
    const fields: Record<string, Float64Array> = {};
    for (const n of this.numeric) fields[n.label] = n.col.take(order);
    const textFields: Record<string, string[]> = {};
    let hasText = false;
    for (const s of this.strings) {
      textFields[s.label] = orderedStrings(s.col, order);
      hasText = true;
    }
    const time = this.time.take(order);
    return { name: this.name, fields, labels: this.labels, time, ...(hasText ? { textFields } : {}) };
  }
}

/** Accumulates rows per message type and produces the normalized model. Series
 * whose time column is not already ascending are sorted so consumers can rely
 * on binary search (tlog timestamps are wall-clock and can step backwards). */
export class LogBuilder {
  private series = new Map<number | string, SeriesBuilder>();

  push(key: number | string, name: string, columns: ColumnDef[], values: Record<string, unknown>, time: number): void {
    let s = this.series.get(key);
    if (!s) {
      s = new SeriesBuilder(name, columns);
      this.series.set(key, s);
    }
    s.push(values, time);
  }

  finalize(): Record<string, MessageSeries> {
    const out: Record<string, MessageSeries> = {};
    for (const s of this.series.values()) out[s.name] = s.build();
    this.series.clear();
    return out;
  }
}

export interface TrajCandidate {
  msg: string;
  lat: string;
  lon: string;
  alt?: string;
  /** Multiplier to convert raw lat/lon to degrees (1 if already degrees). */
  latScale: number;
  /** Multiplier to convert raw alt to meters (1 if already meters). */
  altScale: number;
}

/** A heading/yaw/course series to drape over the trajectory (degrees after scaling). */
export interface HeadingSource {
  msg: string;
  field: string;
  /** Multiplier to convert the raw field to degrees (e.g. 0.01 for cdeg, 180/π for rad). */
  scale: number;
  /** Raw sentinel value meaning "unknown" (e.g. 65535 for MAVLink hdg). */
  unknown?: number;
}

const EMPTY_TRAJECTORY: Trajectory = {
  time: EMPTY_F64,
  lat: EMPTY_F64,
  lon: EMPTY_F64,
  alt: EMPTY_F64,
  heading: EMPTY_F64,
};

// Heading per trajectory sample, taken from the first available source by
// nearest-earlier timestamp. NaN where no source has a (known) value.
function drapeHeading(
  messages: Record<string, MessageSeries>,
  times: Float64Array,
  sources: HeadingSource[],
): Float64Array {
  const out = new Float64Array(times.length).fill(NaN);
  for (const src of sources) {
    const s = messages[src.msg];
    const vals = s?.fields[src.field];
    if (!s || !vals || s.time.length === 0) continue;
    for (let i = 0; i < times.length; i++) {
      const idx = searchSortedLE(s.time, times[i]);
      const raw = vals[idx < 0 ? 0 : idx];
      if (src.unknown !== undefined && raw === src.unknown) continue; // leave NaN
      out[i] = raw * src.scale;
    }
    return out; // first source that exists wins
  }
  return out;
}

/** Build the flight path from the first available position message, draping
 * heading from the first available heading source. Input series are already
 * time-sorted by finalize(), so the result is time-sorted too. */
export function extractTrajectory(
  messages: Record<string, MessageSeries>,
  candidates: TrajCandidate[],
  headingSources: HeadingSource[] = [],
): Trajectory {
  for (const c of candidates) {
    const s = messages[c.msg];
    if (!s) continue;
    const lat = s.fields[c.lat];
    const lon = s.fields[c.lon];
    const alt = c.alt ? s.fields[c.alt] : undefined;
    if (!lat || !lon) continue;

    const time: number[] = [];
    const lats: number[] = [];
    const lons: number[] = [];
    const alts: number[] = [];
    for (let i = 0; i < lat.length; i++) {
      const la = lat[i] * c.latScale;
      const lo = lon[i] * c.latScale;
      if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) continue;
      time.push(s.time[i]);
      lats.push(la);
      lons.push(lo);
      alts.push(alt ? alt[i] * c.altScale : 0);
    }
    if (lats.length) {
      const trajTime = Float64Array.from(time);
      return {
        time: trajTime,
        lat: Float64Array.from(lats),
        lon: Float64Array.from(lons),
        alt: Float64Array.from(alts),
        heading: drapeHeading(messages, trajTime, headingSources),
      };
    }
  }
  return EMPTY_TRAJECTORY;
}
