// Shared dispatch: pick the parser by file extension (with a content sniff
// fallback) so the worker and tests can reuse the same logic.

import type { LogData, LogKind } from '../model/log.ts';
import type { LogSource } from './source.ts';
import { parseDataflash, type ParseOptions } from './dataflash.ts';
import { parseTlog } from './tlog.ts';
import { detectKind } from './kind.ts';

export type { LogKind };
export { detectKind };

export async function parseLog(source: LogSource, opts: ParseOptions = {}): Promise<LogData> {
  let kind = detectKind(source.name);
  if (!kind) {
    // Sniff: DataFlash messages start with 0xA3 0x95.
    const head = await source.read({ start: 0, end: 1 });
    kind = head[0] === 0xa3 ? 'bin' : 'tlog';
  }
  return kind === 'bin' ? parseDataflash(source, opts) : parseTlog(source, opts);
}
