// Cutting the displayed window out of the log the reader opened.
//
// Owns the worker that does it: this component is unmounted by Esc, by opening a
// different log and by reset() — App swaps PlotPanel out the moment status leaves
// 'ready' — and each of those has to end a scan that might be running over
// hundreds of megabytes.

import { useEffect, useRef, useState } from 'react';
import type { SliceMessage, SliceStats, WorkerRequest } from '../model/log.ts';
import { useLogStore } from '../store/logStore.ts';
import { fmtBytes, formatElapsed } from '../lib/format.ts';
import { quantizeWindow } from '../lib/series.ts';
import { windowFilename } from '../export/filename.ts';
import { saveBlob } from '../export/download.ts';

type Format = 'original' | 'json';

const PHASE_LABEL: Record<'scanning' | 'verifying' | 'writing', string> = {
  scanning: 'Scanning',
  verifying: 'Verifying',
  writing: 'Writing',
};

export default function DownloadModal({ range, onClose }: { range: [number, number]; onClose: () => void }) {
  const log = useLogStore((s) => s.log);
  const file = useLogStore((s) => s.file);
  const fileName = useLogStore((s) => s.fileName);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [format, setFormat] = useState<Format>('original');
  const [gzip, setGzip] = useState(false);
  const [phase, setPhase] = useState<keyof typeof PHASE_LABEL | null>(null);
  const [ratio, setRatio] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SliceStats | null>(null);

  // Shown as a true modal so Esc, the focus trap, the top layer and ::backdrop
  // all come from the platform. .plot-wrap clips its overflow, but showModal
  // promotes the dialog out of every ancestor's clip.
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    // Unmounting is a cancellation: a scan with nobody left to receive it should
    // not go on reading a file, and its result must not download over a log that
    // is no longer on screen.
    return () => workerRef.current?.terminate();
  }, []);

  if (!log) return null;

  const busy = phase !== null;
  const fromSec = (range[0] - log.startTime) / 1e6;
  const toSec = (range[1] - log.startTime) / 1e6;
  const close = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    dialogRef.current?.close();
  };

  // Unreachable today: the only way in is FileDropzone -> parseFile(File), which
  // sets `log` and `file` together. It is here for the remote sources the
  // LogSource seam anticipates (src/parsers/source.ts), where there may be no
  // local File to cut from.
  const blocked = !file
    ? 'The file this log was read from is not available in this session.'
    : null;

  // A finished run describes the format it ran for, so switching format or the
  // gzip box has to retire it — otherwise the byte count and type count on screen
  // belong to a file other than the one the controls now describe.
  const pick = (next: Format) => {
    setFormat(next);
    setDone(null);
    setError(null);
  };

  const run = () => {
    if (!file || busy) return;
    setError(null);
    setDone(null);
    setRatio(0);
    setPhase('scanning');

    const worker = new Worker(new URL('../parsers/parser.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    const finish = () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      setPhase(null);
    };
    worker.onmessage = (e: MessageEvent<SliceMessage>) => {
      const msg = e.data;
      if (msg.type === 'sliceProgress') {
        setPhase(msg.phase);
        if (msg.ratio != null) setRatio(msg.ratio);
      } else if (msg.type === 'sliceDone') {
        saveBlob(msg.blob, windowFilename(fileName ?? 'log', log.source, fromSec, toSec, { format, gzip }));
        setDone(msg.stats);
        finish();
      } else {
        setError(msg.message);
        finish();
      }
    };
    worker.onerror = (e) => {
      setError(e.message || 'worker error');
      finish();
    };
    const req: WorkerRequest = {
      op: 'slice',
      file,
      kind: log.source,
      window: quantizeWindow(range[0], range[1]),
      format,
      gzip: format === 'json' && gzip,
    };
    worker.postMessage(req);
  };

  return (
    <dialog
      ref={dialogRef}
      className="analysis-modal export-modal"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) close();
      }}
    >
      <div className="analysis-inner">
        <header className="analysis-head">
          <h2>Download window</h2>
          <span className="analysis-sub">{log.source.toUpperCase()}</span>
          <div className="spacer" />
          <button className="analysis-close" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>

        <div className="analysis-body">
          {/* The same m:ss.s the plot axis and the timeline read in: the window
              was picked by eye off that axis, so it is named back in its terms. */}
          <div className="interval-row export-range">
            <span>
              from <strong>{formatElapsed(fromSec, 1)}</strong> to <strong>{formatElapsed(toSec, 1)}</strong>
            </span>
            <span className="interval-dur">Δ {(toSec - fromSec).toFixed(1)}s</span>
            <span className="interval-dur">of {formatElapsed((log.endTime - log.startTime) / 1e6, 1)}</span>
          </div>

          {/* Radios rather than a select: which one to take is a decision about
              what the file is for, and both answers have to be readable at once
              to make it. */}
          <fieldset className="export-formats">
            <legend>Format</legend>
            <label className={`export-format${file ? '' : ' disabled'}`}>
              <input
                type="radio"
                name="export-format"
                checked={format === 'original'}
                disabled={!file || busy}
                onChange={() => pick('original')}
              />
              <span>Original .{log.source} bytes</span>
              <span className="export-why">
                A cut of the file you opened, byte for byte, so it reads back in Mission Planner, MAVExplorer or here.
                Parameters come across at the value they held when the window opened.
              </span>
            </label>
            <label className={`export-format${file ? '' : ' disabled'}`}>
              <input
                type="radio"
                name="export-format"
                checked={format === 'json'}
                disabled={!file || busy}
                onChange={() => pick('json')}
              />
              <span>JSON, one array per field</span>
              <span className="export-why">
                Every message type the window holds — including ones you are not plotting and ones dropped from memory.
                Parameters and the flight plan appear only if the log recorded them inside the window.
              </span>
            </label>
            {format === 'json' && (
              <label className="export-gzip">
                <input
                  type="checkbox"
                  checked={gzip}
                  disabled={busy}
                  onChange={(e) => {
                    setGzip(e.target.checked);
                    setDone(null);
                    setError(null);
                  }}
                />
                <span>gzip it (.json.gz — columnar numbers compress five to eight times over)</span>
              </label>
            )}
          </fieldset>

          {blocked && <p className="analysis-hint">{blocked}</p>}
          {error && <p style={{ color: 'var(--accent-2)' }}>Error: {error}</p>}
          {done && (
            <p className="export-result">
              Checked out: <strong>{done.windowRows.toLocaleString()}</strong> rows across {done.messageTypes} message
              type{done.messageTypes === 1 ? '' : 's'},{' '}
              {formatElapsed((done.startTime - log.startTime) / 1e6, 1)}–
              {formatElapsed((done.endTime - log.startTime) / 1e6, 1)}
              {done.hoistedRows > 0 && ` (plus ${done.hoistedRows.toLocaleString()} carried in)`} · {fmtBytes(done.bytes)}
            </p>
          )}

          <div className="export-actions">
            <button className="primary" disabled={busy || blocked != null} onClick={run}>
              {/* Only scanning reports a ratio; showing the last one it sent while
                  verifying or writing would pin a stale percentage to a step that
                  has no measure of its own. */}
              {busy
                ? `${PHASE_LABEL[phase]}…${phase === 'scanning' ? ` ${Math.round(ratio * 100)}%` : ''}`
                : done
                  ? 'Download again'
                  : 'Download'}
            </button>
            <button onClick={close}>{busy ? 'Stop' : 'Close'}</button>
          </div>

          <p className="analysis-hint">
            Cut here in your browser; nothing is uploaded. Times are microseconds on the log's own clock —{' '}
            {log.source === 'bin' ? 'since boot' : 'UNIX'} — and the window includes both ends.
          </p>
        </div>
      </div>
    </dialog>
  );
}
