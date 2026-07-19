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
    // '\uFEFF' rather than a literal BOM: invisible in source, it is the kind of
    // character an editor or a copy-paste silently drops, taking the coverage
    // with it while the test still passes.
    const text =
      '\uFEFFQGC WPL 110\r\n' +
      '# exported by hand\r\n' +
      row(0, 1, 0, 16, 0, 0, 0, 0, 35.0, 139.0, 0, 1) +
      '\r\n\r\n' +
      row(1, 0, 3, 16, 0, 0, 0, 0, 35.001, 139.001, 50, 1) +
      '\r\n';
    const { waypoints } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1]);
    // The trailing \r is stripped by the per-line trim before splitting, so no
    // column carries one into Number().
    expect(waypoints[1].alt).toBeCloseTo(50, 6);
  });

  it('tolerates blank lines before the header', () => {
    const text = ['', '  ', 'QGC WPL 110', row(0, 1, 0, 16, 0, 0, 0, 0, 35.0, 139.0, 0, 1)].join('\n');
    expect(parseMissionFile(text).waypoints).toHaveLength(1);
  });

  it('accepts the space-separated variant some writers produce', () => {
    const text = ['QGC WPL 110', '0 1 0 16 0 0 0 0 35.0 139.0 0 1'].join('\n');
    expect(parseMissionFile(text).waypoints).toHaveLength(1);
  });

  it('rejects a decimal-comma file instead of misreading its coordinates', () => {
    // Mission Planner also splits on commas, so it reads this happily. Here it
    // collapses to a single whitespace-delimited field, which is what the count
    // check catches — the row must not be indexed into either way.
    const text = ['QGC WPL 110', '0,1,0,16,0,0,0,0,35,0,139,0,0,1'].join('\n');
    expect(() => parseMissionFile(text)).toThrow(/expected 12 fields/);
  });

  it('rejects a row with too many fields, not just too few', () => {
    // The count is checked exactly in both directions: a stray extra column
    // shifts every position after it, which misreads rather than fails.
    const text = ['QGC WPL 110', row(0, 1, 0, 16, 0, 0, 0, 0, 35.0, 139.0, 0, 1, 99)].join('\n');
    expect(() => parseMissionFile(text)).toThrow(/expected 12 fields, found 13/);
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

  it('keeps every waypoint when an index repeats part-way through the file', () => {
    // A file is one whole plan, so the log paths' rule — a sequence number back
    // at 0 means a *new* plan, discard the last — must not be applied to it.
    // Left on, the rows before the repeat are all thrown away.
    const text = [
      'QGC WPL 110',
      row(0, 1, 0, 16, 0, 0, 0, 0, 35.0, 139.0, 0, 1),
      row(1, 0, 3, 16, 0, 0, 0, 0, 35.1, 139.0, 50, 1),
      row(2, 0, 3, 16, 0, 0, 0, 0, 35.2, 139.0, 50, 1),
      row(0, 0, 3, 16, 0, 0, 0, 0, 35.3, 139.0, 50, 1),
      row(3, 0, 3, 16, 0, 0, 0, 0, 35.4, 139.0, 50, 1),
    ].join('\n');
    const { waypoints } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1, 2, 3]);
    expect(waypoints[0].lat).toBeCloseTo(35.3, 6); // the repeat overwrites in place
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
    // Qt serialises NaN as null. Only the latitude is null here, deliberately:
    // with both null, reading them as 0 lands on null island and the collector
    // drops it anyway, so the test would pass against exactly the bug it names.
    // With one real value it lands off West Africa instead — visibly plotted.
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [
        { type: 'SimpleItem', command: 16, frame: 3, params: [0, 0, 0, null, null, 139.5, 50], doJumpId: 1 },
        simple(2, 16, 35.002, 139.002, 50),
      ],
    });
    const { waypoints, unreadable } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 2]);
    expect(waypoints.every((w) => w.lon !== 139.5)).toBe(true);
    // A waypoint that belongs on the route but could not be read is reported,
    // not silently missing.
    expect(unreadable).toBe(1);
  });

  it('numbers items by doJumpId, which is not the array index', () => {
    // A complex item consumes a range of sequence numbers, so the numbering
    // skips ahead and later items no longer line up with their array position.
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [simple(1, 22, 35.001, 139.001, 30), simple(9, 16, 35.002, 139.002, 50)],
    });
    expect(parseMissionFile(text).waypoints.map((w) => w.seq)).toEqual([0, 1, 9]);
  });

  it('ignores a sequence number that would sort ahead of home', () => {
    // doJumpId comes from a file QGC need not have written. A negative one
    // would order the route line to start with a leg from nowhere.
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [simple(-1, 16, 36.0, 140.0, 50), simple(2, 16, 35.002, 139.002, 50)],
    });
    const seqs = parseMissionFile(text).waypoints.map((w) => w.seq);
    expect(seqs.every((s) => s >= 0)).toBe(true);
    expect(seqs[0]).toBe(0); // home still leads
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

  it('expands a survey saved under the older top-level type', () => {
    // At survey version 2 the discriminator was the item's own name rather than
    // "ComplexItem". Falling through to the simple-item branch would find no
    // coordinates and lose the entire survey without a word.
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [
        {
          type: 'survey',
          version: 2,
          TransectStyleComplexItem: {
            Items: [simple(1, 16, 35.010, 139.010, 40), simple(2, 16, 35.011, 139.011, 40)],
          },
        },
      ],
    });
    const { waypoints, unreadable } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1, 2]);
    expect(unreadable).toBe(0);
  });

  it('counts a landing pattern, which is a complex item with no stored waypoints', () => {
    // Not a structure scan, so the count must not be described as one — QGC
    // writes five complex types and three of them store geometry, not items.
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [
        simple(1, 16, 35.001, 139.001, 30),
        {
          type: 'ComplexItem',
          complexItemType: 'fwLandingPattern',
          version: 2,
          landCoordinate: [35.02, 139.02, 0],
          landingApproachCoordinate: [35.03, 139.03, 15],
        },
      ],
    });
    const { waypoints, unreadable } = parseMissionFile(text);

    expect(waypoints.map((w) => w.seq)).toEqual([0, 1]);
    expect(unreadable).toBe(1);
  });

  it('counts a transect item that stores an empty waypoint list', () => {
    const text = plan({
      plannedHomePosition: [35.0, 139.0, 0],
      items: [
        simple(1, 16, 35.001, 139.001, 30),
        { type: 'ComplexItem', complexItemType: 'survey', TransectStyleComplexItem: { Items: [] } },
      ],
    });
    expect(parseMissionFile(text).unreadable).toBe(1);
  });

  it('rejects a plan that is nothing but a home position', () => {
    const text = plan({ plannedHomePosition: [35.0, 139.0, 0], items: [] });
    expect(() => parseMissionFile(text)).toThrow(/no waypoints/i);
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
