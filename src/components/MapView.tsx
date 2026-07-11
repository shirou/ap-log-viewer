import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map, useControl, type MapLayerMouseEvent, type MapRef } from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useLogStore } from '../store/logStore.ts';
import { positionAt } from '../lib/series.ts';

// Raster base maps (no API key required). OpenSeaMap is a transparent overlay.
const BASES = {
  osm: {
    label: 'OpenStreetMap',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
  topo: {
    label: 'OpenTopoMap',
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
    ],
    maxzoom: 17,
    attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
  },
} as const;
type BaseKey = keyof typeof BASES;

function makeStyle(base: BaseKey, seamark: boolean): StyleSpecification {
  const b = BASES[base];
  const style: StyleSpecification = {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: b.tiles as unknown as string[], tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
  if (seamark) {
    style.sources.seamark = {
      type: 'raster',
      tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenSeaMap contributors',
    };
    style.layers.push({ id: 'seamark', type: 'raster', source: 'seamark' });
  }
  return style;
}

// Up-pointing (north) arrow; `mask:true` lets getColor tint it. getAngle then
// rotates it to the vehicle heading.
const CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><polygon points="12,1 22,23 12,18 2,23" fill="#000"/></svg>';
const CURSOR_ICON = {
  url: `data:image/svg+xml;base64,${btoa(CURSOR_SVG)}`,
  width: 24,
  height: 24,
  anchorX: 12,
  anchorY: 12,
  mask: true,
};

function DeckGLOverlay(props: MapboxOverlayProps) {
  const overlay = useControl(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function spanToZoom(lonSpan: number, latSpan: number): number {
  const span = Math.max(lonSpan, latSpan, 1e-4);
  return Math.min(18, Math.max(2, Math.log2(360 / span) - 0.5));
}

const R_EARTH = 6371000;
function haversine(a: [number, number], b: [number, number]): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
function fmtDist(m: number): string {
  return m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`;
}

export default function MapView() {
  const log = useLogStore((s) => s.log);
  const loadId = useLogStore((s) => s.loadId);
  const cursorTime = useLogStore((s) => s.cursorTime);

  const traj = log?.trajectory;

  const [base, setBase] = useState<BaseKey>('osm');
  const [seamark, setSeamark] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [points, setPoints] = useState<[number, number][]>([]);
  // Index of the vertex currently being dragged, or null. hoverVertex drives the
  // cursor so grabbable points are discoverable.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverVertex, setHoverVertex] = useState(false);
  const mapRef = useRef<MapRef>(null);
  const didDragRef = useRef(false);
  // maplibre fires `click` right after a vertex drag/remove; skip that one add.
  const suppressClickRef = useRef(false);

  const mapStyle = useMemo(() => makeStyle(base, seamark), [base, seamark]);

  const initialViewState = useMemo(() => {
    if (!traj || traj.lat.length === 0) {
      return { longitude: 0, latitude: 20, zoom: 1.5 };
    }
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < traj.lat.length; i++) {
      minLat = Math.min(minLat, traj.lat[i]);
      maxLat = Math.max(maxLat, traj.lat[i]);
      minLon = Math.min(minLon, traj.lon[i]);
      maxLon = Math.max(maxLon, traj.lon[i]);
    }
    return {
      longitude: (minLon + maxLon) / 2,
      latitude: (minLat + maxLat) / 2,
      zoom: spanToZoom(maxLon - minLon, maxLat - minLat),
    };
  }, [traj]);

  // Path layer is expensive (copies the whole trajectory); rebuild only on new data.
  const pathLayer = useMemo(() => {
    if (!traj || traj.lat.length === 0) return null;
    const path: [number, number][] = [];
    for (let i = 0; i < traj.lat.length; i++) path.push([traj.lon[i], traj.lat[i]]);
    return new PathLayer({
      id: 'trajectory',
      data: [{ path }],
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: [79, 209, 197],
      getWidth: 3,
      widthUnits: 'pixels',
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
    });
  }, [traj]);

  // Only the single-point cursor marker rebuilds per frame. It's a triangle
  // pointing along the vehicle heading (degrees CW from north); deck's getAngle
  // is CCW so we negate. NaN heading (no source) leaves it pointing up/north.
  const cursorLayer = useMemo(() => {
    if (!traj || traj.lat.length === 0) return null;
    const pos = positionAt(traj, cursorTime);
    if (!pos) return null;
    return new IconLayer({
      id: 'cursor',
      data: [pos],
      getIcon: () => CURSOR_ICON,
      getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
      getAngle: (d: { heading: number }) => (Number.isFinite(d.heading) ? -d.heading : 0),
      getSize: 34,
      sizeUnits: 'pixels',
      getColor: [246, 173, 85],
      billboard: true,
    });
  }, [traj, cursorTime]);

  // Distance-ruler layers: line, draggable vertices, and cumulative labels.
  const measureLayers = useMemo(() => {
    if (points.length === 0) return [];
    const labels = points.map((p, i) => {
      let cum = 0;
      for (let k = 1; k <= i; k++) cum += haversine(points[k - 1], points[k]);
      return { position: p, text: i === 0 ? '0' : fmtDist(cum) };
    });
    return [
      points.length >= 2 &&
        new PathLayer({
          id: 'measure-line',
          data: [{ path: points }],
          getPath: (d: { path: [number, number][] }) => d.path,
          getColor: [255, 99, 99],
          getWidth: 2,
          widthUnits: 'pixels',
          widthMinPixels: 2,
        }),
      // Solid white dots with a red ring — the draggable/removable vertices.
      new ScatterplotLayer({
        id: 'measure-pts',
        data: points,
        getPosition: (d: [number, number]) => d,
        getFillColor: [255, 255, 255],
        getLineColor: [255, 99, 99],
        lineWidthMinPixels: 2,
        stroked: true,
        getRadius: 6,
        radiusUnits: 'pixels',
      }),
      new TextLayer({
        id: 'measure-labels',
        data: labels,
        getPosition: (d: { position: [number, number] }) => d.position,
        getText: (d: { text: string }) => d.text,
        getSize: 12,
        getColor: [255, 255, 255],
        getPixelOffset: [0, -14],
        background: true,
        getBackgroundColor: [180, 30, 30, 220],
        backgroundPadding: [4, 2],
      }),
    ].filter(Boolean);
  }, [points]);

  const layers = useMemo(
    () => [pathLayer, cursorLayer, ...measureLayers].filter(Boolean),
    [pathLayer, cursorLayer, measureLayers],
  );

  const totalDist = useMemo(() => {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
    return d;
  }, [points]);

  // Pixel-space hit test: returns the index of the vertex under (x, y), or -1.
  const HIT_PX = 12;
  const vertexAt = useCallback(
    (map: MapLayerMouseEvent['target'], x: number, y: number) => {
      for (let i = points.length - 1; i >= 0; i--) {
        const sp = map.project(points[i]);
        if (Math.hypot(sp.x - x, sp.y - y) <= HIT_PX) return i;
      }
      return -1;
    },
    [points],
  );

  const onMapMouseDown = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!measuring) return;
      const idx = vertexAt(e.target, e.point.x, e.point.y);
      if (idx < 0) return; // empty map: leave pan enabled; the click adds a point
      e.target.dragPan.disable();
      didDragRef.current = false;
      setDragIdx(idx);
    },
    [measuring, vertexAt],
  );

  const onMapMouseMove = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!measuring) return;
      if (dragIdx != null) {
        didDragRef.current = true;
        const { lng, lat } = e.lngLat;
        setPoints((p) => {
          const np = p.slice();
          np[dragIdx] = [lng, lat];
          return np;
        });
        return;
      }
      setHoverVertex(vertexAt(e.target, e.point.x, e.point.y) >= 0);
    },
    [measuring, dragIdx, vertexAt],
  );

  const onMapMouseUp = useCallback(
    (e: MapLayerMouseEvent) => {
      if (dragIdx == null) return;
      e.target.dragPan.enable();
      // A press-release on a vertex without dragging removes it (like Google Maps).
      if (!didDragRef.current) {
        const idx = dragIdx;
        setPoints((p) => p.filter((_, i) => i !== idx));
      }
      suppressClickRef.current = true;
      setDragIdx(null);
    },
    [dragIdx],
  );

  // Safety net: if the mouse is released off the map, still end the drag and
  // re-enable panning so the map can't get stuck.
  useEffect(() => {
    if (dragIdx == null) return;
    const end = () => {
      mapRef.current?.getMap().dragPan.enable();
      suppressClickRef.current = true;
      setDragIdx(null);
    };
    window.addEventListener('mouseup', end);
    return () => window.removeEventListener('mouseup', end);
  }, [dragIdx]);

  const onMapClick = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!measuring) return;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      setPoints((p) => [...p, [e.lngLat.lng, e.lngLat.lat]]);
    },
    [measuring],
  );

  return (
    <div className="map-wrap">
      <Map
        key={loadId}
        ref={mapRef}
        initialViewState={initialViewState}
        mapStyle={mapStyle}
        onClick={onMapClick}
        onMouseDown={onMapMouseDown}
        onMouseMove={onMapMouseMove}
        onMouseUp={onMapMouseUp}
        cursor={
          !measuring ? undefined : dragIdx != null ? 'grabbing' : hoverVertex ? 'move' : 'crosshair'
        }
      >
        <DeckGLOverlay layers={layers} />
      </Map>

      <div className="map-controls">
        <label>
          Map
          <select value={base} onChange={(e) => setBase(e.target.value as BaseKey)}>
            {Object.entries(BASES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label title="Overlay OpenSeaMap nautical chart symbols">
          <input type="checkbox" checked={seamark} onChange={(e) => setSeamark(e.target.checked)} />
          Nautical chart (OpenSeaMap)
        </label>
        <button
          className={measuring ? 'primary' : ''}
          onClick={() => {
            setMeasuring((m) => !m);
            if (measuring) {
              setPoints([]);
              setDragIdx(null);
              setHoverVertex(false);
            }
          }}
        >
          📏 Measure distance{measuring ? ' (on)' : ''}
        </button>
        {measuring && (
          <div className="measure-readout">
            <div>
              Total: <b>{fmtDist(totalDist)}</b> ({points.length} points)
            </div>
            <div className="measure-actions">
              <button onClick={() => setPoints((p) => p.slice(0, -1))} disabled={!points.length}>
                Undo
              </button>
              <button onClick={() => setPoints([])} disabled={!points.length}>
                Clear
              </button>
            </div>
            <div className="plot-hint">Click to add</div>
          </div>
        )}
      </div>

      {traj && traj.lat.length === 0 && (
        <div className="legend">This log has no position data (GPS/POS)</div>
      )}
    </div>
  );
}
