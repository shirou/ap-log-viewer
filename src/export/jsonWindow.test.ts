import { describe, expect, it } from 'vitest';
import type { LogData, MessageSeries } from '../model/log.ts';
import { JSON_FORMAT_VERSION, jsonBlob, jsonParts } from './jsonWindow.ts';

const f64 = (...v: number[]) => Float64Array.from(v);
const f64of = (v: number[]) => Float64Array.from(v);

function series(name: string, time: number[], fields: Record<string, number[]>, textFields?: Record<string, string[]>): MessageSeries {
  return {
    name,
    time: f64(...time),
    labels: ['TimeUS', ...Object.keys(fields), ...Object.keys(textFields ?? {})],
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, f64(...v)])),
    ...(textFields ? { textFields } : {}),
  };
}

function makeLog(over: Partial<LogData> = {}): LogData {
  return {
    source: 'bin',
    messages: {
      GPS: series('GPS', [2_000_000, 3_000_000], { Alt: [10, 20], Lat: [35, 36] }),
      ATT: series('ATT', [2_500_000], { Roll: [0.5] }),
    },
    params: { P1: 2, LATE: 7 },
    modes: [{ time: 2_000_000, mode: 'Mode 3' }],
    texts: [{ time: 2_100_000, text: 'ArduPilot V4.5.7', severity: 6 }],
    commands: [],
    missionSteps: [{ time: 2_200_000, seq: 1 }],
    trajectory: {
      time: f64(2_000_000, 3_000_000),
      lat: f64(35, 36),
      lon: f64(139, 140),
      alt: f64(10, 20),
      heading: f64(90, NaN),
    },
    mission: [{ seq: 0, command: 16, lat: 35, lon: 139, alt: 50, frame: 3 }],
    startTime: 2_000_000,
    endTime: 3_000_000,
    ...over,
  };
}

const META = { fileName: '00000008.BIN', window: { startUs: 2_000_000, endUs: 3_000_000 } };
const render = (log: LogData, meta = META) => [...jsonParts(log, meta)].join('');
const parsed = (log: LogData, meta = META) => JSON.parse(render(log, meta));

describe('jsonParts', () => {
  // Hand-assembled punctuation is only safe because this holds.
  it('emits parseable JSON with the documented top-level keys', () => {
    const doc = parsed(makeLog());
    expect(Object.keys(doc).sort()).toEqual(
      [
        'commands', 'data', 'generator', 'messages', 'mission', 'missionSteps', 'modes',
        'negativeZero', 'nonFinite', 'note', 'params', 'source', 'texts', 'timeBase',
        'timeUnit', 'trajectory', 'window',
      ].sort(),
    );
    expect(doc.generator).toEqual({ name: 'ap-log-viewer', format: JSON_FORMAT_VERSION });
    expect(doc.source).toEqual({ file: '00000008.BIN', kind: 'bin' });
  });

  it('writes one array per field', () => {
    const doc = parsed(makeLog());
    expect(doc.messages.GPS.count).toBe(2);
    expect(doc.messages.GPS.time).toEqual([2_000_000, 3_000_000]);
    expect(doc.messages.GPS.fields.Alt).toEqual([10, 20]);
    expect(doc.messages.GPS.labels).toEqual(['TimeUS', 'Alt', 'Lat']);
  });

  it('reports the window that was asked for alongside what the data covers', () => {
    const doc = parsed(makeLog({ startTime: 2_400_000, endTime: 2_600_000 }));
    expect(doc.window).toEqual({ start: 2_000_000, end: 3_000_000, durationSec: 1 });
    expect(doc.data).toEqual({ start: 2_400_000, end: 2_600_000, durationSec: 0.2 });
  });

  it('says which clock the microseconds are on', () => {
    expect(parsed(makeLog()).timeBase).toBe('boot');
    expect(parsed(makeLog({ source: 'tlog' })).timeBase).toBe('unix');
  });

  it('turns non-finite values into null and round-trips finite ones exactly', () => {
    const log = makeLog({
      messages: { X: series('X', [1, 2, 3, 4, 5], { v: [NaN, Infinity, -Infinity, 0.1, 1e21] }) },
    });
    const got = parsed(log).messages.X.fields.v;
    expect(got.slice(0, 3)).toEqual([null, null, null]);
    expect(got[3]).toBe(0.1);
    expect(got[4]).toBe(1e21);
  });

  it('keeps the smallest denormal rather than flooring it', () => {
    const log = makeLog({ messages: { X: series('X', [1], { v: [1e-320] }) } });
    expect(parsed(log).messages.X.fields.v[0]).toBe(1e-320);
  });

  // Nothing in flight data distinguishes -0, and the header says so.
  it('normalizes negative zero, which is what the header promises', () => {
    const log = makeLog({ messages: { X: series('X', [1], { v: [-0] }) } });
    const doc = parsed(log);
    expect(Object.is(doc.messages.X.fields.v[0], -0)).toBe(false);
    expect(doc.messages.X.fields.v[0]).toBe(0);
    expect(doc.negativeZero).toBe('normalized');
  });

  it('sorts the text columns too, whose insertion order means nothing either', () => {
    const mk = (textFields: Record<string, string[]>): MessageSeries => ({
      name: 'MSG',
      time: f64(1),
      labels: ['TimeUS', 'Message', 'Reason'],
      fields: {},
      textFields,
    });
    const one = render(makeLog({ messages: { MSG: mk({ Reason: ['b'], Message: ['a'] }) } }));
    const two = render(makeLog({ messages: { MSG: mk({ Message: ['a'], Reason: ['b'] }) } }));
    expect(one).toBe(two);
    expect(one.indexOf('"Message"')).toBeLessThan(one.indexOf('"Reason"'));
  });

  it('carries text columns only for the series that have them', () => {
    const log = makeLog({
      messages: {
        MSG: series('MSG', [1], {}, { Message: ['ArduPilot'] }),
        GPS: series('GPS', [1], { Alt: [1] }),
      },
    });
    const doc = parsed(log);
    expect(doc.messages.MSG.textFields.Message).toEqual(['ArduPilot']);
    expect(doc.messages.GPS.textFields).toBeUndefined();
  });

  // These come verbatim out of a log's own records, so a crafted file can put
  // anything in them.
  it('survives a payload holding a quote, a newline and a lone surrogate', () => {
    const nasty = 'a"b\nc\\d\ud800';
    const log = makeLog({ messages: { MSG: series('MSG', [1], {}, { Message: [nasty] }) } });
    expect(parsed(log).messages.MSG.textFields.Message[0]).toBe(nasty);
  });

  it('survives a message or field name holding a quote or a control character', () => {
    const log = makeLog({
      messages: { 'we"ird': series('we"ird', [1], { 'f"ield': [1] }) },
    });
    const doc = parsed(log);
    expect(doc.messages['we"ird'].fields['f"ield']).toEqual([1]);
  });

  // Two exports of the same slice should be the same string, so a diff means
  // something. Object.keys order is insertion order, which is arbitrary; the
  // declared `labels` order is not, and is left alone.
  it('sorts the field and message maps, whose order carries no meaning', () => {
    const labels = ['TimeUS', 'a', 'z'];
    const mk = (fields: Record<string, number[]>): MessageSeries => ({
      name: 'B',
      time: f64(1),
      labels,
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, f64of(v)])),
    });
    const one = render(makeLog({ messages: { B: mk({ z: [1], a: [2] }), A: series('A', [1], { q: [3] }) } }));
    const two = render(makeLog({ messages: { A: series('A', [1], { q: [3] }), B: mk({ a: [2], z: [1] }) } }));
    expect(one).toBe(two);
    expect(one.indexOf('"A"')).toBeLessThan(one.indexOf('"B"'));
  });

  it('leaves the declared label order as the log wrote it', () => {
    const log = makeLog({
      messages: { X: { name: 'X', time: f64(1), labels: ['TimeUS', 'z', 'a'], fields: { a: f64(1), z: f64(2) } } },
    });
    expect(parsed(log).messages.X.labels).toEqual(['TimeUS', 'z', 'a']);
  });

  it('carries the derived trajectory, nulling the samples with no heading', () => {
    const doc = parsed(makeLog());
    expect(doc.trajectory.lat).toEqual([35, 36]);
    expect(doc.trajectory.heading).toEqual([90, null]);
  });

  it('keeps params, mission and the event lists whole', () => {
    const doc = parsed(makeLog());
    expect(doc.params).toEqual({ P1: 2, LATE: 7 });
    expect(doc.mission).toEqual([{ seq: 0, command: 16, lat: 35, lon: 139, alt: 50, frame: 3 }]);
    expect(doc.texts).toEqual([{ time: 2_100_000, text: 'ArduPilot V4.5.7', severity: 6 }]);
    expect(doc.missionSteps).toEqual([{ time: 2_200_000, seq: 1 }]);
  });

  // The fragment boundaries carry the commas, which is the fiddly part.
  it('splits a long column into fragments that still join into valid JSON', () => {
    const n = 200_000;
    const time = Array.from({ length: n }, (_, i) => i);
    const log = makeLog({
      messages: { X: { name: 'X', time: f64of(time), labels: ['TimeUS', 'v'], fields: { v: f64of(time) } } },
    });
    const parts = [...jsonParts(log, META)];
    expect(parts.length).toBeGreaterThan(50);
    for (const p of parts) expect(p.length).toBeLessThan(200_000);
    const doc = JSON.parse(parts.join(''));
    expect(doc.messages.X.fields.v.length).toBe(n);
    expect(doc.messages.X.fields.v[n - 1]).toBe(n - 1);
  });

  // A series with no rows cannot come out of the parser — columnar.ts creates a
  // SeriesBuilder on the first push — so this is defensive, and it should at
  // least not produce a broken document.
  it('writes empty arrays for a row-less series rather than breaking', () => {
    const log = makeLog({ messages: { X: series('X', [], { v: [] }) } });
    const doc = parsed(log);
    expect(doc.messages.X).toEqual({ count: 0, labels: ['TimeUS', 'v'], time: [], fields: { v: [] } });
  });
});

describe('jsonBlob', () => {
  it('writes the same document a plain render gives', async () => {
    const log = makeLog();
    const blob = await jsonBlob(log, META, false);
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(render(log));
  });

  it('gzips to something that decompresses back to the same bytes', async () => {
    const n = 20_000;
    const time = Array.from({ length: n }, (_, i) => i);
    const log = makeLog({
      messages: { X: { name: 'X', time: f64of(time), labels: ['TimeUS', 'v'], fields: { v: f64of(time) } } },
    });
    const plain = await jsonBlob(log, META, false);
    const gz = await jsonBlob(log, META, true);

    expect(gz.type).toBe('application/gzip');
    expect(gz.size).toBeLessThan(plain.size);
    const back = await new Response(
      gz.stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(back).toBe(await plain.text());
  });
});
