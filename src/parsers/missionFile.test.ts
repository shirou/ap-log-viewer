import { describe, it, expect } from 'vitest';
import { parseMissionFile } from './missionFile.ts';

// Tab-separated, the way every writer emits it.
const row = (...f: (number | string)[]) => f.join('\t');

describe('parseMissionFile — QGC WPL text', () => {
  it('reads waypoints, keeping the file’s own index as the sequence number', () => {
    const text = [
      'QGC WPL 110',
      row(0, 1, 0, 16, 0, 0, 0, 0, 47.660459, -122.103167, 5.21, 1),
      row(1, 0, 3, 22, 0, 0, 0, 0, 47.661298, -122.103274, 100, 1),
      row(2, 0, 3, 16, 0, 0, 0, 0, 47.662, -122.104, 100, 1),
    ].join('\n');
    const { waypoints, unreadable } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1, 2]);
    expect(waypoints[0].lat).toBeCloseTo(47.660459, 6); // plain degrees, not degE7
    expect(waypoints[0].lon).toBeCloseTo(-122.103167, 6);
    expect(waypoints[1].command).toBe(22);
    expect(waypoints[1].alt).toBeCloseTo(100, 6);
    expect(waypoints[1].frame).toBe(3);
    expect(unreadable).toBe(0);
  });

  it('survives a BOM, CRLF line endings, comments and blank lines', () => {
    const text =
      '﻿QGC WPL 110\r\n' +
      '# exported by hand\r\n' +
      row(0, 1, 0, 16, 0, 0, 0, 0, 35.0, 139.0, 0, 1) +
      '\r\n\r\n' +
      row(1, 0, 3, 16, 0, 0, 0, 0, 35.001, 139.001, 50, 1) +
      '\r\n';
    const { waypoints } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1]);
    // A \r left glued to the last column would make autocontinue misparse; the
    // altitude column is the one that would show it here.
    expect(waypoints[1].alt).toBeCloseTo(50, 6);
  });

  it('accepts the space-separated variant some writers produce', () => {
    const text = ['QGC WPL 110', '0 1 0 16 0 0 0 0 35.0 139.0 0 1'].join('\n');
    expect(parseMissionFile(text).waypoints).toHaveLength(1);
  });

  it('rejects a decimal-comma file instead of misreading its coordinates', () => {
    // Splitting on whitespace alone would leave "35,0" as one field and
    // Number() would yield NaN, but a comma-separated writer also shatters the
    // row into far more fields — which is the signal actually worth failing on.
    const text = ['QGC WPL 110', '0,1,0,16,0,0,0,0,35,0,139,0,0,1'].join('\n');
    expect(() => parseMissionFile(text)).toThrow(/expected 12 fields/);
  });

  it('reads the blank-home row Mission Planner writes as command 0', () => {
    const text = [
      'QGC WPL 110',
      row(0, 1, 0, 0, 0, 0, 0, 0, 35.0, 139.0, 0, 1), // command 0 at index 0
      row(1, 0, 3, 16, 0, 0, 0, 0, 35.001, 139.001, 50, 1),
    ].join('\n');
    // Treated as a plain waypoint, the way every other reader does.
    expect(parseMissionFile(text).waypoints.map((w) => w.seq)).toEqual([0, 1]);
  });

  it('drops non-positional commands, as the log path does', () => {
    const text = [
      'QGC WPL 110',
      row(0, 1, 0, 16, 0, 0, 0, 0, 35.0, 139.0, 0, 1),
      row(1, 0, 3, 177, 4, 2, 0, 0, 0, 0, 0, 1), // DO_JUMP: params, not a place
      row(2, 0, 3, 16, 0, 0, 0, 0, 35.002, 139.002, 50, 1),
    ].join('\n');
    expect(parseMissionFile(text).waypoints.map((w) => w.seq)).toEqual([0, 2]);
  });
});

describe('parseMissionFile — QGC .plan JSON', () => {
  const plan = (mission: unknown) =>
    JSON.stringify({ fileType: 'Plan', version: 1, groundStation: 'QGroundControl', mission });

  const simple = (doJumpId: number, command: number, lat: number, lon: number, alt: number) => ({
    type: 'SimpleItem',
    command,
    frame: 3,
    params: [0, 0, 0, null, lat, lon, alt],
    autoContinue: true,
    doJumpId,
  });

  it('takes home from plannedHomePosition as sequence 0', () => {
    const text = plan({
      version: 2,
      plannedHomePosition: [47.3977419, 8.545594, 487.989],
      items: [simple(1, 22, 47.3985, 8.5451, 50), simple(2, 16, 47.3990, 8.5460, 50)],
    });
    const { waypoints } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1, 2]);
    expect(waypoints[0].lat).toBeCloseTo(47.3977419, 6); // home is not in items
    expect(waypoints[1].command).toBe(22);
  });

  it('treats a null coordinate as absent rather than as zero', () => {
    // Qt serialises NaN as null. Read as 0 it would put a waypoint off West
    // Africa; the whole point is that it must not be drawn at all.
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [
        { type: 'SimpleItem', command: 16, frame: 3, params: [0, 0, 0, null, null, null, 50], doJumpId: 1 },
        simple(2, 16, 35.002, 139.002, 50),
      ],
    });
    expect(parseMissionFile(text).waypoints.map((w) => w.seq)).toEqual([0, 2]);
  });

  it('reads the legacy shape that carries a separate coordinate array', () => {
    const text = plan({
      plannedHomePosition: [47.6, -122.0, 0],
      items: [
        {
          type: 'SimpleItem',
          command: 22,
          frame: 3,
          coordinate: [47.63311996, -122.090763, 20],
          params: [0, 0, 0, null], // only four, so params[4..6] hold nothing
          doJumpId: 1,
          autoContinue: true,
        },
      ],
    });
    const { waypoints } = parseMissionFile(text);
    expect(waypoints[1].lat).toBeCloseTo(47.63311996, 6);
    expect(waypoints[1].alt).toBeCloseTo(20, 6);
  });

  it('expands a survey, whose generated waypoints are stored in the file', () => {
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [
        simple(1, 22, 35.001, 139.001, 30),
        {
          type: 'ComplexItem',
          complexItemType: 'survey',
          version: 5,
          TransectStyleComplexItem: {
            Items: [simple(2, 16, 35.010, 139.010, 40), simple(3, 16, 35.011, 139.011, 40)],
            VisualTransectPoints: [[35.010, 139.010], [35.011, 139.011]],
          },
        },
      ],
    });
    const { waypoints, unreadable } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1, 2, 3]);
    expect(waypoints[3].lat).toBeCloseTo(35.011, 6);
    expect(unreadable).toBe(0);
  });

  it('counts a structure scan as unreadable rather than silently skipping it', () => {
    // It stores only the parameters QGC regenerates the orbit from, so the
    // waypoints genuinely are not in the file.
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [
        simple(1, 16, 35.001, 139.001, 30),
        { type: 'ComplexItem', complexItemType: 'StructureScan', version: 3, Layers: 2 },
      ],
    });
    const { waypoints, unreadable } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1]);
    expect(unreadable).toBe(1);
  });

  it('rejects files that are not plans', () => {
    expect(() => parseMissionFile('{"fileType":"Fence"}')).toThrow(/not a qgc \.plan/i);
    expect(() => parseMissionFile('hello world')).toThrow(/not a mission file/i);
  });
});
