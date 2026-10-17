/**
 * Compile-time contract tests (TYPE-01..TYPE-07).
 *
 * These files are checked by `tsc -p tsconfig.type-tests.json`; they are never
 * executed. `@ts-expect-error` lines prove the negative cases: the error must
 * occur for the marked reason, so a public API that becomes permissive fails the
 * build. TYPE-08 (the same contract through the *published* declarations and
 * subpaths) lives in `consumer.test.ts`.
 */

import {
  createMap,
  crs,
  style as expr,
  isMapletError,
  MapletError,
  type Commit,
  type FeatureRef,
  type GeoPosition,
  type MapletErrorCode,
  type PlanarPosition,
  type PointGeometry,
  type PolygonGeometry,
} from '../src/index.ts';
import type { VectorSourceHandle } from '../src/index.ts';

interface StationProperties extends Record<string, unknown> {
  readonly name: string;
  readonly status: 'online' | 'offline';
}

export async function typeContracts(container: HTMLElement): Promise<void> {
  const map = await createMap(container, { renderer: { primary: 'webgl1', fallback: false } });

  // TYPE-01: typed source keeps geometry and property generics through the API.
  const stations = map.data.vector<PointGeometry, StationProperties>({ id: 'stations' });
  const snapshot = stations.features.get('a');
  if (snapshot) {
    const position: GeoPosition = snapshot.geometry.position;
    const name: string = snapshot.properties.name;
    void position;
    void name;
  }
  const ref: FeatureRef<PointGeometry, StationProperties> = stations.features.ref('a');
  map.state.set(ref, { selected: true });

  // Typed expressions: a string field cannot be used where a number is required.
  const status = expr.field<'status', 'online' | 'offline'>('status');
  const color = expr.match(status, { online: '#16a34a', offline: '#dc2626' }, '#6b7280');
  map.addLayer({
    id: 'typed',
    type: 'points',
    source: stations,
    style: { color },
  });

  // @ts-expect-error radiusPx is a number expression; a string field must be rejected (TYPE-02/03).
  map.addLayer({ id: 'bad-radius', type: 'points', source: stations, style: { radiusPx: status } });

  // @ts-expect-error status only accepts its two literal values (TYPE-02).
  stations.features.update('a', { properties: { status: 'paused' } });

  // A typed ref cannot be passed into a source with an incompatible shape (TYPE-04).
  const ships = map.data.vector<PointGeometry, { readonly name: number }>({ id: 'ships' });
  // @ts-expect-error the ref carries StationProperties, not { name: number }
  ships.features.update(ref, { properties: { name: 1 } });
  void ships;

  // Planar positions are not geographic: the CRS position kinds are distinct.
  const planar: PlanarPosition = { x: 1, y: 2 };
  const geographic: GeoPosition = { lat: 1, lng: 2 };
  // @ts-expect-error a PlanarPosition is not a GeoPosition (TYPE-03)
  const wrong: GeoPosition = planar;
  void wrong;
  void geographic;

  // Public snapshots are readonly.
  if (snapshot) {
    // @ts-expect-error properties snapshots are readonly (TYPE-06)
    snapshot.properties.name = 'changed';
  }

  // Detached methods keep their types without a receiver (TYPE-07).
  const setView = map.setView.bind(map);
  const commit = setView({ zoom: 5 });
  void commit.revision;

  // Custom CRS spec requires both directions.
  crs.define({
    code: 'TYPE:TEST',
    positionKind: 'planar',
    toWorld: (position) => ({
      x: (position as PlanarPosition).x,
      y: (position as PlanarPosition).y,
    }),
    fromWorld: (world) => ({ x: world.x, y: world.y }),
  });
  // @ts-expect-error missing fromWorld violates CustomCrsSpec
  crs.define({ code: 'TYPE:BROKEN', positionKind: 'planar', toWorld: () => ({ x: 0, y: 0 }) });

  const handle: VectorSourceHandle<PointGeometry, StationProperties> = stations;
  void handle;

  // TYPE-05: event payloads discriminate and unknown names/fields fail to compile.
  const stopFeature = map.onFeature((event) => {
    const kind:
      'click' | 'mouseover' | 'mouseout' | 'mousemove' | 'dragstart' | 'drag' | 'dragend' =
      event.type;
    const hitId: string | number = event.feature.id;
    const screen: { readonly x: number; readonly y: number } = event.screen;
    event.stopPropagation();
    const stopped: boolean = event.propagationStopped;
    void kind;
    void hitId;
    void screen;
    void stopped;
  });
  stopFeature();
  map.on('commit', (event) => {
    const revision: number = event.revision;
    void revision;
  });
  map.on('backend', (event) => {
    const backend: 'webgpu' | 'webgl1' | 'none' | 'unavailable' = event.backend;
    void backend;
  });
  // @ts-expect-error event names are a closed set (TYPE-05)
  map.on('frame', () => {});
  // @ts-expect-error the commit payload has no selected field (TYPE-05)
  map.on('commit', (event) => void event.selected);

  const failureCode = (error: unknown): MapletErrorCode | 'unknown' => {
    if (!isMapletError(error)) return 'unknown';
    if (error instanceof MapletError && error.code === 'import-invalid') {
      const revision = error.detail.revision;
      return typeof revision === 'number' ? error.code : error.code;
    }
    return error.code;
  };
  void failureCode;
  const knownCode = (error: MapletError): boolean => {
    // @ts-expect-error the error-code union closes over known codes only (TYPE-05)
    return error.code === 'not-a-code';
  };
  void knownCode;

  const located = await map.locate({ setView: true });
  if (located.ok) {
    const accuracy: number = located.position.accuracy;
    void accuracy;
  } else {
    const code: 'permission' | 'timeout' | 'unavailable' | 'unsupported' = located.code;
    void code;
    // @ts-expect-error a failed locate result carries no position (TYPE-05)
    void located.position;
  }

  // TYPE-06: readonly snapshots, exact optional properties and unchecked index.
  const withoutAltitude: GeoPosition = { lat: 0, lng: 0 };
  void withoutAltitude;
  // @ts-expect-error altitude is a number when present, never an explicit undefined (TYPE-06)
  const explicitAltitude: GeoPosition = { lat: 0, lng: 0, altitude: undefined };
  void explicitAltitude;
  if (snapshot) {
    // @ts-expect-error properties snapshots are readonly (TYPE-06)
    snapshot.properties.name = 'changed';
    // @ts-expect-error geometry snapshots are readonly too (TYPE-06)
    snapshot.geometry.position.lat = 0;
  }
  const areas = map.data.vector<PolygonGeometry>({ id: 'areas' });
  const area = areas.features.get('area');
  if (area) {
    // @ts-expect-error rings[0] may be missing; guard before use (TYPE-06)
    const firstRing: readonly GeoPosition[] = area.geometry.rings[0];
    void firstRing;
    const guarded = area.geometry.rings[0];
    if (guarded) {
      const first: GeoPosition = guarded[0] ?? { lat: 0, lng: 0 };
      void first;
    }
  }
  const viewBounds = map.getBounds();
  // @ts-expect-error bounds are null until the view has a size (TYPE-06)
  void viewBounds.southwest;

  // TYPE-07: detached methods keep their types without a receiver.
  const addStation = stations.features.add.bind(stations.features);
  const added = addStation({ id: 'b', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  const addedRef: FeatureRef<PointGeometry, StationProperties> = added.refs[0]!;
  void addedRef;
  const importColumnar = stations.importColumnar.bind(stations);
  const columnar: Commit = await importColumnar({
    kind: 'point',
    positions: Float64Array.of(14, 50),
  });
  void columnar.revision;
  const offCommit = map.on('commit', () => {});
  offCommit();
  // @ts-expect-error a detached typed method keeps its parameter contract (TYPE-07)
  addStation({ geometry: { type: 'point', position: { x: 1, y: 2 } } });
}
