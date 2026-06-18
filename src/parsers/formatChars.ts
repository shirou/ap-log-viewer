// ArduPilot DataFlash format characters.
// Reference: libraries/AP_Logger/LogStructure.h (format string in FMT messages).
// All DataFlash values are little-endian.

export interface FormatType {
  /** Size in bytes of this field. */
  size: number;
  /** Whether the decoded value is numeric or a string. */
  kind: 'number' | 'string';
  /** Decode the value at `offset` within `view`. */
  read(view: DataView, offset: number): number | string;
}

function str(view: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export const FORMAT_TYPES: Record<string, FormatType> = {
  a: { size: 64, kind: 'string', read: (v, o) => {
    // int16_t[32]
    const out: number[] = [];
    for (let i = 0; i < 32; i++) out.push(v.getInt16(o + i * 2, true));
    return out.join(' ');
  } },
  b: { size: 1, kind: 'number', read: (v, o) => v.getInt8(o) },
  B: { size: 1, kind: 'number', read: (v, o) => v.getUint8(o) },
  h: { size: 2, kind: 'number', read: (v, o) => v.getInt16(o, true) },
  H: { size: 2, kind: 'number', read: (v, o) => v.getUint16(o, true) },
  i: { size: 4, kind: 'number', read: (v, o) => v.getInt32(o, true) },
  I: { size: 4, kind: 'number', read: (v, o) => v.getUint32(o, true) },
  f: { size: 4, kind: 'number', read: (v, o) => v.getFloat32(o, true) },
  d: { size: 8, kind: 'number', read: (v, o) => v.getFloat64(o, true) },
  n: { size: 4, kind: 'string', read: (v, o) => str(v, o, 4) },
  N: { size: 16, kind: 'string', read: (v, o) => str(v, o, 16) },
  Z: { size: 64, kind: 'string', read: (v, o) => str(v, o, 64) },
  c: { size: 2, kind: 'number', read: (v, o) => v.getInt16(o, true) * 0.01 },
  C: { size: 2, kind: 'number', read: (v, o) => v.getUint16(o, true) * 0.01 },
  e: { size: 4, kind: 'number', read: (v, o) => v.getInt32(o, true) * 0.01 },
  E: { size: 4, kind: 'number', read: (v, o) => v.getUint32(o, true) * 0.01 },
  L: { size: 4, kind: 'number', read: (v, o) => v.getInt32(o, true) * 1e-7 }, // lat/lon
  M: { size: 1, kind: 'number', read: (v, o) => v.getUint8(o) }, // flight mode
  q: { size: 8, kind: 'number', read: (v, o) => Number(v.getBigInt64(o, true)) },
  Q: { size: 8, kind: 'number', read: (v, o) => Number(v.getBigUint64(o, true)) },
};

/** Total byte size of a message body given its format string. */
export function formatSize(format: string): number {
  let size = 0;
  for (const ch of format) {
    const t = FORMAT_TYPES[ch];
    if (!t) throw new Error(`Unknown DataFlash format char: '${ch}'`);
    size += t.size;
  }
  return size;
}
