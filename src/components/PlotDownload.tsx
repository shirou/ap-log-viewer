// The control that offers the displayed time-series window as a file.
//
// Sits in the app header with the other actions on the whole log rather than
// beside the plot it describes. That it can at all is the point of keeping the
// window in the store: it is state, not something PlotPanel hands down — which is
// also why reading it here costs the component that owns the uPlot instance
// nothing.

import { useState } from 'react';
import { selectExportWindow, useLogStore } from '../store/logStore.ts';
import { formatElapsed } from '../lib/format.ts';
import DownloadModal from './DownloadModal.tsx';

export default function PlotDownload() {
  const log = useLogStore((s) => s.log);
  // A count, not the array: this only needs to know whether anything is plotted,
  // and a number keeps the snapshot comparison stable.
  const plotted = useLogStore((s) => s.selectedFields.length);
  const range = useLogStore(selectExportWindow);
  const [open, setOpen] = useState(false);
  if (!log) return null;

  const title = range
    ? `Download ${formatElapsed((range[0] - log.startTime) / 1e6, 1)}–${formatElapsed(
        (range[1] - log.startTime) / 1e6,
        1,
      )} of this log as a file`
    : plotted === 0
      ? // The plot is not merely un-zoomed, it is not there. Pointing at it would
        // send the reader looking for something that is not on screen.
        'Nothing is plotted yet — select series from the Fields tab, then zoom into a window to download it'
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
          It also stays put rather than vanishing when there is no window: this is
          a toolbar, and a button that comes and goes is harder to find again than
          one that is greyed out. */}
      <button
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
