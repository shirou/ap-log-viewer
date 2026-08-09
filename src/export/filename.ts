// Naming a downloaded slice.
//
// Kept apart from the builders and from the DOM so it stays a pure function: the
// rules below are fiddly enough to be worth testing, and none of them need a
// browser.

import type { LogKind } from '../model/log.ts';
import { detectKind } from '../parsers/kind.ts';

/**
 * Longest stem handed to a browser.
 *
 * Well inside every filesystem's limit, with room for the window suffix and the
 * extension.
 */
const MAX_STEM = 96;

/**
 * Replace anything a filesystem or a Content-Disposition header could misread.
 *
 * The stem comes from a file the reader chose, so it can hold a path separator, a
 * colon, a control character or a leading dot. `a.download` is only a hint — the
 * browser sanitizes it too, differently per platform, and would silently rename
 * the file — so doing it here is what keeps the name predictable.
 */
function sanitize(stem: string): string {
  const clean = stem
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, MAX_STEM)
    // Trailing separators would double up against the window suffix, and a
    // truncation can land on one.
    .replace(/[._-]+$/, '');
  return clean.length ? clean : 'log';
}

/** Split `00000008.BIN` into `["00000008", ".BIN"]`; no extension gives `""`. */
function splitExtension(name: string): [string, string] {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  // A leading dot is part of the name, not an extension separator.
  return dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
}

export interface SliceNameOptions {
  format: 'original' | 'json';
  gzip?: boolean;
}

/**
 * A name for the downloaded window, from the log's own file name and the window.
 *
 * The seconds are the ones on screen — the plot's x axis and the timeline both
 * measure from the start of the log — so the file names itself in the terms the
 * window was picked in. Written as plain seconds rather than `m:ss` because a
 * colon is not a legal filename character on Windows.
 *
 * The extension is the original one whenever `detectKind` recognises it, so a
 * `.BIN` stays a `.BIN` and a `.log` stays a `.log`. Otherwise it is the
 * canonical one for the kind the *parser* settled on, since the content sniff in
 * parse.ts means the name can disagree with the bytes.
 */
export function windowFilename(
  sourceName: string,
  kind: LogKind,
  fromSec: number,
  toSec: number,
  opts: SliceNameOptions,
): string {
  const [rawStem, rawExt] = splitExtension(sourceName || 'log');
  const stem = sanitize(rawStem);
  const span = `${fromSec.toFixed(1)}-${toSec.toFixed(1)}s`;
  if (opts.format === 'json') return `${stem}_${span}.json${opts.gzip ? '.gz' : ''}`;
  const ext = detectKind(rawExt) ? rawExt : kind === 'bin' ? '.bin' : '.tlog';
  return `${stem}_${span}${ext}`;
}
