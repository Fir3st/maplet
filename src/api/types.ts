/**
 * Public data types of the Maplet API.
 *
 * Coordinates:
 * - `GeoPosition` is a geographic position in degrees. It is used by geographic CRS
 *   (Web Mercator, EPSG:4326, EPSG:3395).
 * - `PlanarPosition` is a position in the planar units of the Simple CRS. It is not
 *   interchangeable with `GeoPosition`.
 * - `ScreenPoint` is a CSS pixel in container space (y grows downward).
 * - `WorldPoint` is Maplet's canonical projected coordinate at zoom 0 (scale 256),
 *   internal to the math modules. It is never ambiguous with degrees or planar units.
 */

export type FeatureId = string | number;

export interface GeoPosition {
  readonly lat: number;
  readonly lng: number;
  readonly altitude?: number;
}

export interface PlanarPosition {
  readonly x: number;
  readonly y: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** Position accepted by the public API for the map's CRS. */
export type Position = GeoPosition | PlanarPosition;

export function isGeoPosition(value: unknown): value is GeoPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GeoPosition).lat === 'number' &&
    typeof (value as GeoPosition).lng === 'number'
  );
}

export function isPlanarPosition(value: unknown): value is PlanarPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PlanarPosition).x === 'number' &&
    typeof (value as PlanarPosition).y === 'number'
  );
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export interface PointGeometry<P = GeoPosition> {
  readonly type: 'point';
  readonly position: P;
}

export interface MultiPointGeometry<P = GeoPosition> {
  readonly type: 'multiPoint';
  readonly positions: readonly P[];
}

export interface LineStringGeometry<P = GeoPosition> {
  readonly type: 'lineString';
  readonly positions: readonly P[];
}

export interface MultiLineStringGeometry<P = GeoPosition> {
  readonly type: 'multiLineString';
  readonly lines: readonly (readonly P[])[];
}

/** First ring is the outer ring, all following rings are holes. */
export interface PolygonGeometry<P = GeoPosition> {
  readonly type: 'polygon';
  readonly rings: readonly (readonly P[])[];
}

export interface MultiPolygonGeometry<P = GeoPosition> {
  readonly type: 'multiPolygon';
  readonly polygons: readonly (readonly (readonly P[])[])[];
}

export type CircleUnit = 'meters' | 'planarUnits';

export interface CircleGeometry<P = GeoPosition> {
  readonly type: 'circle';
  readonly center: P;
  readonly radius: number;
  readonly unit: CircleUnit;
}

export interface RectangleGeometry<P = GeoPosition> {
  readonly type: 'rectangle';
  readonly southwest: P;
  readonly northeast: P;
}

export type Geometry<P = GeoPosition> =
  | PointGeometry<P>
  | MultiPointGeometry<P>
  | LineStringGeometry<P>
  | MultiLineStringGeometry<P>
  | PolygonGeometry<P>
  | MultiPolygonGeometry<P>
  | CircleGeometry<P>
  | RectangleGeometry<P>;

export type GeometryType = Geometry['type'];

/** Geometry that occupies an area or a line (indexed by bounding box, not by a point). */
export type BoundsGeometry<P = GeoPosition> =
  | LineStringGeometry<P>
  | MultiLineStringGeometry<P>
  | PolygonGeometry<P>
  | MultiPolygonGeometry<P>
  | RectangleGeometry<P>;

export type FeatureProperties = Readonly<Record<string, unknown>>;

/* -------------------------------------------------------------------------- */
/* Identity and references                                                     */
/* -------------------------------------------------------------------------- */

declare const featureTypes: unique symbol;

/**
 * A stable reference to one feature. It is a plain readonly record: safe to store in
 * a reactive reference, to wrap in a transparent proxy or to detach a method from.
 * Validity is decided by `sceneId` + `sourceId` +
 * `namespace` + `id` + `generation`, never by object identity.
 */
export interface FeatureRef<G = Geometry, P = FeatureProperties> {
  readonly sceneId: string;
  readonly sourceId: string;
  readonly namespace?: string;
  readonly id: FeatureId;
  readonly generation: number;
  readonly [featureTypes]?: { readonly geometry: G; readonly properties: P };
}

export interface FeatureSnapshot<G = Geometry, P = FeatureProperties> {
  readonly ref: FeatureRef<G, P>;
  readonly geometry: G;
  readonly properties: Readonly<P>;
}

export interface Commit {
  readonly revision: number;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export type Unsubscribe = () => void;

export interface SubscribeOptions {
  readonly signal?: AbortSignal;
}

export interface ViewChangeEvent {
  readonly type: 'viewchange' | 'viewstart' | 'viewend';
  readonly snapshot: ViewSnapshotLike;
}

/**
 * Structural view snapshot used by events. Keeps `ViewSnapshot` and event payloads
 * compatible without a circular import between api and view modules.
 */
export interface ViewSnapshotLike {
  readonly center: Position;
  readonly zoom: number;
  readonly revision: number;
  readonly size: { readonly width: number; readonly height: number };
}

export type BackendKind = 'webgpu' | 'webgl1' | 'none';

export type FeatureEventType =
  | 'click'
  | 'mouseover'
  | 'mouseout'
  | 'mousemove'
  | 'dragstart'
  | 'drag'
  | 'dragend';

/** Feature-level interaction event with references, positions and revision. */
export interface MapFeatureEvent {
  readonly type: FeatureEventType;
  readonly feature: FeatureRef;
  readonly layerId: string;
  readonly sourceId: string;
  readonly position: Position;
  readonly screen: ScreenPoint;
  readonly revision: number;
  readonly originalEvent: Event;
  /**
   * Stops delivery to the next bubbling level (layer -> group(s) -> map).
   * It never affects map gestures, which are resolved separately (EVENT-02).
   */
  stopPropagation(): void;
  /** True after `stopPropagation()` was called (EVENT-01/02). */
  readonly propagationStopped: boolean;
}

export type PointerEventType = 'move' | 'movestart' | 'moveend' | 'click';

/** Map-level pointer event for background interaction (no feature hit). */
export interface MapPointerEvent {
  readonly type: PointerEventType;
  readonly position: Position;
  readonly screen: ScreenPoint;
  readonly originalEvent: Event;
}

export interface Capabilities {
  /** Backend that is actually active. */
  readonly backend: BackendKind | 'custom' | 'unavailable';
  /** Backend requested by configuration. */
  readonly requestedPrimary: BackendKind;
  /** Fallback requested by configuration; `false` when disabled. */
  readonly requestedFallback: BackendKind | false;
  /** Capability notes reported at initialization (extensions, precision, limits). */
  readonly notes: readonly string[];
}

export interface MapStats {
  readonly revision: number;
  readonly renderedRevision: number;
  readonly sources: number;
  readonly layers: number;
  readonly features: number;
  readonly drawCalls: number;
  readonly instances: number;
  readonly renderedInstances: number;
  readonly gpuBytes: number;
  readonly frames: number;
  /** Measured main-thread stall of GPU picking (PICK-12). */
  readonly picking: PickStallStats;
}

/**
 * Measured main-thread stall of GPU picking (PICK-12).
 *
 * Picking renders a pick pass and reads back a small pixel window. On WebGL 1
 * that readback is a synchronous `readPixels`: the Promise returned by the pick
 * API does not make it non-blocking, so these fields report the measured
 * blocking time on the calling thread instead of implying a background read.
 * A WebGPU readback is submitted and awaited (`mapAsync`); only the synchronous
 * section of the call stalls, and the wait appears as promise latency.
 */
export interface PickStallStats {
  /** Number of picks measured since the map was created. */
  readonly picks: number;
  /** Main-thread blocking span of the most recent pick (ms). */
  readonly lastMs: number;
  /** Largest main-thread blocking span observed (ms). */
  readonly maxMs: number;
  /**
   * Blocking readback portion of the most recent pick (ms). On WebGL 1 this is
   * the `readPixels` call; on WebGPU only the synchronous submission, because
   * the wait happens across awaits.
   */
  readonly lastReadMs: number;
  /** Largest blocking readback portion observed (ms). */
  readonly maxReadMs: number;
  /** Sum of all blocking spans since the map was created (ms). */
  readonly totalMs: number;
  /**
   * Readback semantics of the active backend: `'blocking'` waits for the
   * pixels on the calling thread (WebGL 1 `readPixels`), `'async'` waits across
   * awaits (WebGPU `mapAsync`), `'none'` before a GPU backend is active.
   */
  readonly readback: 'blocking' | 'async' | 'none';
}

export function featureRefKey(ref: Pick<FeatureRef, 'namespace' | 'id'>): string {
  const ns = ref.namespace ?? '';
  return `${ns}\u0000${typeof ref.id}:${le(ref.id)}`;
}

export function featureIdKey(id: FeatureId, namespace?: string): string {
  const ns = namespace ?? '';
  return `${ns}\u0000${typeof id}:${le(id)}`;
}

function le(id: FeatureId): string {
  return typeof id === 'number' ? String(id) : id;
}
