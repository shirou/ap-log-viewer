// Web Worker: parses an uploaded log off the main thread and streams progress.
// The main thread posts a `File`; we wrap it in a LocalFileSource here so the
// parsers only ever see the LogSource interface. Transferable typed arrays in
// the result give a near-zero-copy handoff back to the UI.

import type { ParseMessage } from '../model/log.ts';
import { LocalFileSource } from './source.ts';
import { parseLog } from './parse.ts';

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const post = (m: ParseMessage, transfer: Transferable[] = []) => self.postMessage(m, transfer);
  try {
    const source = new LocalFileSource(e.data.file);
    const log = await parseLog(source, {
      onProgress: (ratio) => post({ type: 'progress', phase: 'parsing', ratio }),
    });

    // Collect typed-array buffers to transfer ownership (avoids a structured clone).
    const transfer: Transferable[] = [];
    const seen = new Set<ArrayBufferLike>();
    const add = (a: Float64Array) => {
      if (!seen.has(a.buffer)) {
        seen.add(a.buffer);
        transfer.push(a.buffer as ArrayBuffer);
      }
    };
    for (const m of Object.values(log.messages)) {
      add(m.time);
      for (const f of Object.values(m.fields)) add(f);
    }
    add(log.trajectory.time);
    add(log.trajectory.lat);
    add(log.trajectory.lon);
    add(log.trajectory.alt);
    add(log.trajectory.heading);

    post({ type: 'done', log }, transfer);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
