import { create } from 'zustand';
import type { FieldRef, LogData, ParseMessage, Waypoint } from '../model/log.ts';
import { fieldKey } from '../model/log.ts';
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

export interface LogState {
  status: Status;
  progress: number;
  error: string | null;
  fileName: string | null;
  log: LogData | null;
  /** Increments on each loaded log; used as a stable remount key for the map. */
  loadId: number;

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
  setCursorTime: (t: number) => void;
  setHoverTime: (t: number | null) => void;
  setPlaying: (p: boolean) => void;
  togglePlaying: () => void;
  setSpeed: (s: number) => void;
  setStepMode: (m: 'continuous' | 'interval') => void;
  setStepIntervalSec: (s: number) => void;
  setLoop: (l: boolean) => void;
}

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
    const field = Object.keys(m.fields).find((f) => f !== 'TimeUS');
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

export const useLogStore = create<LogState>((set, get) => ({
  status: 'idle',
  progress: 0,
  error: null,
  fileName: null,
  log: null,
  loadId: 0,
  missionFile: null,
  missionFileError: null,
  theme: initialTheme(),
  selectedFields: [],
  axisOverride: {},
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
    set({ status: 'parsing', progress: 0, error: null, fileName: file.name, log: null, playing: false, hoverTime: null, axisOverride: {}, missionFile: null, missionFileError: null });

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
        set((s) => ({
          status: 'ready',
          progress: 1,
          log: msg.log,
          loadId: s.loadId + 1,
          cursorTime: msg.log.startTime,
          selectedFields: defaultFields(msg.log),
        }));
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
    try {
      const parsed = parseMissionFile(await file.text());
      if (parsed.waypoints.length === 0) {
        return set({ missionFileError: 'No drawable waypoints in that file' });
      }
      set({ missionFile: { name: file.name, ...parsed }, missionFileError: null });
    } catch (err) {
      set({ missionFileError: err instanceof Error ? err.message : String(err) });
    }
  },

  clearMissionFile: () => set({ missionFile: null, missionFileError: null }),

  reset: () => {
    activeWorker?.terminate();
    activeWorker = null;
    set({ status: 'idle', progress: 0, error: null, fileName: null, log: null, selectedFields: [], axisOverride: {}, cursorTime: 0, hoverTime: null, playing: false, missionFile: null, missionFileError: null });
  },

  purgeMessage: (name) => {
    const { log, selectedFields, axisOverride } = get();
    if (!log || !log.messages[name]) return;
    const messages = { ...log.messages };
    delete messages[name];
    const kept = selectedFields.filter((r) => r.message !== name);
    // New `log` ref re-renders consumers; `trajectory` ref is unchanged so the
    // map does not rebuild and `loadId` stays put so the camera is preserved.
    set({ log: { ...log, messages }, selectedFields: kept, axisOverride: pruneOverrides(axisOverride, kept) });
  },

  purgeUnselected: () => {
    const { log, selectedFields } = get();
    if (!log) return;
    const keep = new Set(selectedFields.map((r) => r.message));
    const messages: LogData['messages'] = {};
    for (const [name, m] of Object.entries(log.messages)) if (keep.has(name)) messages[name] = m;
    set({ log: { ...log, messages } });
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
