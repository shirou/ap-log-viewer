// Web Worker: parses an uploaded log off the main thread and streams progress,
// and cuts a window back out of one when asked.
//
// The main thread posts a `File`; we wrap it in a LocalFileSource here so the
// parsers only ever see the LogSource interface. Transferable typed arrays in
// the result give a near-zero-copy handoff back to the UI.
//
// Both jobs live in one worker module on purpose. Vite builds each worker entry
// independently and shares no chunks between them, so a second entry importing
// the same parsers would ship another copy of them and of mavlink-mappings —
// measured at ~650 KB. The two jobs run in separate *instances* of this module,
// so a slice cannot be held up behind a parse.

import type { ParseMessage, SliceMessage, WorkerRequest } from '../model/log.ts';
import { LocalFileSource } from './source.ts';
import { parseLog } from './parse.ts';
import { parseDataflash } from './dataflash.ts';
import { parseTlog } from './tlog.ts';
import {
  MAX_SLICE_BYTES,
  checkSlice,
  inspectSlice,
  isEmptyWindow,
  readSliceBytes,
  scanForSlice,
  sliceStats,
  sliceTooLarge,
  type SliceMode,
} from '../export/slice.ts';
import { fmtBytes } from '../lib/format.ts';
import { jsonBlob } from '../export/jsonWindow.ts';

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.op === 'slice') return runSlice(req);
  return runParse(req.file);
};

async function runParse(file: File) {
  const post = (m: ParseMessage, transfer: Transferable[] = []) => self.postMessage(m, transfer);
  try {
    const source = new LocalFileSource(file);
    const parsed = await parseLog(source, {
      onProgress: (ratio) => post({ type: 'progress', phase: 'parsing', ratio }),
    });

    // Collect typed-array buffers to transfer ownership (avoids a structured clone).
    // Every source's columns go across; the main thread chooses between them
    // without re-reading the file. Deduplicating by buffer matters more now
    // than it did: sources with no position share one empty trajectory.
    const transfer: Transferable[] = [];
    const seen = new Set<ArrayBufferLike>();
    const add = (a: Float64Array) => {
      if (!seen.has(a.buffer)) {
        seen.add(a.buffer);
        transfer.push(a.buffer as ArrayBuffer);
      }
    };
    for (const data of parsed.bySource.values()) {
      for (const m of Object.values(data.messages)) {
        add(m.time);
        for (const f of Object.values(m.fields)) add(f);
      }
      add(data.trajectory.time);
      add(data.trajectory.lat);
      add(data.trajectory.lon);
      add(data.trajectory.alt);
      add(data.trajectory.heading);
    }

    post({ type: 'done', parsed }, transfer);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

async function runSlice(req: Extract<WorkerRequest, { op: 'slice' }>) {
  const post = (m: SliceMessage) => self.postMessage(m);
  const fail = (message: string) => post({ type: 'sliceError', message });
  try {
    const source = new LocalFileSource(req.file);
    const mode: SliceMode = req.format === 'original' ? 'original' : 'data';

    post({ type: 'sliceProgress', phase: 'scanning', ratio: 0 });
    const scan = await scanForSlice(source, req.kind, req.window, {
      onProgress: (ratio) => post({ type: 'sliceProgress', phase: 'scanning', ratio }),
    });

    // Before anything expensive: a window that falls between samples produces a
    // preamble and nothing else. On a .bin that is still seven or eight message
    // types and a thousand-odd rows, and its start time is the window start by
    // construction, so nothing downstream would notice.
    if (isEmptyWindow(scan)) {
      return fail('No records fall inside this window — nothing to download.');
    }

    // Refuse before allocating rather than after. Assembling a slice costs a
    // multiple of its own size, and a worker killed for running out of memory
    // takes the tab — and the log the reader had open — with it, often without
    // firing an error anyone can catch.
    const tooLarge = sliceTooLarge(scan, mode);
    if (tooLarge != null) {
      return fail(
        `This window comes to ${fmtBytes(tooLarge)}, past the ${fmtBytes(MAX_SLICE_BYTES)} a single ` +
          'file can be assembled from here. Zoom further in and try again.',
      );
    }

    // Materialize once. Handing over a lazy Blob would make the browser read the
    // file a second time at save, and a log moved or rewritten in between fails
    // that read silently, after this code has already said the slice checked out.
    const bytes = await readSliceBytes(source, scan, mode);

    post({ type: 'sliceProgress', phase: 'verifying' });
    // One Blob, used to verify and — for the original format — to hand over. A
    // second `new Blob([bytes])` would copy the whole slice again, so a window
    // covering most of a large log would hold three copies at once instead of two.
    const sliceBlob = new Blob([bytes]);
    const verifySource = new LocalFileSource(sliceBlob, req.file.name);
    const got = await inspectSlice(verifySource, req.kind);
    const mismatch = checkSlice(scan, got, req.window, mode);
    if (mismatch) return fail(`The slice did not check out: ${mismatch.reason}`);

    const stats = sliceStats(scan, got, mode, bytes.byteLength);

    if (req.format === 'original') {
      return post({ type: 'sliceDone', blob: sliceBlob, stats });
    }

    // JSON is built from the same verified bytes, so the two formats can never
    // disagree about which records the window held.
    // Still dispatched on `req.kind` rather than through `parseLog`: that would
    // re-derive the kind from the slice's name, and `detectKind` reads `.log`
    // as a .bin. The kind the rows on screen came from is the one to use.
    post({ type: 'sliceProgress', phase: 'writing' });
    const parsedSlice =
      req.kind === 'bin' ? await parseDataflash(verifySource) : await parseTlog(verifySource);
    const blob = await jsonBlob(parsedSlice, { fileName: req.file.name, window: req.window }, req.gzip);
    post({ type: 'sliceDone', blob, stats: { ...stats, bytes: blob.size } });
  } catch (err) {
    // A stale File handle is the realistic one: the log was moved, deleted or
    // rewritten since it was opened.
    fail(err instanceof Error ? err.message : String(err));
  }
}
