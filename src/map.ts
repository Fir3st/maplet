/** Object-oriented public API. Handles remain plain objects with detachable methods. */
import { assertArgument, fail } from './api/errors.ts';
import { Emitter } from './api/events.ts';
import { normalizePosition, type PositionInput } from './api/coordinates.ts';
import { featureEvents, featureEventTypes, type FeatureEvents, type FeatureEvent } from './api/feature-events.ts';
import {
  buildLayer, buildPointsLayer, buildLinesLayer, buildPolygonsLayer, buildVectorLayer, pointFeature, lineFeature, polygonFeature,
  type RenderLayerHandle, type ObjectOptions, type LineInput, type LinesLayerHandle, type PointInput, type PointsLayerHandle, type PolygonInput, type PolygonsLayerHandle, type VectorLayerHandle,
} from './api/objects.ts';
import type { BackendKind, Commit, FeatureEventType, FeatureProperties, MapPointerEvent, PointGeometry, Position, ScreenPoint, SubscribeOptions, Unsubscribe } from './api/types.ts';
import { createMapEngine, type EngineOptions, type MapEngine, type RendererOptions, type SourcesHandle, type GroupHandle as EngineGroup } from './map-engine.ts';
import { crs, type Crs } from './math/crs.ts';
import type { Bounds } from './math/bounds.ts';
import type { LayerKind, LayerSpec, MoveTarget } from './scene/layers.ts';
import type { FeatureInput, VectorSourceHandle } from './scene/source.ts';
import type { RasterTilesOptions, WmsOptions } from './formats/raster.ts';
import type { RasterSourceHandle } from './scene/raster-source.ts';
import type { MediaSourceHandle, ImageSourceOptions, VideoSourceOptions } from './scene/media-source.ts';
import type { SceneEventMap } from './scene/scene.ts';
import type { FitOptions, FlyOptions, ViewUpdate } from './view/view.ts';
import type { ControlHandle, ControlKind, ControlSpec } from './ui/controls.ts';

export type MapOptions = Omit<EngineOptions, 'container' | 'view' | 'renderer'> & {
  readonly center?: PositionInput;
  readonly zoom?: number;
  /** Automatic WebGPU → WebGL 1 by default; 'none' supports DOM-free scenes. */
  readonly renderer?: BackendKind | RendererOptions;
  /** Controls are opt-in; no nullable controls service is needed to add one. */
  readonly controls?: readonly (ControlKind | ControlSpec)[];
};

export interface LayerOptions {
  readonly id?: string;
  readonly visible?: boolean;
  /** Prefer parent.addLayer(options) when creating a nested layer. */
  readonly parent?: string;
}

export type SourceLayerSpec<K extends LayerKind = LayerKind> = Omit<LayerSpec<K>, 'id' | 'interaction' | 'group'> & ObjectOptions<K>;
export type LayerEntry = LayerHandle | RenderLayerHandle;

export interface LayersHandle {
  get(id: string): LayerEntry | undefined;
  /** Direct children in painter order; recursive includes every descendant. */
  list(options?: { readonly recursive?: boolean }): readonly LayerEntry[];
  remove(id: string): void;
  move(id: string, target: MoveTarget): void;
}

/** Shared construction API of the map, its base layer and every nested layer. */
export interface LayerContent {
  /** Advanced source-backed rendering, including read-only MVT namespaces. */
  addLayer<K extends LayerKind>(spec: SourceLayerSpec<K>): RenderLayerHandle<K>;
  addLayer(options?: LayerOptions): LayerHandle;
  addTiles(url: string, options?: TilesOptions): RasterLayerHandle<RasterSourceHandle>;
  addWms(url: string, options: WmsLayerOptions): RasterLayerHandle<RasterSourceHandle>;
  addImage(options: Omit<ImageSourceOptions, 'id'> & ObjectOptions<'raster'>): RasterLayerHandle<MediaSourceHandle>;
  addVideo(options: Omit<VideoSourceOptions, 'id'> & ObjectOptions<'raster'>): RasterLayerHandle<MediaSourceHandle>;
  addPoints<P = FeatureProperties>(points: readonly PointInput<P>[] | VectorSourceHandle<PointGeometry<Position>, P>, options?: ObjectOptions<'points'>): PointsLayerHandle<P>;
  addLines<P = FeatureProperties>(lines: readonly LineInput<P>[], options?: ObjectOptions<'lines'>): LinesLayerHandle<P>;
  addPolygons<P = FeatureProperties>(polygons: readonly PolygonInput<P>[], options?: ObjectOptions<'fills'>): PolygonsLayerHandle<P>;
  addLabels<G, P>(source: VectorSourceHandle<G, P>, options?: ObjectOptions<'labels'>): VectorLayerHandle<G, P, 'labels'>;
}

/** A heterogeneous container: objects, shared sources and other logical layers. */
export interface LayerHandle extends LayerContent, FeatureEvents {
  readonly id: string;
  readonly kind: 'layer';
  readonly parentId: string | null;
  readonly removed: boolean;
  readonly layers: LayersHandle;
  show(): void;
  hide(): void;
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  move(target: MoveTarget): void;
  remove(): void;
}

export type MapClickEvent = FeatureEvent<'click'> | (MapPointerEvent & { readonly type: 'click'; readonly feature: null });
export type MapEventTypes = Omit<SceneEventMap, 'feature' | 'pointer'> & {
  [T in Exclude<FeatureEventType, 'click'>]: FeatureEvent<T>;
} & { click: MapClickEvent; pointer: MapPointerEvent };

export type RasterLayerHandle<S extends RasterSourceHandle | MediaSourceHandle = RasterSourceHandle | MediaSourceHandle> = RenderLayerHandle<'raster'> & { readonly source: S };
export type TilesOptions = Omit<RasterTilesOptions, 'id' | 'url'> & ObjectOptions<'raster'>;
export type WmsLayerOptions = Omit<WmsOptions, 'id' | 'url'> & ObjectOptions<'raster'>;

export interface MapHandle extends LayerContent, Pick<MapEngine,
  'id' | 'use' | 'render' | 'container' | 'assets' | 'state' | 'selection' | 'relations' | 'bindings' | 'query' |
  'interaction' | 'detail' | 'locate' | 'debug' | 'whenRendered' | 'capabilities' | 'stats' | 'destroy' | 'destroyed' | 'size'> {
  /** Explicit shared sources and bulk imports; ordinary layers do not require this. */
  readonly data: SourcesHandle;
  batch<T>(fn: () => T & (T extends PromiseLike<unknown> ? never : unknown)): Commit;
  readonly layers: LayersHandle;
  /** Lazily created shared layer for all map.addPoints/addLines/etc. calls. */
  readonly base: LayerHandle;
  readonly controls: {
    get(id: string): ControlHandle | undefined;
    list(): readonly ControlHandle[];
    remove(id: string): void;
  };
  getView(): ReturnType<MapEngine['view']['get']>;
  setView(update: Omit<ViewUpdate, 'center'> & { readonly center?: PositionInput }): ReturnType<MapEngine['view']['set']>;
  getCenter(): Position;
  getZoom(): number;
  setCenter(center: PositionInput): ReturnType<MapEngine['view']['set']>;
  setZoom(zoom: number): ReturnType<MapEngine['view']['set']>;
  fitBounds(bounds: Bounds<Position> | null, options?: FitOptions): ReturnType<MapEngine['view']['fit']>;
  flyTo(update: Omit<ViewUpdate, 'center'> & { readonly center?: PositionInput }, options?: FlyOptions): Promise<void>;
  stop(): void;
  zoomAround(screen: ScreenPoint, deltaZoom: number): ReturnType<MapEngine['view']['zoomAround']>;
  resize(width: number, height: number): void;
  positionToScreen(position: PositionInput): ScreenPoint;
  screenToPosition(screen: ScreenPoint): Position;
  getBounds(): Bounds<Position> | null;
  addControl(control: ControlKind | ControlSpec): ControlHandle;
  on<K extends keyof MapEventTypes>(type: K, fn: (event: MapEventTypes[K]) => void, options?: SubscribeOptions): Unsubscribe;
  onFeature: FeatureEvents['onFeature'];
  once<K extends keyof MapEventTypes>(type: K, fn: (event: MapEventTypes[K]) => void, options?: SubscribeOptions): Unsubscribe;
  off<K extends keyof MapEventTypes>(type: K, fn: (event: MapEventTypes[K]) => void): void;
}

export async function createMap(container: HTMLElement | string | null, options: MapOptions = {}): Promise<MapHandle> {
  assertArgument(container === null || typeof container === 'string' || (typeof container === 'object' && typeof container?.appendChild === 'function'), 'createMap expects an element, its id, or null for a DOM-free map');
  assertArgument(options !== null && typeof options === 'object', 'map options must be an object');
  assertArgument(!('view' in options) && !('container' in options), 'use createMap(container, { center, zoom }); nested view/container options were removed');
  const { center, zoom, controls, renderer, ...rest } = options;
  const projection = options.projection ?? crs.webMercator();
  assertArgument(projection && typeof projection.normalize === 'function' && typeof projection.toWorld === 'function' && typeof projection.fromWorld === 'function', 'projection must be a CRS object');
  const rendererOptions = typeof renderer === 'string'
    ? { primary: renderer, ...(renderer === 'none' ? { fallback: false as const } : {}) }
    : renderer;
  const engineOptions: EngineOptions = {
    ...rest,
    ...(container === null ? {} : { container }),
    ...(rendererOptions === undefined ? {} : { renderer: rendererOptions }),
    view: { ...(center === undefined ? {} : { center: normalizePosition(center, projection) }), ...(zoom === undefined ? {} : { zoom }) },
  };
  return createMapEngine(engineOptions, (engine) => {
    const map = buildMap(engine, projection);
    for (const control of controls ?? []) map.addControl(control);
    return map;
  });
}

function buildMap(engine: MapEngine, projection: Crs): MapHandle {
  const handles = new Map<string, RenderLayerHandle>();
  const containers = new Map<string, LayerHandle>();
  const ownedSources = new Set<string>();
  let nextId = 0;
  const idFor = (kind: string, requested?: string): string => {
    if (requested !== undefined) {
      assertArgument(typeof requested === 'string' && requested.length > 0, 'id must be a nonempty string');
      if (requested === 'base') fail('duplicate-id', 'base is reserved for the default layer');
      return requested;
    }
    let id: string;
    do { id = `${kind}:${++nextId}`; } while (engine.layers.get(id) || engine.groups.get(id) || engine.sources.get(id));
    return id;
  };
  const releaseUnusedSources = (candidates: ReadonlySet<string>): void => {
    const used = new Set(engine.layers.list().map((layer) => layer.sourceId));
    for (const relation of engine.relations.list()) {
      used.add(relation.from.sourceId);
      used.add(relation.to.sourceId);
    }
    for (const binding of engine.bindings.list()) {
      used.add(binding.target.sourceId);
      if (binding.properties) used.add(binding.properties.from.sourceId);
      if (binding.geometry?.kind === 'lineBetween') {
        used.add(binding.geometry.from.sourceId);
        used.add(binding.geometry.to.sourceId);
      } else if (binding.geometry) used.add(binding.geometry.line.sourceId);
    }
    for (const id of candidates) {
      if (!ownedSources.has(id) || used.has(id)) continue;
      if (engine.sources.get(id)) engine.sources.remove(id);
      ownedSources.delete(id);
    }
  };
  const removeLayer = (id: string): void => {
    if (engine.groups.get(id)) { removeContainer(id); return; }
    const layer = engine.layers.get(id);
    if (!layer) fail('not-found', `layer not found: ${id}`);
    engine.layers.remove(id);
    handles.delete(id);
    releaseUnusedSources(new Set([layer.sourceId]));
  };
  const removeContainer = (id: string): void => {
    engine.groups.remove(id);
    const candidates = new Set<string>();
    for (const [layerId, handle] of handles) {
      if (!handle.removed) continue;
      handles.delete(layerId);
      candidates.add(handle.sourceId);
    }
    for (const [layerId, handle] of containers) if (handle.removed) containers.delete(layerId);
    releaseUnusedSources(candidates);
  };
  const moveLayer = (id: string, target: MoveTarget): void => {
    if (id === 'base') {
      if ('into' in target) assertArgument(target.into === null, 'the base layer must remain at the map root');
      if ('before' in target || 'after' in target) {
        const anchorId = 'before' in target ? target.before : target.after;
        const anchor = engine.groups.get(anchorId) ?? engine.layers.get(anchorId);
        if (anchor) assertArgument(anchor.parentId === null, 'the base layer must remain at the map root');
      }
    }
    engine.layers.move(id, target);
  };
  const addRenderLayer = <K extends LayerKind>(spec: SourceLayerSpec<K>): RenderLayerHandle<K> => {
    assertArgument(spec && typeof spec === 'object', 'addLayer expects a layer descriptor');
    assertArgument(typeof spec.source === 'string' || (spec.source && typeof spec.source === 'object'), 'a layer requires a source');
    assertArgument(!('interaction' in spec) && !('group' in spec), 'use interactive/draggable and parent directly on object options');
    assertArgument(['points', 'lines', 'fills', 'labels', 'raster'].includes(spec.type), 'unknown render type');
    if (typeof spec.source === 'object' && 'type' in spec.source) {
      const registered = engine.sources.get(spec.source.id);
      // A detached closure identifies the source while transparent proxies remain valid.
      assertArgument(registered && 'snapshot' in spec.source && registered.snapshot === spec.source.snapshot, 'a source must belong to this map');
    }
    const { interactive, draggable, parent, ...rest } = spec;
    const raw = engine.layers.add({
      ...rest,
      id: idFor(spec.type, spec.id),
      ...(parent === undefined ? {} : { group: parent }),
      interaction: {
        ...(interactive === undefined ? {} : { enabled: interactive }),
        ...(draggable === undefined ? {} : { draggable }),
      },
    });
    const handle = buildLayer<K>(engine, raw, () => removeLayer(raw.id));
    handles.set(raw.id, handle);
    return handle;
  };
  const ownVector = <G, P>(kind: LayerKind, inputs: readonly FeatureInput<G, P>[], options: ObjectOptions): { layer: RenderLayerHandle; source: VectorSourceHandle<G, P> } => {
    const id = idFor(kind, options.id);
    if (engine.layers.get(id) || engine.groups.get(id)) fail('duplicate-id', `layer id already exists: ${id}`);
    if (options.parent && !engine.groups.get(options.parent)) fail('not-found', `layer not found: ${options.parent}`);
    // Source identities are independent of layer ids, including user-chosen ids.
    const source = engine.sources.vector<G, P>({ id: idFor('data') });
    try {
      if (inputs.length) source.features.add(inputs, options.namespace === undefined ? {} : { namespace: options.namespace });
      const layer = addRenderLayer({ ...options, id, type: kind, source });
      ownedSources.add(source.id);
      return { layer, source };
    } catch (error) {
      engine.sources.remove(source.id, { cascade: true });
      throw error;
    }
  };
  const ownRaster = <S extends RasterSourceHandle | MediaSourceHandle>(kind: string, options: ObjectOptions<'raster'>, create: (id: string) => S): RasterLayerHandle<S> => {
    const source = create(idFor('data'));
    try {
      const layer = addRenderLayer({ ...options, id: idFor(kind, options.id), type: 'raster', source });
      ownedSources.add(source.id);
      const handle = { ...layer, get removed() { return layer.removed; }, get parentId() { return layer.parentId; }, source };
      handles.set(layer.id, handle);
      return handle;
    } catch (error) {
      engine.sources.remove(source.id, { cascade: true });
      throw error;
    }
  };
  const containerHandle = (group: EngineGroup): LayerHandle => {
    const cached = containers.get(group.id);
    if (cached && !cached.removed) return cached;
    const alive = (): void => { if (group.removed) fail('destroyed', `layer ${group.id} has been removed`); };
    const handle: LayerHandle = {
      id: group.id,
      kind: 'layer',
      get parentId() { return group.parentId; },
      get removed() { return group.removed; },
      ...featureEvents((fn, options) => { alive(); return group.on('feature', fn, options); }, undefined, group.signal),
      ...content(group),
      layers: registry(group),
      setVisible: (visible) => { alive(); group.setVisible(visible); },
      show: () => { alive(); group.setVisible(true); }, hide: () => { alive(); group.setVisible(false); },
      isVisible: () => { alive(); return group.getVisible(); },
      move: (target) => { alive(); moveLayer(group.id, target); },
      remove: () => { alive(); removeContainer(group.id); },
    };
    containers.set(group.id, handle);
    return handle;
  };
  const addContainer = (options: LayerOptions): LayerHandle => {
    assertArgument(!('style' in options) && !('filter' in options), 'set styles and filters on the typed collections inside a layer');
    return containerHandle(engine.groups.add({ ...options, id: idFor('layer', options.id) }));
  };
  const getBase = (): LayerHandle => {
    engine.view.get();
    const current = engine.groups.get('base');
    if (current) return containerHandle(current);
    const group = engine.groups.add({ id: 'base' });
    // The implicit base starts underneath explicitly created layers, even if
    // their creation preceded the first map.addPoints/addTiles/etc. call.
    engine.groups.move(group.id, { index: 0 });
    return containerHandle(group);
  };
  const getEntry = (id: string): LayerEntry | undefined => {
    const group = engine.groups.get(id);
    if (group) return containerHandle(group);
    const handle = handles.get(id);
    return handle && !handle.removed ? handle : undefined;
  };
  const registry = (parent?: EngineGroup): LayersHandle => {
    const alive = (): void => {
      engine.view.get();
      if (parent?.removed) fail('destroyed', `layer ${parent.id} has been removed`);
    };
    const get = (id: string): LayerEntry | undefined => {
      alive();
      const handle = getEntry(id);
      return handle && (parent === undefined || handle.parentId === parent.id) ? handle : undefined;
    };
    const requireChild = (id: string): void => { if (!get(id)) fail('not-found', `layer entry not found: ${id}`); };
    return {
      get,
      list: (options = {}) => {
        alive();
        const entries: LayerEntry[] = [];
        const visit = (id?: string): void => {
          for (const childId of engine.layers.entries(id)) {
            const child = getEntry(childId);
            if (!child) continue;
            entries.push(child);
            if (options.recursive && child.kind === 'layer') visit(child.id);
          }
        };
        visit(parent?.id);
        return entries;
      },
      remove: (id) => { requireChild(id); removeLayer(id); },
      move: (id, target) => { requireChild(id); moveLayer(id, target); },
    };
  };
  const content = (owner?: EngineGroup): LayerContent => {
    const scopedOptions = <T extends { readonly parent?: string }>(options: T, useBase = true): T => {
      engine.view.get();
      if (owner?.removed) fail('destroyed', `layer ${owner.id} has been removed`);
      assertArgument(options && typeof options === 'object' && !('group' in options), 'use a layer receiver or parent, not group');
      if (options.parent !== undefined) {
        assertArgument(typeof options.parent === 'string' && options.parent.length > 0, 'parent must be a nonempty layer id');
        if (!engine.groups.get(options.parent)) fail('not-found', `layer not found: ${options.parent}`);
      }
      if (owner) {
        assertArgument(options.parent === undefined || options.parent === owner.id, 'objects and child layers must belong to their receiving layer');
        return { ...options, parent: owner.id };
      }
      return useBase && options.parent === undefined ? { ...options, parent: getBase().id } : options;
    };
    function addLayer<K extends LayerKind>(spec: SourceLayerSpec<K>): RenderLayerHandle<K>;
    function addLayer(options?: LayerOptions): LayerHandle;
    function addLayer(options: LayerOptions | SourceLayerSpec = {}): LayerEntry {
      assertArgument(options && typeof options === 'object', 'addLayer expects an options object');
      if ('type' in options || 'source' in options) return addRenderLayer(scopedOptions(options as SourceLayerSpec, false));
      return addContainer(scopedOptions(options, false));
    }
    return {
      addLayer,
      addTiles: (url, options = {}) => ownRaster('tiles', scopedOptions(options), (id) => engine.sources.rasterTiles({ ...options, id, url })),
      addWms: (url, options) => ownRaster('wms', scopedOptions(options), (id) => engine.sources.wms({ ...options, id, url })),
      addImage: (options) => ownRaster('image', scopedOptions(options), (id) => engine.sources.image({ ...options, id })),
      addVideo: (options) => ownRaster('video', scopedOptions(options), (id) => engine.sources.video({ ...options, id })),
      addPoints: <P>(points: readonly PointInput<P>[] | VectorSourceHandle<PointGeometry<Position>, P>, options: ObjectOptions<'points'> = {}) => {
        const scoped = scopedOptions(options);
        const built = Array.isArray(points)
          ? ownVector('points', (points as readonly PointInput<P>[]).map((input) => pointFeature(input, projection)), scoped)
          : { source: points as VectorSourceHandle<PointGeometry<Position>, P>, layer: addRenderLayer({ ...scoped, type: 'points', source: points as VectorSourceHandle<PointGeometry<Position>, P> }) };
        const handle = buildPointsLayer(engine, built.layer as RenderLayerHandle<'points'>, built.source, projection, scoped.namespace);
        handles.set(handle.id, handle);
        return handle;
      },
      addLines: (lines, options = {}) => {
        const scoped = scopedOptions(options);
        const built = ownVector('lines', lines.map((input) => lineFeature(input, projection)), scoped);
        const handle = buildLinesLayer(engine, built.layer as RenderLayerHandle<'lines'>, built.source, projection, scoped.namespace);
        handles.set(handle.id, handle); return handle;
      },
      addPolygons: (polygons, options = {}) => {
        const scoped = scopedOptions(options);
        const built = ownVector('fills', polygons.map((input) => polygonFeature(input, projection)), scoped);
        const handle = buildPolygonsLayer(engine, built.layer as RenderLayerHandle<'fills'>, built.source, projection, scoped.namespace);
        handles.set(handle.id, handle); return handle;
      },
      addLabels: (source, options = {}) => {
        const scoped = scopedOptions(options);
        const layer = addRenderLayer({ ...scoped, type: 'labels', source });
        const handle = buildVectorLayer(engine, layer, source, scoped.namespace);
        handles.set(handle.id, handle); return handle;
      },
    };
  };
  const events = new Emitter<MapEventTypes>();
  const nativeEvents = ['commit', 'viewchange', 'viewstart', 'viewend', 'selectchange', 'backend', 'destroy', 'rendererror'] as const;
  for (const type of nativeEvents) engine.on(type, (event) => events.emit(type, event));
  engine.on('feature', (event) => events.emit(event.type, event as FeatureEvent));
  engine.on('pointer', (event) => {
    events.emit('pointer', event);
    if (event.type === 'click') events.emit('click', { ...event, type: 'click', feature: null });
  });
  const listen = <K extends keyof MapEventTypes>(type: K, fn: (event: MapEventTypes[K]) => void, options?: SubscribeOptions, once = false): Unsubscribe => {
    assertArgument([...nativeEvents, ...featureEventTypes, 'pointer'].includes(type), `unknown map event: ${String(type)}`);
    assertArgument(typeof fn === 'function', 'event listener must be a function');
    engine.view.get();
    return once ? events.once(type, fn, options) : events.on(type, fn, options);
  };
  const viewUpdate = (update: Omit<ViewUpdate, 'center'> & { readonly center?: PositionInput }): ViewUpdate => {
    const { center, ...rest } = update;
    return { ...rest, ...(center === undefined ? {} : { center: normalizePosition(center, projection) }) };
  };
  const map: MapHandle = {
    ...content(),
    id: engine.id, container: engine.container, use: engine.use, render: engine.render,
    assets: engine.assets,
    data: {
      ...engine.sources,
      remove: (id, options) => {
        engine.sources.remove(id, options);
        ownedSources.delete(id);
        for (const [layerId, layer] of handles) if (layer.removed) handles.delete(layerId);
      },
    },
    state: engine.state, selection: engine.selection,
    relations: engine.relations, bindings: engine.bindings, query: engine.query, interaction: engine.interaction,
    detail: engine.detail, locate: engine.locate, debug: engine.debug,
    batch: engine.batch, whenRendered: engine.whenRendered, capabilities: engine.capabilities, stats: engine.stats, size: engine.size,
    get destroyed() { return engine.destroyed; },
    destroy: () => { try { engine.destroy(); } finally { events.clear(); handles.clear(); containers.clear(); ownedSources.clear(); } },
    layers: registry(),
    get base() { return getBase(); },
    controls: {
      get: (id) => engine.controls?.get(id), list: () => engine.controls?.list() ?? [],
      remove: (id) => { if (!engine.controls) fail('unsupported-capability', 'controls require a map container'); engine.controls.remove(id); },
    },
    addControl: (control) => { if (!engine.controls) fail('unsupported-capability', 'controls require a map container'); return engine.controls.add(typeof control === 'string' ? { kind: control } : control); },
    getView: engine.view.get,
    getCenter: () => engine.view.get().center,
    getZoom: () => engine.view.get().zoom,
    setView: (update) => engine.view.set(viewUpdate(update)),
    setCenter: (center) => engine.view.set({ center: normalizePosition(center, projection) }),
    setZoom: (zoom) => engine.view.set({ zoom }),
    fitBounds: engine.view.fit,
    flyTo: (update, options) => engine.view.flyTo(viewUpdate(update), options),
    stop: engine.view.stop,
    zoomAround: engine.view.zoomAround,
    resize: engine.view.resize,
    positionToScreen: (position) => engine.view.positionToScreen(normalizePosition(position, projection)),
    screenToPosition: engine.view.screenToPosition,
    getBounds: engine.view.getBounds,
    onFeature: (fn, options) => { assertArgument(typeof fn === 'function', 'event listener must be a function'); engine.view.get(); return engine.on('feature', fn, options); },
    on: (type, fn, options) => listen(type, fn, options), once: (type, fn, options) => listen(type, fn, options, true), off: (type, fn) => events.off(type, fn),
  };
  return map;
}

export type { PositionInput } from './api/coordinates.ts';
export type { FeatureEvent, FeatureEvents } from './api/feature-events.ts';
export type { FeatureHandle, PointHandle, LineHandle, PolygonHandle, RenderLayerHandle, ObjectOptions, PointInput, LineInput, PolygonInput, PointsLayerHandle, LinesLayerHandle, PolygonsLayerHandle, VectorLayerHandle } from './api/objects.ts';
export type { AreaQueryOptions, AreaQueryResult, AssetsHandle, BindingsHandle, ControlHandle, ControlKind, ControlLayerEntry, ControlPosition, ControlSpec, DetailContent, DetailContentFactory, DetailHandle, DetailOptions, DetailServiceHandle, ListControlOptions, LocateErrorCode, LocateHandle, LocateOptions, LocateResult, LocateWatch, LocateWatchOptions, LocatedPosition, QueryCursor, QueryHandle, RelationsHandle, RendererOptions, SelectionHandle, SourcesHandle, StateHandle } from './map-engine.ts';
