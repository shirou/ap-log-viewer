// The chip in the plot header that offers the displayed window as a file.
//
// Its own component so the window it reads stays out of PlotPanel: that
// component owns the uPlot instance, and the fewer reasons it has to re-render
// the better. This also puts the whole control — chip, dialog and the worker
// behind it — in one place.

import { useState } from 'react';
import { selectExportWindow, useLogStore } from '../store/logStore.ts';
import { formatElapsed } from '../lib/format.ts';
import DownloadModal from './DownloadModal.tsx';

export default function PlotDownload() {
  const log = useLogStore((s) => s.log);
  const range = useLogStore(selectExportWindow);
  const [open, setOpen] = useState(false);
  if (!log) return null;

  const title = range
    ? `Download ${formatElapsed((range[0] - log.startTime) / 1e6, 1)}–${formatElapsed(
        (range[1] - log.startTime) / 1e6,
        1,
      )} of this log as a file`
    : // Deliberately not "this is the whole log": un-zoomed, the x range is the
      // extent of the *selected fields*, not of the file. A short-lived message
      // type leaves the plot showing a slice of the flight with nothing zoomed,
      // and claiming otherwise would be untrue.
      'The plot is showing everything the selected fields have — drag across it to pick a window, then download that';

  return (
    <>
      {/* aria-disabled, not disabled. The reason this control can do nothing is
          the only thing it has to say, and `disabled` hides that from both the
          pointer (a disabled control gets no pointer events, so no tooltip) and
          the accessibility tree (it takes no focus, so nothing announces it).
          Kept a live button, dressed as inert, and made inert in the handler.
          The chips beside it are hidden rather than disabled when they have
          nothing to offer, because there the reason is a fact about the log — a
          .bin carries no commands — and the reader cannot act on it. Here they
          can. */}
      <button
        className="chip"
        aria-disabled={range == null}
        title={title}
        onClick={() => range && setOpen(true)}
      >
        ⤓ Download window
      </button>
      {open && range && <DownloadModal range={range} onClose={() => setOpen(false)} />}
    </>
  );
}
