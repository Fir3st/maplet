import { assertArgument, fail } from './errors.ts';
import type { Commit, FeatureId, FeatureProperties, FeatureRef, FeatureSnapshot, Geometry, LineStringGeometry, PointGeometry, PolygonGeometry, Position, Unsubscribe } from './types.ts';
import { normalizePosition, type PositionInput } from './coordinates.ts';
import { featureEvents, type FeatureEvents } from './feature-events.ts';
import type { Crs } from '../math/crs.ts';
import type { MapEngine, LayerHandle as EngineLayer } from '../map-engine.ts';
import type { Filter } from '../scene/expression.ts';
import type { FeatureOverride, LayerKind, LayerStyleMap, MoveTarget } from '../scene/layers.ts';
import type { CommitWithRefs, FeatureInput, FeaturePatch, VectorSourceHandle } from '../scene/source.ts';

export interface PointInput<P = FeatureProperties> {
  readonly id?: FeatureId;
  readonly namespace?: string;
  readonly position: PositionInput;
  readonly properties?: P;
}

export interface LineInput<P = FeatureProperties> {
  readonly id?: FeatureId;
  readonly namespace?: string;
  readonly positions: readonly PositionInput[];
  readonly properties?: P;
}

export interface PolygonInput<P = FeatureProperties> {
  readonly id?: FeatureId;
  readonly namespace?: string;
  /** Outer ring first, followed by holes. */
  readonly rings: readonly (readonly PositionInput[])[];
  readonly properties?: P;
}

export interface ObjectOptions<K extends LayerKind = LayerKind> {
  readonly id?: string;
  /** Human-readable name for layer controls; defaults to the id. */
  readonly label?: string;
  readonly style?: LayerStyleMap[K];
  readonly filter?: Filter | null;
  readonly namespace?: string;
  readonly visible?: boolean;
  readonly interactive?: boolean;
  readonly draggable?: boolean;
  /** Logical layer id; normally supplied by the receiving layer. */
  readonly parent?: string;
}

/** A styled collection/render pass inside a logical layer, not a container. */
export interface RenderLayerHandle<K extends LayerKind = LayerKind> extends FeatureEvents {
  readonly id: string;
  readonly kind: K;
  readonly sourceId: string;
  readonly parentId: string | null;
  readonly removed: boolean;
  show(): void;
  hide(): void;
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  setStyle(style: LayerStyleMap[K]): void;
  update(options: Omit<ObjectOptions<K>, 'id' | 'parent'>): void;
  setFilter(filter: Filter | null): void;
  setFeatureStyle(target: FeatureRef | FeatureId, style: FeatureOverride): void;
  clearFeatureStyle(target: FeatureRef | FeatureId): void;
  getFeatureStyle(target: FeatureRef | FeatureId): FeatureOverride | undefined;
  hasFeatureStyle(target: FeatureRef | FeatureId): boolean;
  move(target: MoveTarget): void;
  remove(): void;
}

export interface FeatureHandle<G = Geometry<Position>, P = FeatureProperties> extends FeatureEvents {
  readonly id: FeatureId;
  readonly ref: FeatureRef<G, P>;
  readonly removed: boolean;
  get(): FeatureSnapshot<G, P>;
  setGeometry(geometry: G): Commit;
  setProperties(properties: Partial<P>): Commit;
  setStyle(style: FeatureOverride): void;
  clearStyle(): void;
  show(): void;
  hide(): void;
  select(): void;
  deselect(): void;
  remove(): Commit;
}

export interface PointHandle<P = FeatureProperties> extends FeatureHandle<PointGeometry<Position>, P> {
  getPosition(): Position;
  setPosition(position: PositionInput): Commit;
}

export interface VectorLayerHandle<G = Geometry<Position>, P = FeatureProperties, K extends LayerKind = LayerKind> extends RenderLayerHandle<K> {
  readonly source: VectorSourceHandle<G, P>;
  get(id: FeatureId): FeatureHandle<G, P> | undefined;
  add(feature: FeatureInput<G, P>): FeatureHandle<G, P>;
  addMany(features: readonly FeatureInput<G, P>[]): CommitWithRefs<G, P>;
  updateFeature(id: FeatureId | FeatureRef<G, P>, patch: FeaturePatch<G, P>): Commit;
  setData(features: readonly FeatureInput<G, P>[]): Promise<Commit>;
  count(): number;
  getBounds(): ReturnType<VectorSourceHandle<G, P>['getBounds']>;
}

export interface PointsLayerHandle<P = FeatureProperties> extends Omit<VectorLayerHandle<PointGeometry<Position>, P, 'points'>, 'get' | 'add' | 'addMany' | 'setData'> {
  get(id: FeatureId): PointHandle<P> | undefined;
  add(point: PointInput<P>): PointHandle<P>;
  addMany(points: readonly PointInput<P>[]): CommitWithRefs<PointGeometry<Position>, P>;
  setData(points: readonly PointInput<P>[]): Promise<Commit>;
}

export interface LineHandle<P = FeatureProperties> extends FeatureHandle<LineStringGeometry<Position>, P> {
  setPositions(positions: readonly PositionInput[]): Commit;
}

export interface PolygonHandle<P = FeatureProperties> extends FeatureHandle<PolygonGeometry<Position>, P> {
  setRings(rings: readonly (readonly PositionInput[])[]): Commit;
}

export interface LinesLayerHandle<P = FeatureProperties> extends Omit<VectorLayerHandle<LineStringGeometry<Position>, P, 'lines'>, 'get' | 'add' | 'addMany' | 'setData'> {
  get(id: FeatureId): LineHandle<P> | undefined;
  add(line: LineInput<P>): LineHandle<P>;
  addMany(lines: readonly LineInput<P>[]): CommitWithRefs<LineStringGeometry<Position>, P>;
  setData(lines: readonly LineInput<P>[]): Promise<Commit>;
}

export interface PolygonsLayerHandle<P = FeatureProperties> extends Omit<VectorLayerHandle<PolygonGeometry<Position>, P, 'fills'>, 'get' | 'add' | 'addMany' | 'setData'> {
  get(id: FeatureId): PolygonHandle<P> | undefined;
  add(polygon: PolygonInput<P>): PolygonHandle<P>;
  addMany(polygons: readonly PolygonInput<P>[]): CommitWithRefs<PolygonGeometry<Position>, P>;
  setData(polygons: readonly PolygonInput<P>[]): Promise<Commit>;
}

export function lineFeature<P>(input: LineInput<P>, projection: Crs): FeatureInput<LineStringGeometry<Position>, P> {
  assertArgument(input && Array.isArray(input.positions), 'a line requires a positions array');
  const { positions, ...rest } = input;
  return { ...rest, geometry: { type: 'lineString', positions: positions.map((position) => normalizePosition(position, projection)) } };
}

export function polygonFeature<P>(input: PolygonInput<P>, projection: Crs): FeatureInput<PolygonGeometry<Position>, P> {
  assertArgument(input && Array.isArray(input.rings) && input.rings.every(Array.isArray), 'a polygon requires an array of rings');
  const { rings, ...rest } = input;
  return { ...rest, geometry: { type: 'polygon', rings: rings.map((ring) => ring.map((position) => normalizePosition(position, projection))) } };
}

export function pointFeature<P>(point: PointInput<P>, projection: Crs): FeatureInput<PointGeometry<Position>, P> {
  assertArgument(point && typeof point === 'object', 'a point requires a position');
  return {
    ...(point.id === undefined ? {} : { id: point.id }),
    ...(point.namespace === undefined ? {} : { namespace: point.namespace }),
    geometry: { type: 'point', position: normalizePosition(point.position, projection) },
    ...(point.properties === undefined ? {} : { properties: point.properties }),
  };
}

export function buildLayer<K extends LayerKind>(engine: MapEngine, layer: EngineLayer, remove: () => void): RenderLayerHandle<K> {
  const alive = (): void => {
    if (engine.destroyed || engine.layers.get(layer.id) !== layer) fail('destroyed', `layer ${layer.id} has been removed`);
  };
  return {
    id: layer.id,
    kind: layer.kind as K,
    sourceId: layer.sourceId,
    get parentId() { return layer.parentId; },
    get removed() { return engine.destroyed || engine.layers.get(layer.id) !== layer; },
    ...featureEvents((fn, options) => { alive(); return layer.on('feature', fn, options); }, undefined, layer.signal),
    show: () => { alive(); layer.setVisible(true); },
    hide: () => { alive(); layer.setVisible(false); },
    isVisible: () => { alive(); return layer.getVisible(); },
    setVisible: (visible) => { alive(); layer.setVisible(visible); },
    setStyle: (style) => { alive(); layer.setStyle(style as Record<string, unknown>); },
    update: (options) => {
      alive();
      const { interactive, draggable, ...patch } = options;
      engine.layers.update(layer.id, { ...patch, ...((interactive === undefined && draggable === undefined) ? {} : { interaction: { ...(interactive === undefined ? {} : { enabled: interactive }), ...(draggable === undefined ? {} : { draggable }) } }) });
    },
    setFilter: (filter) => { alive(); layer.setFilter(filter); },
    setFeatureStyle: (target, style) => { alive(); layer.features.setOverride(target, style); },
    clearFeatureStyle: (target) => { alive(); layer.features.clearOverride(target); },
    getFeatureStyle: (target) => { alive(); const override = layer.features.getOverride(target); return override ? structuredClone(override) : undefined; },
    hasFeatureStyle: (target) => { alive(); return layer.features.hasOverride(target); },
    move: (target) => { alive(); engine.layers.move(layer.id, target); },
    remove: () => { alive(); remove(); },
  };
}

export function buildFeature<G, P>(engine: MapEngine, layer: RenderLayerHandle, source: VectorSourceHandle<G, P>, ref: FeatureRef<G, P>): FeatureHandle<G, P> {
  const query = ref.namespace === undefined ? {} : { namespace: ref.namespace };
  const subscriptions = new Set<Unsubscribe>();
  let stopWatching: Unsubscribe | null = null;
  const rawLayer = engine.layers.get(layer.id)!;
  const dispose = (): void => { for (const off of [...subscriptions]) off(); };
  const read = (): FeatureSnapshot<G, P> => {
    if (engine.destroyed || layer.removed || engine.sources.get(source.id)?.snapshot !== source.snapshot) fail('destroyed', 'the feature layer or source has been removed');
    const snapshot = source.features.get(ref.id, query);
    if (!snapshot || snapshot.ref.generation !== ref.generation) fail('stale-reference', `feature ${String(ref.id)} has been removed`);
    return snapshot;
  };
  const patchStyle = (patch: FeatureOverride): void => {
    read();
    layer.setFeatureStyle(ref as FeatureRef, { ...layer.getFeatureStyle(ref as FeatureRef), ...patch });
  };
  return {
    id: ref.id,
    ref,
    get removed() {
      if (engine.destroyed || layer.removed || engine.sources.get(source.id)?.snapshot !== source.snapshot) return true;
      const snapshot = source.features.get(ref.id, ref.namespace === undefined ? {} : { namespace: ref.namespace });
      return !snapshot || snapshot.ref.generation !== ref.generation;
    },
    ...featureEvents(
      (fn, options) => {
        read();
        if (options?.signal?.aborted) return () => {};
        if (!subscriptions.size) {
          rawLayer.signal.addEventListener('abort', dispose, { once: true });
          // Watch only explicitly subscribed objects, not every handle or feature.
          stopWatching = source.on('change', () => {
            if (!source.features.has(ref.id, query) || source.features.ref(ref.id, query).generation !== ref.generation) dispose();
          }, { signal: rawLayer.signal });
        }
        const stop = rawLayer.on('feature', fn, options);
        const off = (): void => {
          stop();
          options?.signal?.removeEventListener('abort', off);
          subscriptions.delete(off);
          if (!subscriptions.size) {
            stopWatching?.();
            stopWatching = null;
            rawLayer.signal.removeEventListener('abort', dispose);
          }
        };
        subscriptions.add(off);
        options?.signal?.addEventListener('abort', off, { once: true });
        return off;
      },
      (event) => event.feature.sourceId === ref.sourceId && event.feature.id === ref.id && event.feature.namespace === ref.namespace && event.feature.generation === ref.generation,
    ),
    get: read,
    setGeometry: (geometry) => { read(); return source.features.update(ref, { geometry }); },
    setProperties: (properties) => { read(); return source.features.update(ref, { properties }); },
    setStyle: patchStyle,
    clearStyle: () => { read(); layer.clearFeatureStyle(ref as FeatureRef); },
    show: () => patchStyle({ visible: true }),
    hide: () => patchStyle({ visible: false }),
    select: () => { read(); engine.selection.add([ref as FeatureRef]); },
    deselect: () => { read(); engine.selection.remove([ref as FeatureRef]); },
    remove: () => { read(); return source.features.remove(ref); },
  };
}

export function buildVectorLayer<G, P, K extends LayerKind>(engine: MapEngine, layer: RenderLayerHandle<K>, source: VectorSourceHandle<G, P>, namespace?: string): VectorLayerHandle<G, P, K> {
  const object = (ref: FeatureRef<G, P>): FeatureHandle<G, P> => buildFeature(engine, layer, source, ref);
  const alive = (): void => { if (layer.removed) fail('destroyed', `layer ${layer.id} has been removed`); };
  const query = namespace === undefined ? {} : { namespace };
  return {
    ...layer,
    get removed() { return layer.removed; },
    get parentId() { return layer.parentId; },
    source,
    get: (id) => { alive(); const snapshot = source.features.get(id, query); return snapshot ? object(snapshot.ref) : undefined; },
    add: (input) => { alive(); return object(source.features.add(input, query).refs[0]!); },
    addMany: (inputs) => { alive(); return source.features.add(inputs, query); },
    updateFeature: (id, patch) => { alive(); return source.features.update(id, patch, query); },
    setData: (inputs) => { alive(); return source.features.replace(inputs, query); },
    count: () => { alive(); return source.features.count(); },
    getBounds: () => { alive(); return source.getBounds(); },
  };
}

export function buildPointsLayer<P>(engine: MapEngine, layer: RenderLayerHandle<'points'>, source: VectorSourceHandle<PointGeometry<Position>, P>, projection: Crs, namespace?: string): PointsLayerHandle<P> {
  const vector = buildVectorLayer(engine, layer, source, namespace);
  const point = (feature: FeatureHandle<PointGeometry<Position>, P>): PointHandle<P> => ({
    ...feature,
    get removed() { return feature.removed; },
    getPosition: () => feature.get().geometry.position,
    setPosition: (position) => feature.setGeometry({ type: 'point', position: normalizePosition(position, projection) }),
  });
  return {
    ...vector,
    get removed() { return vector.removed; },
    get parentId() { return vector.parentId; },
    get: (id) => { const feature = vector.get(id); return feature ? point(feature) : undefined; },
    add: (input) => point(vector.add(pointFeature(input, projection))),
    addMany: (inputs) => vector.addMany(inputs.map((input) => pointFeature(input, projection))),
    setData: (inputs) => vector.setData(inputs.map((input) => pointFeature(input, projection))),
  };
}

export function buildLinesLayer<P>(engine: MapEngine, layer: RenderLayerHandle<'lines'>, source: VectorSourceHandle<LineStringGeometry<Position>, P>, projection: Crs, namespace?: string): LinesLayerHandle<P> {
  const vector = buildVectorLayer(engine, layer, source, namespace);
  const line = (feature: FeatureHandle<LineStringGeometry<Position>, P>): LineHandle<P> => ({
    ...feature,
    get removed() { return feature.removed; },
    setPositions: (positions) => feature.setGeometry(lineFeature({ positions }, projection).geometry),
  });
  return {
    ...vector,
    get removed() { return vector.removed; },
    get parentId() { return vector.parentId; },
    get: (id) => { const feature = vector.get(id); return feature ? line(feature) : undefined; },
    add: (input) => line(vector.add(lineFeature(input, projection))),
    addMany: (inputs) => vector.addMany(inputs.map((input) => lineFeature(input, projection))),
    setData: (inputs) => vector.setData(inputs.map((input) => lineFeature(input, projection))),
  };
}

export function buildPolygonsLayer<P>(engine: MapEngine, layer: RenderLayerHandle<'fills'>, source: VectorSourceHandle<PolygonGeometry<Position>, P>, projection: Crs, namespace?: string): PolygonsLayerHandle<P> {
  const vector = buildVectorLayer(engine, layer, source, namespace);
  const polygon = (feature: FeatureHandle<PolygonGeometry<Position>, P>): PolygonHandle<P> => ({
    ...feature,
    get removed() { return feature.removed; },
    setRings: (rings) => feature.setGeometry(polygonFeature({ rings }, projection).geometry),
  });
  return {
    ...vector,
    get removed() { return vector.removed; },
    get parentId() { return vector.parentId; },
    get: (id) => { const feature = vector.get(id); return feature ? polygon(feature) : undefined; },
    add: (input) => polygon(vector.add(polygonFeature(input, projection))),
    addMany: (inputs) => vector.addMany(inputs.map((input) => polygonFeature(input, projection))),
    setData: (inputs) => vector.setData(inputs.map((input) => polygonFeature(input, projection))),
  };
}
