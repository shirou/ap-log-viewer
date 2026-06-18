import { create } from 'zustand';
import type { FieldRef, LogData, ParseMessage } from '../model/log.ts';
import { fieldKey } from '../model/log.ts';

export type Status = 'idle' | 'parsing' | 'ready' | 'error';

// The in-flight parse worker. Kept outside the reactive store; only one parse
// runs at a time so a slow earlier parse can't clobber a newer one.
let activeWorker: Worker | null = null;

interface LogState {
  status: Status;
  progress: number;
  error: string | null;
  fileName: string | null;
  log: LogData | null;
  /** Increments on each loaded log; used as a stable remount key for the map. */
  loadId: number;

  // Plot selection.
  selectedFields: FieldRef[];

  // Timeline / playback (cursorTime is the single source of truth, microseconds).
  cursorTime: number;
  playing: boolean;
  speed: number; // playback multiplier for continuous mode
  stepMode: 'continuous' | 'interval';
  stepIntervalSec: number; // seconds of log-time per tick in interval mode
  loop: boolean;

  parseFile: (file: File) => void;
  reset: () => void;
  /** Drop one message type from memory (frees its columns; map trajectory is kept). */
  purgeMessage: (name: string) => void;
  /** Drop every message type that has no plotted field. */
  purgeUnselected: () => void;
  toggleField: (ref: FieldRef) => void;
  setCursorTime: (t: number) => void;
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

export const useLogStore = create<LogState>((set, get) => ({
  status: 'idle',
  progress: 0,
  error: null,
  fileName: null,
  log: null,
  loadId: 0,
  selectedFields: [],
  cursorTime: 0,
  playing: false,
  speed: 1,
  stepMode: 'continuous',
  stepIntervalSec: 1,
  loop: false,

  parseFile: (file) => {
    // Cancel any in-flight parse so a slow earlier worker can't post a stale
    // result that overwrites this one.
    activeWorker?.terminate();
    set({ status: 'parsing', progress: 0, error: null, fileName: file.name, log: null, playing: false });

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

  reset: () => {
    activeWorker?.terminate();
    activeWorker = null;
    set({ status: 'idle', progress: 0, error: null, fileName: null, log: null, selectedFields: [], cursorTime: 0, playing: false });
  },

  purgeMessage: (name) => {
    const { log, selectedFields } = get();
    if (!log || !log.messages[name]) return;
    const messages = { ...log.messages };
    delete messages[name];
    // New `log` ref re-renders consumers; `trajectory` ref is unchanged so the
    // map does not rebuild and `loadId` stays put so the camera is preserved.
    set({ log: { ...log, messages }, selectedFields: selectedFields.filter((r) => r.message !== name) });
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
    const cur = get().selectedFields;
    const exists = cur.some((r) => fieldKey(r) === key);
    set({ selectedFields: exists ? cur.filter((r) => fieldKey(r) !== key) : [...cur, ref] });
  },

  setCursorTime: (t) => {
    const log = get().log;
    if (!log) return set({ cursorTime: t });
    const clamped = Math.max(log.startTime, Math.min(log.endTime, t));
    set({ cursorTime: clamped });
  },
  setPlaying: (p) => set({ playing: p }),
  togglePlaying: () => set({ playing: !get().playing }),
  setSpeed: (s) => set({ speed: s }),
  setStepMode: (m) => set({ stepMode: m }),
  setStepIntervalSec: (s) => set({ stepIntervalSec: s }),
  setLoop: (l) => set({ loop: l }),
}));
