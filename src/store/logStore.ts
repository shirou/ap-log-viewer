import { create } from 'zustand';
import type { FieldRef, LogData, ParseMessage, ParsedLog, Waypoint } from '../model/log.ts';
import { ALL_SOURCES, fieldKey } from '../model/log.ts';
import { defaultSelection, projectLog, selectionKeys } from '../parsers/project.ts';
import { parseMissionFile } from '../parsers/missionFile.ts';
import type { AxisSide } from '../lib/axisGroups.ts';

/**
 * Axis pins by fieldKey. Deliberately not `Record<string, AxisSide>`: most keys
 * are absent (absent means automatic), and that type would have TypeScript
 * promise every lookup returns a side, hiding the `undefined` every caller has
 * to handle.
 */
export type AxisOverrides = Record<string, AxisSide | undefined>;

export type Status = 'idle' | 'parsing' | 'ready' | 'error';

export type Theme = 'light' | 'dark';

// Resolve the startup theme. An inline script in index.html already stamped
// data-theme onto <html> before first paint (to avoid a flash), so trust that
// first; fall back to the saved preference, then the OS setting, then dark.
function initialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
  }
  if (typeof window !== 'undefined') {
    const saved = window.localStorage?.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  }
  return 'dark';
}

function applyTheme(theme: Theme) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    window.localStorage?.setItem('theme', theme);
  } catch {
    // localStorage may be unavailable (private mode); theme still applies for the session.
  }
}

// The in-flight parse worker. Kept outside the reactive store; only one parse
// runs at a time so a slow earlier parse can't clobber a newer one.
let activeWorker: Worker | null = null;

// Same idea for plan files, which are read asynchronously: only the newest
// request may write its result, so picking a second file while the first is
// still being read cannot leave the earlier one on screen.
let missionFileLoadId = 0;

/** Generous for a flight plan (a 700-waypoint survey is well under 1 MB). */
const MAX_PLAN_BYTES = 8 * 1024 * 1024;

export interface LogState {
  status: Status;
  progress: number;
  error: string | null;
  fileName: string | null;
  /**
   * The file the current log was read from, kept so a window of it can be cut
   * back out as original bytes.
   *
   * Costs nothing to hold: a File is a handle the OS hands out, not the bytes —
   * the parse worker is already given this same object. With the only entry point
   * being FileDropzone -> parseFile(File) this is non-null whenever a log is
   * loaded; the null case is the LogSource seam's future remote sources (see
   * src/parsers/source.ts), which is why readers have to handle it.
   *
   * A handle is not a snapshot: if the log is moved, deleted or rewritten after
   * it was opened — pulling the SD card is the realistic one — reading it again
   * fails, and that surfaces as a download error rather than something this can
   * detect up front.
   */
  file: File | null;
  log: LogData | null;
  /**
   * Every MAVLink source the file held, unprojected. `log` is one selection of
   * this. Purging drops columns from here, which is the only place doing so
   * frees anything.
   */
  parsed: ParsedLog | null;
  /** Which source `log` shows: a `sourceKey`, a `groupKey`, or `ALL_SOURCES`. */
  selection: string;
  /**
   * Increments on each loaded log.
   *
   * Read by PlotPanel as the identity token for a carried zoom, so it must NOT
   * move when only the selected source changes: `xViewRef` is tagged with it
   * and a mismatch throws the zoom away, after which uPlot's first setScale
   * reports an un-zoomed view and clears `viewRange` — taking the download
   * control with it.
   */
  loadId: number;
  /**
   * Remount key for the map, bumped whenever the drawn track is a different
   * flight: a new log, or a different source within one.
   *
   * Split from `loadId` because the two want opposite things on a source
   * switch — the map should reframe on the new track, the plot should keep the
   * window the reader zoomed to.
   */
  mapKey: number;

  /**
   * A flight plan loaded from a separate file, which takes precedence over any
   * the log carries. Most logs carry none — a tlog only does when a mission
   * transfer happened to be recorded — so this is often the only way to see one.
   */
  missionFile: { name: string; waypoints: Waypoint[]; unreadable: number } | null;
  missionFileError: string | null;

  // UI theme (persisted). Drives the CSS custom properties and plot colors.
  theme: Theme;

  // Plot selection.
  selectedFields: FieldRef[];
  /** Fields pinned to a y axis by hand, keyed by fieldKey. Absent = automatic. */
  axisOverride: AxisOverrides;

  /**
   * The window the time-series plot is showing, absolute microseconds, or null
   * when it is showing everything it has.
   *
   * Null covers both "no plot" and "not zoomed". Un-zoomed, uPlot leaves
   * `scales.x` sitting on the data extremes, so the numbers alone cannot say
   * whether the reader narrowed anything — PlotPanel makes that call and reports
   * null when they did not. That is what makes this the answer to "is there a
   * window worth offering", with no tolerance constant to pick.
   *
   * Written by PlotPanel from the x scale, which is float seconds since
   * log.startTime; read through selectExportWindow.
   */
  viewRange: [number, number] | null;

  // Timeline / playback (cursorTime is the single source of truth, microseconds).
  cursorTime: number;
  /** Time under the pointer on the timeline scrub, or null when not hovering.
   *  A preview only — it never moves cursorTime. Read it via selectDisplayTime
   *  rather than directly, so every view previews the same instant. */
  hoverTime: number | null;
  playing: boolean;
  speed: number; // playback multiplier for continuous mode
  stepMode: 'continuous' | 'interval';
  stepIntervalSec: number; // seconds of log-time per tick in interval mode
  loop: boolean;

  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  parseFile: (file: File) => void;
  /** Show one MAVLink source or one SYSID group, or `ALL_SOURCES` for the
   *  unsplit log. */
  setSelection: (key: string) => void;
  /** Load a .waypoints/.txt (QGC WPL) or .plan (QGC JSON) flight plan. */
  loadMissionFile: (file: File) => Promise<void>;
  clearMissionFile: () => void;
  reset: () => void;
  /** Drop one message type from memory (frees its columns; map trajectory is kept). */
  purgeMessage: (name: string) => void;
  /** Drop every message type that has no plotted field. */
  purgeUnselected: () => void;
  toggleField: (ref: FieldRef) => void;
  /** Pin a plotted field to a y axis, or pass null to hand it back to the automatic split. */
  setAxisOverride: (key: string, side: AxisSide | null) => void;
  /** Report the plot's window in absolute microseconds, or null when un-zoomed. */
  setViewRange: (r: [number, number] | null) => void;
  setCursorTime: (t: number) => void;
  setHoverTime: (t: number | null) => void;
  setPlaying: (p: boolean) => void;
  togglePlaying: () => void;
  setSpeed: (s: number) => void;
  setStepMode: (m: 'continuous' | 'interval') => void;
  setStepIntervalSec: (s: number) => void;
  setLoop: (l: boolean) => void;
}

/**
 * Field names that are a clock, not a measurement.
 *
 * The fallback below picks blindly, so without this a source whose only message
 * is GPS_INPUT — whose first field is `timeUsec` — opens with a plot of the
 * UNIX epoch in microseconds.
 */
const TIME_FIELDS = new Set(['TimeUS', 'timeUsec', 'timeBootMs', 'timeWeekMs', 'timeUnixUsec', 'timeUtc']);

// Pick a couple of sensible default series to plot once a log loads.
function defaultFields(log: LogData): FieldRef[] {
  const prefs: FieldRef[] = [
    { message: 'ATT', field: 'Roll' },
    { message: 'ATT', field: 'Pitch' },
    { message: 'GPS', field: 'Alt' },
    { message: 'BAT', field: 'Volt' },
    { message: 'VFR_HUD', field: 'alt' },
    { message: 'ATTITUDE', field: 'roll' },
  ];
  const picked = prefs.filter((r) => log.messages[r.message]?.fields[r.field]);
  if (picked.length) return picked.slice(0, 2);
  // Fallback: first numeric field of the first message that has one.
  for (const m of Object.values(log.messages)) {
    const field = Object.keys(m.fields).find((f) => !TIME_FIELDS.has(f));
    if (field) return [{ message: m.name, field }];
  }
  return [];
}

/**
 * Drop axis pins for fields that are no longer plotted.
 *
 * Without this a pin outlives the series it belongs to and springs back the
 * next time that field is selected, long after the user has forgotten setting
 * it. Every path that removes a field routes through here — note that
 * purgeMessage drops fields without going near toggleField.
 */
function pruneOverrides(overrides: AxisOverrides, fields: FieldRef[]): AxisOverrides {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return overrides;
  const keep = new Set(fields.map(fieldKey));
  if (keys.every((k) => keep.has(k))) return overrides;
  const out: AxisOverrides = {};
  for (const k of keys) if (keep.has(k)) out[k] = overrides[k];
  return out;
}

/**
 * Drop message types from some of a parse's sources, releasing their columns.
 *
 * Rebuilds only the sources it touches, and only their `messages` map, so every
 * other array — every column of every kept type, and every source's trajectory
 * — is carried across by reference. That is what keeps `log.trajectory` stable
 * through a purge, which the map depends on.
 */
function dropTypes(parsed: ParsedLog, keys: string[], shouldDrop: (name: string) => boolean): ParsedLog {
  const bySource = new Map(parsed.bySource);
  for (const key of keys) {
    const data = bySource.get(key);
    if (!data) continue;
    const names = Object.keys(data.messages).filter(shouldDrop);
    if (names.length === 0) continue;
    const messages = { ...data.messages };
    for (const n of names) delete messages[n];
    bySource.set(key, { ...data, messages });
  }
  return { ...parsed, bySource };
}

/**
 * The instant being previewed, or null when the playhead is what's live.
 *
 * Hover never applies during playback, so a pointer merely crossing the scrub
 * cannot hijack the live position. Two things already uphold that — the scrub
 * records no preview while playing, and setPlaying clears any pending one — so
 * the guard here is belt-and-braces, keeping the rule correct on its own terms
 * rather than depending on those callers.
 */
export const selectPreviewTime = (s: LogState): number | null => (s.playing ? null : s.hoverTime);

/**
 * The instant every view should render: the preview when there is one,
 * otherwise the playhead. Map marker, plot cursor line and the timeline readout
 * all read this, so they can never disagree about what is on screen.
 */
export const selectDisplayTime = (s: LogState): number => selectPreviewTime(s) ?? s.cursorTime;

/**
 * The window a download should offer, or null when there is nothing to offer.
 *
 * There is deliberately no "and narrower than the whole file" test on top. The
 * plotted series' timestamps are a subset of every message's, so the plot's data
 * extremes always sit inside [startTime, endTime]; a zoom is strictly narrower
 * than those extremes, so being narrower than the file follows for free.
 *
 * Returns the stored tuple itself, never a copy. This is read through
 * useLogStore, whose snapshots are compared by identity, so a fresh array here
 * would re-render on every unrelated store change — the playhead ticks sixty
 * times a second — and would break useSyncExternalStore's caching contract.
 * setViewRange only replaces the tuple when the numbers move, which is what
 * makes that safe.
 */
export const selectExportWindow = (s: LogState): [number, number] | null =>
  s.viewRange && s.viewRange[1] > s.viewRange[0] ? s.viewRange : null;

export const useLogStore = create<LogState>((set, get) => ({
  status: 'idle',
  progress: 0,
  error: null,
  fileName: null,
  file: null,
  log: null,
  parsed: null,
  selection: ALL_SOURCES,
  loadId: 0,
  mapKey: 0,
  missionFile: null,
  missionFileError: null,
  theme: initialTheme(),
  selectedFields: [],
  axisOverride: {},
  viewRange: null,
  cursorTime: 0,
  hoverTime: null,
  playing: false,
  speed: 1,
  stepMode: 'continuous',
  stepIntervalSec: 1,
  loop: false,

  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
  },
  toggleTheme: () => {
    const t: Theme = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    set({ theme: t });
  },

  parseFile: (file) => {
    // Cancel any in-flight parse so a slow earlier worker can't post a stale
    // result that overwrites this one.
    activeWorker?.terminate();
    // The plan is dropped along with the log it was loaded against. Carrying it
    // over would silently draw one flight's mission across a different flight,
    // which reads as fact rather than as leftover state.
    missionFileLoadId++;
    // viewRange is microseconds on the *previous* log's clock, so it has to go
    // now rather than when the next plot first reports one.
    set({ status: 'parsing', progress: 0, error: null, fileName: file.name, file, log: null, parsed: null, selection: ALL_SOURCES, playing: false, hoverTime: null, axisOverride: {}, viewRange: null, missionFile: null, missionFileError: null });

    const worker = new Worker(new URL('../parsers/parser.worker.ts', import.meta.url), { type: 'module' });
    activeWorker = worker;
    const done = () => {
      worker.terminate();
      if (activeWorker === worker) activeWorker = null;
    };
    worker.onmessage = (e: MessageEvent<ParseMessage>) => {
      if (activeWorker !== worker) return; // superseded by a newer parse
      const msg = e.data;
      if (msg.type === 'progress') {
        set({ progress: msg.ratio });
      } else if (msg.type === 'done') {
        // The projection runs here, on the main thread, and since the opening
        // selection became a SYSID group it merges rather than handing back the
        // parser's own arrays — which means it allocates. A throw from that
        // would skip the `set` below and leave `status` on 'parsing' forever,
        // with the bar at 100% and nothing said. Report it like any other
        // failure instead.
        try {
          const selection = defaultSelection(msg.parsed);
          const log = projectLog(msg.parsed, selection);
          set((s) => ({
            status: 'ready',
            progress: 1,
            parsed: msg.parsed,
            selection,
            log,
            loadId: s.loadId + 1,
            mapKey: s.mapKey + 1,
            cursorTime: log.startTime,
            selectedFields: defaultFields(log),
          }));
        } catch (err) {
          set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        }
        done();
      } else {
        set({ status: 'error', error: msg.message });
        done();
      }
    };
    worker.onerror = (e) => {
      if (activeWorker !== worker) return;
      set({ status: 'error', error: e.message || 'worker error' });
      done();
    };
    worker.postMessage({ file });
  },

  // Plan files are small text/JSON, so unlike a log they are read here rather
  // than handed to the parse worker.
  // A rejected file reports why but leaves any plan already loaded in place:
  // picking the wrong file by mistake should not also throw away the right one.
  loadMissionFile: async (file) => {
    const id = ++missionFileLoadId;
    // A plan is text measured in kilobytes. The picker also offers .txt, so the
    // realistic mistake is handing this a log — which would otherwise be read
    // into a string, and copied again, before the header check rejected it.
    if (file.size > MAX_PLAN_BYTES) {
      return set({ missionFileError: 'Too large to be a flight plan' });
    }
    try {
      const parsed = parseMissionFile(await file.text());
      if (id !== missionFileLoadId) return; // superseded by a newer pick
      if (parsed.waypoints.length === 0) {
        return set({ missionFileError: 'No drawable waypoints in that file' });
      }
      set({ missionFile: { name: file.name, ...parsed }, missionFileError: null });
    } catch (err) {
      if (id !== missionFileLoadId) return;
      set({ missionFileError: err instanceof Error ? err.message : String(err) });
    }
  },

  // Bumps the id as well: a read still in flight must not land after the plan
  // it belongs to has been dismissed, or after a different log has been opened.
  clearMissionFile: () => {
    missionFileLoadId++;
    set({ missionFile: null, missionFileError: null });
  },

  // Moving between sources is not opening a log: the clock, the window and the
  // playhead all still mean what they did, because the timeline's ends span
  // every source (see LogData.startTime). What has to give way is the field
  // selection, since the new source need not carry the same message types.
  setSelection: (key) => {
    const { parsed, selection, selectedFields, axisOverride } = get();
    if (!parsed || key === selection) return;
    const log = projectLog(parsed, key);
    const kept = selectedFields.filter((r) => log.messages[r.message]?.fields[r.field]);
    const next = kept.length ? kept : defaultFields(log);
    set((s) => ({
      log,
      selection: log.selection,
      selectedFields: next,
      axisOverride: pruneOverrides(axisOverride, next),
      // The map reframes on the new track; the plot keeps its zoom. Only
      // `mapKey` moves — see the note on `loadId`.
      mapKey: s.mapKey + 1,
      // A different vehicle mid-playback is disorienting, and the playhead is
      // about to be pointing at a stretch this source may not even cover.
      playing: false,
    }));
  },

  reset: () => {
    activeWorker?.terminate();
    activeWorker = null;
    missionFileLoadId++;
    set({ status: 'idle', progress: 0, error: null, fileName: null, file: null, log: null, parsed: null, selection: ALL_SOURCES, selectedFields: [], axisOverride: {}, viewRange: null, cursorTime: 0, hoverTime: null, playing: false, missionFile: null, missionFileError: null });
  },

  // Dropped from `parsed`, not from `log`: the projection holds references into
  // the parse, so removing a type from the view alone would free nothing and
  // the button's promise ("to reduce usage") would be a lie.
  //
  // `trajectory` survives untouched because it is stored per source rather than
  // derived from whatever messages remain — which is what lets the map keep
  // showing the track after the position message itself has been purged.
  purgeMessage: (name) => {
    const { parsed, selection, log, selectedFields, axisOverride } = get();
    if (!parsed || !log?.messages[name]) return;
    // Whatever is on screen is what goes. Under a single address that leaves the
    // other sources' copies of the type alone; under a SYSID group it is every
    // component of that aircraft; under "all sources" it is all of them —
    // because that is what "on screen" means in each case.
    const scope = selectionKeys(parsed, selection);
    const next = dropTypes(parsed, scope, (n) => n === name);
    const kept = selectedFields.filter((r) => r.message !== name);
    // New `log` ref re-renders consumers; `loadId`/`mapKey` stay put so neither
    // the plot's zoom nor the map's camera is disturbed.
    set({
      parsed: next,
      log: projectLog(next, selection),
      selectedFields: kept,
      axisOverride: pruneOverrides(axisOverride, kept),
    });
  },

  // Unlike purgeMessage this ignores the selection and clears every source.
  // "Types with nothing plotted" is a statement about the plot, not about one
  // vehicle, and confining it to the selected source would free only part of
  // the memory — on the sample log, 87% of it, leaving 54,000 records behind
  // under a button that says it reduces usage.
  purgeUnselected: () => {
    const { parsed, selection, log, selectedFields } = get();
    if (!parsed || !log) return;
    const keep = new Set(selectedFields.map((r) => r.message));
    const next = dropTypes(parsed, [...parsed.bySource.keys()], (n) => !keep.has(n));
    set({ parsed: next, log: projectLog(next, selection) });
  },

  toggleField: (ref) => {
    const key = fieldKey(ref);
    const { selectedFields: cur, axisOverride } = get();
    const exists = cur.some((r) => fieldKey(r) === key);
    const next = exists ? cur.filter((r) => fieldKey(r) !== key) : [...cur, ref];
    set({ selectedFields: next, axisOverride: pruneOverrides(axisOverride, next) });
  },

  setAxisOverride: (key, side) => {
    const cur = get().axisOverride;
    if (side == null) {
      if (!(key in cur)) return;
      const next = { ...cur };
      delete next[key];
      return set({ axisOverride: next });
    }
    if (cur[key] === side) return;
    set({ axisOverride: { ...cur, [key]: side } });
  },

  // Clamped like cursorTime/hoverTime, and — unlike them — left strictly alone
  // when the numbers have not moved. Rebuilding the plot (moving a series to the
  // other axis, adding one, switching theme) replays the carried zoom, so the
  // same window arrives here again; a fresh tuple each time would re-render the
  // download control for nothing and break the identity comparison
  // useSyncExternalStore does on selectExportWindow's result.
  setViewRange: (r) => {
    const { log, viewRange: cur } = get();
    const next: [number, number] | null =
      r && log
        ? [
            Math.max(log.startTime, Math.min(log.endTime, r[0])),
            Math.max(log.startTime, Math.min(log.endTime, r[1])),
          ]
        : r;
    if (cur === next) return;
    if (cur && next && cur[0] === next[0] && cur[1] === next[1]) return;
    set({ viewRange: next });
  },

  setCursorTime: (t) => {
    const log = get().log;
    if (!log) return set({ cursorTime: t });
    const clamped = Math.max(log.startTime, Math.min(log.endTime, t));
    set({ cursorTime: clamped });
  },
  setHoverTime: (t) => {
    const log = get().log;
    if (t == null || !log) return set({ hoverTime: t });
    set({ hoverTime: Math.max(log.startTime, Math.min(log.endTime, t)) });
  },
  // Starting playback drops any pending preview. The pointer can still be
  // resting on the scrub — reaching Play by keyboard fires no pointerleave — and
  // a preview left behind would snap every view back to a stale instant the
  // moment playback pauses. togglePlaying routes through here so the rule has
  // one home.
  setPlaying: (p) => set(p ? { playing: true, hoverTime: null } : { playing: false }),
  togglePlaying: () => get().setPlaying(!get().playing),
  setSpeed: (s) => set({ speed: s }),
  setStepMode: (m) => set({ stepMode: m }),
  setStepIntervalSec: (s) => set({ stepIntervalSec: s }),
  setLoop: (l) => set({ loop: l }),
}));
