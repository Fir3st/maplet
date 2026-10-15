/**
 * Consumer contract tests against the published declarations (TYPE-08).
 *
 * The imports below use the package specifiers — `maplet`, `maplet/math`,
 * `maplet/formats` — resolved by `tsconfig.type-tests.json` to `dist/*.d.ts`,
 * never to src internals. The built declaration surface must therefore expose
 * the same contract a consumer gets through the root entry and the declared
 * subpaths: generics, event/result narrowing, readonly snapshots, exact
 * optional properties and detached methods. `@ts-expect-error` lines are the
 * negative cases; a declaration that becomes permissive fails `npm run check`.
 */

import {
  createMap,
  style as expr,
  isMapletError,
  type ColumnarBatch,
  type FeatureRef,
  type GeoPosition,
  type PointGeometry,
  type Position,
  type VectorSourceHandle,
} from '@fir3st/maplet';
import { boundsFromPositions, crs, type Bounds } from '@fir3st/maplet/math';
import { parseGeoJson, type GeoJsonFeatureCollection } from '@fir3st/maplet/formats';

interface StationProperties extends Record<string, unknown> {
  readonly name: string;
  readonly status: 'online' | 'offline';
}

export async function consumerContracts(container: HTMLElement): Promise<void> {
  const map = await createMap(container, { renderer: { primary: 'webgl1', fallback: false } });
  const stations: VectorSourceHandle<PointGeometry, StationProperties> = map.data.vector({
    id: 'stations',
  });

  // Typed reads and refs survive the published declarations (TYPE-01/04/08).
  const snapshot = stations.features.get('a');
  if (snapshot) {
    const position: GeoPosition = snapshot.geometry.position;
    const name: string = snapshot.properties.name;
    void position;
    void name;
    // @ts-expect-error snapshots are readonly (TYPE-06)
    snapshot.properties.status = 'offline';
  }
  const ref: FeatureRef<PointGeometry, StationProperties> = stations.features.ref('a');
  void ref;

  // The columnar import contract is part of the published root surface.
  const batch: ColumnarBatch = {
    kind: 'point',
    positions: Float64Array.of(14, 50),
    ids: ['a'],
  };
  const imported = await stations.importColumnar(batch);
  void imported.revision;

  // MEDIA-07: media placements take a rotation option, expose it in the
  // readonly snapshot and accept descriptor updates.
  const overlay = map.data.image({
    id: 'overlay',
    url: '/images/overlay.png',
    bounds: { southwest: { lat: 50, lng: 14 }, northeast: { lat: 50.1, lng: 14.1 } },
    rotate: 15,
  });
  const overlayRotation: number = overlay.snapshot().rotate;
  overlay.update({ rotate: 30 });
  overlay.update({ bounds: { southwest: { lat: 50, lng: 14 }, northeast: { lat: 50.2, lng: 14.2 } } });
  void overlayRotation;
  // @ts-expect-error rotation is a number of degrees, not a string (MEDIA-07)
  overlay.update({ rotate: '30' });

  // MARKER-01: markers take a position, icon/appearance options and
  // tooltip/popup content, and expose the Leaflet-style handle methods.
  const marker = map.addMarker({
    position: { lat: 50.08, lng: 14.42 },
    tooltip: 'Depot',
    popup: { content: 'Depot A', autoPan: true },
  });
  const markerId = marker.id;
  const markerPosition: Position = marker.getPosition();
  marker.setPosition({ lat: 50.081, lng: 14.421 });
  marker.setTooltip({ content: 'Depot A', permanent: true });
  marker.setPopup('Details as plain text');
  marker.openPopup();
  const popupElement: HTMLElement | null = marker.popupElement();
  marker.on('click', (event) => { const ref: FeatureRef = event.feature; void ref; });
  void markerId;
  void markerPosition;
  void popupElement;
  const markerBatch = map.addMarkers([
    { position: { lat: 50.09, lng: 14.43 } },
    { position: { lat: 50.1, lng: 14.44 }, tooltip: 'Druhý' },
  ]);
  void markerBatch.length;
  // @ts-expect-error markers require a position (MARKER-01)
  map.addMarker({ id: 'no-position' });

  // PICK-12: the measured pick stall is part of the diagnostics contract.
  const picking = map.stats().picking;
  const lastStallMs: number = picking.lastMs;
  const readback: 'blocking' | 'async' | 'none' = picking.readback;
  void lastStallMs;
  void readback;
  // @ts-expect-error measurements are readonly (TYPE-06/08)
  picking.lastMs = 0;

  // TYPE-05: event payloads and typed results narrow through the published names.
  const stopFeature = map.onFeature((event) => {
    const kind: 'click' | 'mouseover' | 'mouseout' | 'mousemove' | 'dragstart' | 'drag' | 'dragend' = event.type;
    const hit: string | number = event.feature.id;
    event.stopPropagation();
    void kind;
    void hit;
  });
  stopFeature();
  // @ts-expect-error event names are a closed set (TYPE-05)
  map.on('frame', () => {});
  const located = await map.locate({ setView: true });
  if (located.ok) {
    const accuracy: number = located.position.accuracy;
    void accuracy;
  } else {
    // @ts-expect-error a failed locate result carries no position (TYPE-05)
    void located.position;
  }
  try {
    void 0;
  } catch (error) {
    if (isMapletError(error)) {
      const code: string = error.code;
      if (error.code === 'invalid-argument') {
        const detail: Readonly<Record<string, unknown>> = error.detail;
        void detail;
      }
      void code;
    }
  }

  // TYPE-06: exact optional properties stay exact through the .d.ts.
  // @ts-expect-error altitude is a number when present, never an explicit undefined (TYPE-06)
  const explicitAltitude: GeoPosition = { lat: 0, lng: 0, altitude: undefined };
  void explicitAltitude;

  // TYPE-07: detached methods need no receiver and keep their parameter contract.
  const setView = map.setView;
  const commit = setView({ zoom: 4 });
  void commit.revision;
  const update = stations.features.update;
  update(ref, { properties: { status: 'online' } });
  // @ts-expect-error the detached typed method still rejects an unknown literal (TYPE-07)
  update(ref, { properties: { status: 'paused' } });

  // TYPE-08: the declared subpaths (`maplet/math`, `maplet/formats`) are usable
  // on their own, without the root entry.
  const simple = crs.simple();
  const world = simple.toWorld({ x: 1, y: 2 });
  const worldX: number = world.x;
  const roundTrip: Position = simple.fromWorld(world);
  const bounds: Bounds<Position> | null = boundsFromPositions([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]);
  void worldX;
  void roundTrip;
  void bounds;
  const parsed = parseGeoJson({ type: 'FeatureCollection', features: [] }, { sourceId: 'stations' });
  const first = parsed[0];
  void first;
  const collection: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
  void collection;
  // @ts-expect-error parseGeoJson takes GeoJSON text or an object, never a number (TYPE-08)
  parseGeoJson(42);

  // Expressions and layers keep their generics through the published surface.
  const style = expr.field<'status', 'online' | 'offline'>('status');
  const statusColor = expr.match(style, { online: '#16a34a', offline: '#dc2626' }, '#6b7280');
  map.addLayer({
    id: 'typed',
    type: 'points',
    source: stations,
    style: { color: statusColor, iconTint: statusColor },
  });
  // @ts-expect-error radiusPx is a number expression; a string field is rejected (TYPE-02/08)
  map.addLayer({ id: 'bad', type: 'points', source: stations, style: { radiusPx: style } });
  // @ts-expect-error iconTint is a color expression; a numeric zoom field is rejected (TYPE-02/08)
  map.addLayer({ id: 'bad-tint', type: 'points', source: stations, style: { iconTint: expr.zoom() } });
}
