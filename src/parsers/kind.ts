// Which reader a file name suggests.
//
// Apart from parse.ts so that naming a slice — which is all the download UI needs
// — does not pull in the parsers themselves, and with them the MAVLink dialect
// tables that make up most of the worker bundle.

import type { LogKind } from '../model/log.ts';

export function detectKind(name: string): LogKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.bin') || lower.endsWith('.log')) return 'bin';
  if (lower.endsWith('.tlog')) return 'tlog';
  return null;
}
