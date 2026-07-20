// Matching the field tree's search box against message *and* field names.
//
// Searching message names alone covers the wrong half of the problem: .bin
// columns are FMT abbreviations (GCrs, Volt) and tlog columns are MAVLink
// camelCase (xmag, cog, relativeAlt), so the name you remember is usually the
// field's, not that of whichever message happens to carry it.
//
// Every field name is already in memory once parsing finishes, so this is a
// plain scan on each keystroke — a log has at most ~10^3 message types of ~10
// fields each, and no index would earn its upkeep against purgeMessage.

import type { MessageSeries } from '../model/log.ts';

export interface SearchQuery {
  /** Term for message names, lowercased. Empty means "no constraint". */
  message: string;
  /** Term for field names, lowercased. Empty means "do not match fields". */
  field: string;
  /** Input carried a `.`, so the two halves are ANDed rather than ORed. */
  dotted: boolean;
}

/**
 * Shortest field term worth matching.
 *
 * Typing `cog` passes through `c`, and a single letter is a substring of some
 * field in nearly every message. Since a field hit expands its message, a
 * one-letter term would open the whole tree — thousands of rows — on the way to
 * every useful query. One-letter field search has no real use anyway, so it is
 * dropped and the panel then behaves exactly as it did before this module
 * existed: message names only.
 */
const MIN_FIELD_TERM = 2;

/** The .bin time column. It is the x axis, never a series you would plot. */
const TIME_FIELD = 'TimeUS';

/** Null when the box is effectively empty and the whole tree should show. */
export function parseQuery(raw: string): SearchQuery | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;

  const dot = q.indexOf('.');
  if (dot < 0) {
    // A bare term matches either half. Storing it in both lets callers
    // highlight names with `message` and fields with `field` without caring
    // which form the query took.
    return { message: q, field: q.length >= MIN_FIELD_TERM ? q : '', dotted: false };
  }

  // First dot only. `a.b.c` leaves `b.c` as the field term, which matches
  // nothing — field names never contain dots.
  const message = q.slice(0, dot);
  const field = q.slice(dot + 1);
  // Nothing usable on either side ("." or ".c"): treat it as still typing.
  if (!message && field.length < MIN_FIELD_TERM) return null;
  return { message, field: field.length >= MIN_FIELD_TERM ? field : '', dotted: true };
}

export interface MessageMatch {
  series: MessageSeries;
  /** Field names to render, always without `TimeUS`. */
  fields: string[];
  /**
   * The subset of `fields` the query matched, for highlighting.
   *
   * Readonly because unmatched rows all share one empty set; adding to it
   * through a match would light up every other row that borrowed it.
   */
  hits: ReadonlySet<string>;
  /** Whether the message should start expanded. */
  autoExpand: boolean;
}

const NO_HITS: ReadonlySet<string> = new Set();

/** Messages to show for `raw`, name-sorted, each with the fields to show. */
export function searchMessages(messages: Record<string, MessageSeries>, raw: string): MessageMatch[] {
  const q = parseQuery(raw);
  const out: MessageMatch[] = [];

  for (const series of Object.values(messages)) {
    // String columns are not in `fields`, so a message left with nothing here
    // has no plottable series and is not worth a row.
    const fields = Object.keys(series.fields).filter((f) => f !== TIME_FIELD);
    if (fields.length === 0) continue;

    if (!q) {
      out.push({ series, fields, hits: NO_HITS, autoExpand: false });
      continue;
    }

    const nameHit = series.name.toLowerCase().includes(q.message);
    // The dotted form is an AND: the message half must match before the field
    // half is considered, so `gps.cog` cannot pull in a cog from elsewhere.
    if (q.dotted && !nameHit) continue;

    const hits: ReadonlySet<string> = q.field
      ? new Set(fields.filter((f) => f.toLowerCase().includes(q.field)))
      : NO_HITS;
    if (!nameHit && hits.size === 0) continue;
    if (q.dotted && q.field && hits.size === 0) continue;

    // An explicit field term always narrows to the hits and opens the message.
    // A bare term is ambiguous, so a message whose *name* matched keeps its
    // full field list and stays collapsed exactly as it used to: the tree only
    // opens itself when opening is the only way to show why the message is
    // here. (Both guards above make `hits` non-empty whenever `narrow` holds.)
    const narrow = q.dotted ? q.field !== '' : !nameHit;
    out.push({
      series,
      fields: narrow ? fields.filter((f) => hits.has(f)) : fields,
      hits,
      autoExpand: narrow,
    });
  }

  out.sort((a, b) => a.series.name.localeCompare(b.series.name));
  return out;
}
