// Shared dispatch: pick the parser by file extension (with a content sniff
// fallback) so the worker and tests can reuse the same logic.

import type { LogData } from '../model/log.ts';
import type { LogSource } from './source.ts';
import { parseDataflash, type ParseOptions } from './dataflash.ts';
import { parseTlog } from './tlog.ts';

export type LogKind = 'bin' | 'tlog';

export function detectKind(name: string): LogKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.bin') || lower.endsWith('.log')) return 'bin';
  if (lower.endsWith('.tlog')) return 'tlog';
  return null;
}

export async function parseLog(source: LogSource, opts: ParseOptions = {}): Promise<LogData> {
  let kind = detectKind(source.name);
  if (!kind) {
    // Sniff: DataFlash messages start with 0xA3 0x95.
    const head = await source.read({ start: 0, end: 1 });
    kind = head[0] === 0xa3 ? 'bin' : 'tlog';
  }
  return kind === 'bin' ? parseDataflash(source, opts) : parseTlog(source, opts);
}
