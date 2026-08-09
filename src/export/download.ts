// The only place in the app that touches the DOM to hand a file to the reader.
//
// Kept in a file of its own so the builders next to it stay pure: vitest runs in
// node here, where there is no document to click an anchor in, so this function is
// the one part of the export path that has no unit test.

/**
 * How long to leave the blob: URL alive after the click.
 *
 * There is no event for "the download has taken hold". Revoking in the same task
 * has been seen to cancel the fetch the click started, and a few hundred
 * megabytes is not instantaneous — but never revoking pins the whole blob for the
 * life of the document, and these run to hundreds of megabytes.
 */
const REVOKE_DELAY_MS = 60_000;

/** Hand `blob` to the browser as a download named `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox will not act on a click for an anchor that is not in the document.
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Whichever comes first: the timer, or leaving the page — which ends any
  // download that has not started, so there is nothing left to keep alive for.
  // The listener takes itself off once revoked, since `once` only fires on the
  // event and a page that never unloads would otherwise collect one per download.
  const revoke = () => {
    URL.revokeObjectURL(url);
    clearTimeout(timer);
    window.removeEventListener('pagehide', revoke);
  };
  const timer = setTimeout(revoke, REVOKE_DELAY_MS);
  window.addEventListener('pagehide', revoke, { once: true });
}
