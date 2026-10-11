/**
 * Public map facade: `createMap` and the closure-based handles.
 *
 * Every handle is a plain object whose methods close over the internal scene;
 * no method depends on `this` and no internal object is exposed (REF-01..REF-03).
 * A handle can therefore be stored in a reactive reference, wrapped in a
 * transparent proxy or have its methods detached. REF-05: all reads return
 * snapshots; direct mutation of a snapshot never changes the map.
 */

import { assertArgument, fail, isMapletError } from './api/errors.ts';
import type {
  BackendKind,
  Capabilities,
  Commit,
  FeatureRef,
  FeatureSnapshot,
  MapFeatureEvent,
  MapStats,
  Position,
  ScreenPoint,
  SubscribeOptions,
  Unsubscribe,
  Unsubscribe as Off,
} from './api/types.ts';
import { crs as crsRegistry, type Crs } from './math/crs.ts';
import { boundsToWorldRect, queryDataAt, queryDataRect, type AreaRelation } from './scene/query.ts';
import { type LayerKind, type LayerSpec, type MoveTarget, type FeatureOverride, type LayerImpl, type GroupImpl } from './scene/layers.ts';
import {
  type RasterSourceHandle,
} from './scene/raster-source.ts';
import { Scene } from './scene/scene.ts';
import type { VectorSourceHandle, FeatureInput } from './scene/source.ts';
import { SourceImpl } from './scene/source.ts';
import type { ImportPipelineDebug } from './io/import-pipeline.ts';
import type { Filter } from './scene/expression.ts';
import type { FeatureState, FeatureStatePatch } from './scene/state.ts';
import type { EndpointPolicy, NeighborOptions, RelationInput, RelationSnapshot, TraverseOptions } from './scene/relations.ts';
import { createFontAssetHandle, createImageAssetHandle, type FontAssetHandle, type ImageAssetHandle } from './scene/assets.ts';
import type { BindingInput, BindingSnapshot } from './scene/bindings.ts';
import type { RasterTilesOptions, WmsOptions } from './formats/raster.ts';
import type {
  ImageSourceOptions,
  MediaSourceHandle,
  VideoSourceOptions,
} from './scene/media-source.ts';
import type {
  VectorTilesOptions,
  VectorTilesSourceHandle,
} from './scene/vector-tile-source.ts';
import { ViewImpl, defaultClock, type Clock, type FitOptions, type FlyOptions, type ViewSnapshot, type ViewUpdate } from './view/view.ts';
import { createBackend, type BackendInitOptions, type MapBackend } from './render/backends.ts';
import { ControlsHost, type ControlHandle, type ControlSpec, type ListControlOptions } from './ui/controls.ts';
import { attributionsForLayers } from './ui/attribution.ts';
import { DetailController } from './ui/detail.ts';
import type { DetailHandle, DetailOptions } from './ui/detail.ts';
import {
  createLocator,
  type GeolocationLike,
  type LocateOptions,
  type LocateResult,
  type LocateWatch,
  type LocateWatchOptions,
} from './ui/locate.ts';
import { InteractionController, type InteractionOptions } from './interaction/interaction.ts';
import type { SceneEventMap } from './scene/scene.ts';
import {
  buildFramePlan,
  framePlanBuildCount,
  type LabelPlacement,
  type MediaPlacement,
  type SpritePlacement,
  type TilePlacement,
} from './render/frame-plan.ts';
import { compileFilter } from './scene/expression.ts';
import type { PickResult } from './render/picking.ts';
export interface RendererOptions {
  /** Primary backend; `'none'` creates a DOM-free logic scene (tests, SSR math). */
  readonly primary?: BackendKind;
  /** Fallback backend when the primary fails; `false` disables fallback. */
  readonly fallback?: BackendKind | false;
}

export interface MapOptions {
  readonly container?: HTMLElement | string;
  readonly projection?: Crs;
  readonly renderer?: RendererOptions;
  readonly view?: { readonly center?: Position; readonly zoom?: number };
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly maxBounds?: import('./math/bounds.ts').Bounds<Position> | null;
  /** Initial size before layout; headless scenes require it (default 800x600). */
  readonly size?: { readonly width: number; readonly height: number };
  readonly clock?: Clock;
  /** `false` disables pointer/wheel/keyboard interaction entirely. */
  readonly interactive?: boolean;
  /** Per-gesture interaction options. */
  readonly interaction?: InteractionOptions;
}

export interface InteractionHandle {
  setOptions(options: Partial<InteractionOptions>): void;
  options(): Required<InteractionOptions>;
  destroy(): void;
}

/* -------------------------------------------------------------------------- */
/* Handles                                                                     */
/* -------------------------------------------------------------------------- */

export interface ViewHandle {
  get(): ViewSnapshot;
  set(update: ViewUpdate): Commit;
  fit(bounds: import('./math/bounds.ts').Bounds<Position> | null, options?: FitOptions): Commit;
  flyTo(update: ViewUpdate, options?: FlyOptions): Promise<void>;
  stop(): void;
  zoomAround(screen: ScreenPoint, deltaZoom: number): Commit;
  resize(width: number, height: number): void;
  positionToScreen(position: Position): ScreenPoint;
  screenToPosition(screen: ScreenPoint): Position;
  getBounds(): import('./math/bounds.ts').Bounds<Position> | null;
}

export interface LayerFeaturesHandle {
  setOverride(target: FeatureRef | string | number, override: FeatureOverride): void;
  clearOverride(target: FeatureRef | string | number): void;
  hasOverride(target: FeatureRef | string | number): boolean;
  getOverride(target: FeatureRef | string | number): FeatureOverride | undefined;
}

export interface LayerHandle {
  readonly id: string;
  readonly kind: LayerKind;
  readonly sourceId: string;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
  setFilter(filter: Filter | null): void;
  setStyle(style: Record<string, unknown>): void;
  readonly features: LayerFeaturesHandle;
  /** Feature events for this layer, before its groups and the map (EVENT-01). */
  on(type: 'feature', fn: (event: MapFeatureEvent) => void, options?: SubscribeOptions): Unsubscribe;
  remove(): void;
}

export interface GroupHandle {
  readonly id: string;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
  /** Feature events of layers under this group, before the map (EVENT-01). */
  on(type: 'feature', fn: (event: MapFeatureEvent) => void, options?: SubscribeOptions): Unsubscribe;
  remove(): void;
}

export interface LayersHandle {
  add(spec: LayerSpec): LayerHandle;
  get(id: string): LayerHandle | undefined;
  list(): LayerHandle[];
  update(id: string, patch: Partial<Pick<LayerSpec, 'style' | 'filter' | 'namespace' | 'visible' | 'interaction'>>): void;
  remove(id: string): void;
  move(id: string, target: MoveTarget): void;
}

export interface GroupsHandle {
  add(spec: { readonly id: string; readonly visible?: boolean; readonly parent?: string }): GroupHandle;
  get(id: string): GroupHandle | undefined;
  list(): GroupHandle[];
  remove(id: string): void;
  move(id: string, target: MoveTarget): void;
  setVisible(id: string, visible: boolean): void;
}

export interface AssetsHandle {
  /** Registers a PNG/JPEG/WebP/SVG image under a stable id (MEDIA-07/08). */
  addImage(spec: { readonly id: string; readonly src: string }): ImageAssetHandle;
  get(id: string): ImageAssetHandle | undefined;
  list(): ImageAssetHandle[];
  /**
   * Registers a font family used by label styles (TEXT-05). `src` is a URL or a
   * CSS font source (`local(...)`, `url(...)`); while loading, or after an error,
   * labels render with the platform fallback and the state stays observable.
   */
  addFont(spec: {
    readonly id: string;
    readonly family: string;
    readonly src: string;
  }): FontAssetHandle;
  getFont(id: string): FontAssetHandle | undefined;
  listFonts(): FontAssetHandle[];
  remove(id: string): void;
}

export interface SourcesHandle {
  vector<G = import('./api/types.ts').Geometry, P = import('./api/types.ts').FeatureProperties>(options: { readonly id: string }): VectorSourceHandle<G, P>;
  rasterTiles(options: RasterTilesOptions): RasterSourceHandle;
  wms(options: WmsOptions): RasterSourceHandle;
  /**
   * Image placed into explicit bounds (MEDIA-01..04): `url` or raw RGBA
   * `pixels`, with `updateRegion` for partial pixel updates.
   */
  image(options: ImageSourceOptions): MediaSourceHandle;
  /** Video placed into explicit bounds (MEDIA-05/06): frames update the texture. */
  video(options: VideoSourceOptions): MediaSourceHandle;
  /** MVT vector tiles: viewport-loaded, read-only, one logical feature per identity. */
  vectorTiles(options: VectorTilesOptions): VectorTilesSourceHandle;
  get(id: string): VectorSourceHandle | RasterSourceHandle | MediaSourceHandle | VectorTilesSourceHandle | undefined;
  list(): readonly string[];
  remove(id: string, options?: { readonly cascade?: boolean }): void;
}

export interface StateHandle {
  get(ref: FeatureRef): FeatureState;
  set(ref: FeatureRef, patch: FeatureStatePatch): void;
  subscribe(fn: (event: { sourceId: string; id: FeatureRef['id']; state: FeatureState }) => void, options?: SubscribeOptions): Unsubscribe;
}

export interface SelectionHandle {
  get(): readonly FeatureRef[];
  set(refs: readonly FeatureRef[]): void;
  add(refs: readonly FeatureRef[]): void;
  remove(refs: readonly FeatureRef[]): void;
  clear(): void;
  subscribe(fn: (event: { revision: number; selected: readonly FeatureRef[] }) => void, options?: SubscribeOptions): Unsubscribe;
}

export interface RelationsHandle {
  add(input: RelationInput): RelationSnapshot;
  get(id: string): RelationSnapshot | undefined;
  remove(id: string): void;
  list(filter?: { readonly type?: string; readonly feature?: FeatureRef }): RelationSnapshot[];
  neighbors(ref: FeatureRef, options?: NeighborOptions): FeatureRef[];
  traverse(ref: FeatureRef, options?: TraverseOptions): FeatureRef[];
  subscribe(fn: (event: { revision: number }) => void, options?: SubscribeOptions): Unsubscribe;
  setEndpointPolicy(policy: EndpointPolicy): void;
}

export interface BindingsHandle {
  add(input: BindingInput): BindingSnapshot;
  get(id: string): BindingSnapshot | undefined;
  update(id: string, input: Omit<BindingInput, 'id'>): BindingSnapshot;
  remove(id: string): void;
  list(): BindingSnapshot[];
  subscribe(fn: (event: { revision: number }) => void, options?: SubscribeOptions): Unsubscribe;
}

export interface AreaQueryOptions {
  readonly relation?: AreaRelation;
  readonly limit?: number;
  /** Restrict the query to these source ids. */
  readonly sources?: readonly string[];
  /** Restrict to a namespace (e.g. a vector-tile source layer). */
  readonly namespace?: string;
  /** Opaque cursor returned by a previous call; invalidated by a new revision. */
  readonly cursor?: QueryCursor;
}

export interface QueryCursor {
  readonly offset: number;
  readonly revision: number;
}

export interface AreaQueryResult {
  readonly items: readonly FeatureSnapshot[];
  readonly next: QueryCursor | null;
}

export interface QueryHandle {
  /** Data query at a position; tolerance defaults to 4 CSS px. */
  at(
    position: Position,
    options?: {
      readonly tolerancePx?: number;
      readonly limit?: number;
      readonly sources?: readonly string[];
      readonly namespace?: string;
    },
  ): readonly FeatureSnapshot[];
  /** Data query over a bounds. */
  area(bounds: import('./math/bounds.ts').Bounds<Position>, options?: AreaQueryOptions): AreaQueryResult;
  /** Rendered picking; resolves with the topmost pickable instance (GPU required). */
  rendered(point: ScreenPoint, options?: { readonly limit?: number }): Promise<readonly PickResult[]>;
}

export interface DebugHandle {
  /** Layer ids in draw order, ignoring visibility. */
  layerOrder(): readonly string[];
  /** How many records pass the layer's filter/visibility rules right now. */
  countLayerRecords(layerId: string): number;
  /** Total instances the layer would contribute to a frame at the current view. */
  layerInstances(layerId: string): number;
  /** First drawn instance colour of a layer as `#rrggbb` (points/lines/fills). */
  layerColor(layerId: string): string | null;
  /** Pick order of a layer: feature ids in the order primitives are drawn. */
  layerPickOrder(layerId: string): readonly (string | number)[];
  /** Raster tile placements of a layer for the current view (URLs, fallbacks). */
  layerTiles(layerId: string): readonly TilePlacement[];
  /** Media (image/video) placements of a layer for the current view. */
  layerMedia(layerId: string): readonly MediaPlacement[];
  /** Label placements of a layer for the current view (text, anchor, offsets). */
  layerLabels(layerId: string): readonly LabelPlacement[];
  /** Sprite placements of a layer for the current view (ready icon assets). */
  layerSprites(layerId: string): readonly SpritePlacement[];
  /** Monotonic counter of frame-plan rebuilds (cache diagnostics). */
  planBuildCount(): number;
  /** Diagnostics: adjacency entries examined by relation lookups since load. */
  relationsScanCount(): number;
  /** Diagnostics: binding evaluations since load. */
  bindingsEvaluatedCount(): number;
  /**
   * Import preparation diagnostics: the effective backend, in-flight jobs and
   * completed preparations per backend (IO-09..IO-11, LIFE-09).
   */
  imports(): ImportPipelineDebug;
  /** Diagnostics: renders one frame and samples the back buffer at a CSS pixel. */
  samplePixel(point: ScreenPoint): Promise<{ r: number; g: number; b: number; a: number }>;
  /**
   * Diagnostics: forces a device/context loss. The map then runs the same
   * recovery as for a real loss (GPU-07..10), so tests can observe the swap.
   */
  forceBackendLoss(): void;
}

export interface ControlsHandle {
  /** Adds a control; ids default to `kind-N` and must be unique. */
  add(spec: ControlSpec): ControlHandle;
  get(id: string): ControlHandle | undefined;
  list(): readonly ControlHandle[];
  remove(id: string): void;
}

export interface LocateHandle {
  /** One-shot geolocation with a typed result (UI-07). */
  (options?: LocateOptions): Promise<LocateResult>;
  /** Starts a watch; updates stop after `cancel()` or map destroy. */
  watch(options: LocateWatchOptions): LocateWatch;
}

/** HTML feature detail service (UI-05/06); one detail is open at a time. */
export interface DetailServiceHandle {
  open(ref: FeatureRef, options: DetailOptions): DetailHandle;
  close(): void;
  current(): DetailHandle | null;
}

/* Public type surface of the UI modules (re-exported by the package facade). */
export type {
  ControlHandle,
  ControlKind,
  ControlLayerEntry,
  ControlPosition,
  ControlSpec,
  ListControlOptions,
} from './ui/controls.ts';
export type {
  DetailContent,
  DetailContentFactory,
  DetailHandle,
  DetailOptions,
} from './ui/detail.ts';
export type {
  LocateErrorCode,
  LocateOptions,
  LocateResult,
  LocateWatch,
  LocateWatchOptions,
  LocatedPosition,
} from './ui/locate.ts';

export interface MapHandle {
  readonly id: string;
  readonly view: ViewHandle;
  readonly assets: AssetsHandle;
  readonly sources: SourcesHandle;
  readonly layers: LayersHandle;
  readonly groups: GroupsHandle;
  readonly state: StateHandle;
  readonly selection: SelectionHandle;
  readonly relations: RelationsHandle;
  readonly bindings: BindingsHandle;
  readonly query: QueryHandle;
  /** Gesture configuration; `null` when the map is headless or non-interactive. */
  readonly interaction: InteractionHandle | null;
  /** Opt-in HTML controls; `null` when the map has no container (headless). */
  readonly controls: ControlsHandle | null;
  /** HTML feature detail (UI-05/06); independent of the drawing objects. */
  readonly detail: DetailServiceHandle;
  /** Geolocation with typed results and a stable cancel contract (UI-07). */
  readonly locate: LocateHandle;
  /** Read-only diagnostics; used by tests and the demo statistics panel. */
  readonly debug: DebugHandle;
  batch<T>(fn: () => T): Commit;
  whenRendered(revision?: number, options?: { readonly signal?: AbortSignal }): Promise<void>;
  capabilities(): Capabilities;
  stats(): MapStats;
  on<K extends keyof SceneEventTypes>(type: K, fn: (event: SceneEventTypes[K]) => void, options?: SubscribeOptions): Off;
  once<K extends keyof SceneEventTypes>(type: K, fn: (event: SceneEventTypes[K]) => void, options?: SubscribeOptions): Off;
  off<K extends keyof SceneEventTypes>(type: K, fn: (event: SceneEventTypes[K]) => void): void;
  destroy(): void;
  readonly destroyed: boolean;
  /** Exposes the current size used for layout (CSS px). */
  size(): { readonly width: number; readonly height: number };
}

export type SceneEventTypes = SceneEventMap;

/* -------------------------------------------------------------------------- */
/* Backend swap proxy                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One stable backend object for the frame driver, interaction controller and
 * public handle while the real backend is replaced after a device/context loss
 * (GPU-07..09). Canonical data, view, selection, bindings and generation
 * counters live in the scene, so a swap never changes public identity.
 */
class SwappableBackend implements MapBackend {
  private inner: MapBackend;
  private failure: string | null = null;
  private lossListener: ((message: string) => void) | null = null;

  constructor(inner: MapBackend) {
    this.inner = inner;
  }

  get kind(): 'webgl1' | 'webgpu' {
    return this.inner.kind;
  }

  get notes(): readonly string[] {
    return this.inner.notes;
  }

  get current(): MapBackend {
    return this.inner;
  }

  /** Replaces the lost backend; the listener keeps following the new one. */
  swap(next: MapBackend): void {
    this.inner = next;
    this.failure = null;
    this.watch(next);
  }

  /** Both recovery paths failed: GPU operations now report a defined error. */
  markFailed(reason: string): void {
    this.failure = reason;
    this.inner.destroy();
  }

  attach(scene: Scene): void {
    if (!this.failure) this.inner.attach(scene);
  }

  resize(width: number, height: number): void {
    if (!this.failure) this.inner.resize(width, height);
  }

  requestFrame(scene: Scene): void {
    if (!this.failure) this.inner.requestFrame(scene);
  }

  pick(
    scene: Scene,
    point: ScreenPoint,
    options: { readonly limit: number },
  ): Promise<readonly PickResult[]> {
    if (this.failure) {
      fail('gpu-unavailable', this.failure, {});
    }
    return this.inner.pick(scene, point, options);
  }

  samplePixel(scene: Scene, point: ScreenPoint): Promise<{ r: number; g: number; b: number; a: number }> {
    if (this.failure) {
      fail('gpu-unavailable', this.failure, {});
    }
    return this.inner.samplePixel(scene, point);
  }

  onLost(listener: (message: string) => void): void {
    this.lossListener = listener;
    this.watch(this.inner);
  }

  simulateLoss(): void {
    if (!this.failure) this.inner.simulateLoss();
  }

  dispose(): void {
    this.inner.dispose?.();
  }

  destroy(): void {
    this.inner.destroy();
  }

  private watch(backend: MapBackend): void {
    backend.onLost((message) => {
      // Ignore events from a backend that was already replaced or when the map
      // has given up on GPU recovery.
      if (this.inner !== backend || this.failure) return;
      this.lossListener?.(message);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* createMap                                                                   */
/* -------------------------------------------------------------------------- */

export async function createMap(options: MapOptions): Promise<MapHandle> {
  assertArgument(options !== null && typeof options === 'object', 'createMap expects an options object');
  const projection = options.projection ?? crsRegistry.webMercator();
  assertArgument(
    typeof projection === 'object' &&
      projection !== null &&
      typeof (projection as Crs).toWorld === 'function' &&
      typeof (projection as Crs).fromWorld === 'function' &&
      typeof (projection as Crs).normalize === 'function',
    'projection must be a CRS object; use crs.webMercator() or crs.define(...)',
  );
  const renderer = options.renderer ?? {};
  const primary = renderer.primary ?? 'webgpu';
  const fallback = renderer.fallback === undefined ? 'webgl1' : renderer.fallback;
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 24;
  assertArgument(
    Number.isFinite(minZoom) && Number.isFinite(maxZoom) && minZoom <= maxZoom,
    'invalid zoom limits',
    { minZoom, maxZoom },
  );
  const clock = options.clock ?? defaultClock();
  const headless = primary === 'none';

  const scene = new Scene(projection, clock);
  let backend: MapBackend | null = null;
  /** Stable proxy handed to the driver/controller/handle; real backend may swap. */
  let backendProxy: MapBackend | null = null;
  let container: HTMLElement | null = null;
  let width: number;
  let height: number;
  let dpr = 1;

  const sizeOption = options.size ?? { width: 800, height: 600 };

  if (!headless) {
    if (typeof document === 'undefined') {
      fail(
        'environment',
        'createMap with a GPU renderer requires a browser environment; use renderer.primary = "none" for DOM-free logic scenes',
        { renderer: primary },
      );
    }
    container = resolveContainer(options.container);
    const rect = container.getBoundingClientRect();
    width = rect.width > 0 ? rect.width : sizeOption.width;
    height = rect.height > 0 ? rect.height : sizeOption.height;
    dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  } else {
    width = sizeOption.width;
    height = sizeOption.height;
  }

  const view = new ViewImpl(
    projection,
    scene,
    { width, height, minZoom, maxZoom, maxBounds: options.maxBounds ?? null },
    options.view?.center ?? defaultCenter(projection),
    options.view?.zoom ?? 2,
    clock,
  );
  scene.attachView(view);

  if (!headless) {
    const attempts: BackendKind[] = [primary];
    if (fallback && fallback !== primary) attempts.push(fallback);
    const notes: string[] = [];
    for (const kind of attempts) {
      try {
        backend = await createBackend(kind, {
          container: container!,
          crs: projection,
          width,
          height,
          dpr,
        });
        break;
      } catch (error) {
        const message =
          isMapletError(error) ? `${error.code}: ${error.message}` : String(error);
        notes.push(`${kind} unavailable (${message})`);
        backend = null;
      }
    }
    if (!backend) {
      scene.destroy();
      fail('gpu-unavailable', 'no usable GPU backend is available', {
        requestedPrimary: primary,
        requestedFallback: fallback,
        notes,
      });
    }
    const swappable = new SwappableBackend(backend);
    backendProxy = swappable;
    swappable.attach(scene);
    scene.setFrameDriver(swappable);
    scene.setCapabilities({
      backend: swappable.kind,
      requestedPrimary: primary,
      requestedFallback: fallback,
      notes: Object.freeze([...notes, ...swappable.notes]),
    });

    // Device/context loss recovery (GPU-07..10): the internal canvas and backend
    // may be replaced while the public handle and all scene state (identity,
    // generations, view, selection, bindings) stay. Recovery follows the same
    // policy as creation: the lost backend first, then the configured fallback.
    const backendInit: BackendInitOptions = {
      container: container!,
      crs: projection,
      width,
      height,
      dpr,
    };
    let recovering = false;
    let pendingLoss: string | null = null;
    const insideRecovery = (): void => {
      recovering = false;
      const queued = pendingLoss;
      pendingLoss = null;
      if (queued && !scene.destroyed) void recoverBackend(queued);
    };
    const recoverBackend = async (message: string): Promise<void> => {
      if (scene.destroyed) return;
      if (recovering) {
        pendingLoss = message;
        return;
      }
      recovering = true;
      const recoveryNotes = [`${swappable.kind} lost (${message})`];
      const order: BackendKind[] = [swappable.kind];
      if (fallback && fallback !== swappable.kind) order.push(fallback);
      for (const kind of order) {
        let next: MapBackend;
        try {
          next = await createBackend(kind, backendInit);
        } catch (error) {
          const detail = isMapletError(error) ? `${error.code}: ${error.message}` : String(error);
          recoveryNotes.push(`${kind} recovery failed (${detail})`);
          continue;
        }
        if (scene.destroyed) {
          next.destroy();
          insideRecovery();
          return;
        }
        next.attach(scene);
        const size = view.size;
        next.resize(size.width, size.height);
        const previous = swappable.current;
        swappable.swap(next);
        previous.destroy();
        scene.setCapabilities({
          backend: next.kind,
          requestedPrimary: primary,
          requestedFallback: fallback,
          notes: Object.freeze([...recoveryNotes, ...next.notes]),
        });
        scene.requestFrame();
        scene.emitter.emit('backend', {
          type: 'backend',
          backend: next.kind,
          message: `recovered after loss: ${message}`,
        });
        insideRecovery();
        return;
      }
      // Both paths failed: announce the error and stop retrying (GPU-10).
      swappable.markFailed(recoveryNotes.join('; '));
      scene.setCapabilities({
        backend: 'unavailable',
        requestedPrimary: primary,
        requestedFallback: fallback,
        notes: Object.freeze(recoveryNotes),
      });
      scene.emitter.emit('backend', {
        type: 'backend',
        backend: 'unavailable',
        message: `no GPU backend could be recovered: ${message}`,
      });
      insideRecovery();
    };
    swappable.onLost((message) => void recoverBackend(message));
  } else {
    scene.setCapabilities({
      backend: 'none',
      requestedPrimary: 'none',
      requestedFallback: false,
      notes: Object.freeze(['headless scene: no pixels are produced']),
    });
    scene.setFrameDriver(null);
  }

  let controller: InteractionController | null = null;
  if (!headless && options.interactive !== false && container) {
    controller = new InteractionController(container, scene, view, backendProxy!, options.interaction ?? {});
  }

  let resizeObserver: ResizeObserver | null = null;
  if (container && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      const rect = container!.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      view.resize(rect.width, rect.height);
      backendProxy?.resize(rect.width, rect.height);
    });
    resizeObserver.observe(container);
  }

  const map = buildHandle(scene, view, backendProxy, controller, container, () => {
    resizeObserver?.disconnect();
    controller?.destroy();
  });
  return map;
}

function defaultCenter(projection: Crs): Position {
  return projection.positionKind === 'geographic'
    ? { lat: 0, lng: 0 }
    : { x: 0, y: 0 };
}

function resolveContainer(input: HTMLElement | string | undefined): HTMLElement {
  if (input === undefined) {
    fail('invalid-argument', 'createMap requires a container element or id');
  }
  if (typeof input === 'string') {
    const element = document.getElementById(input);
    if (!element) {
      fail('invalid-argument', `container element not found: #${input}`, { container: input });
    }
    return element;
  }
  if (typeof input !== 'object' || typeof (input as HTMLElement).appendChild !== 'function') {
    fail('invalid-argument', 'container must be an element or an element id', {});
  }
  return input as HTMLElement;
}

/* -------------------------------------------------------------------------- */
/* Handle construction                                                         */
/* -------------------------------------------------------------------------- */

function buildHandle(
  scene: Scene,
  view: ViewImpl,
  backend: MapBackend | null,
  controller: InteractionController | null,
  container: HTMLElement | null,
  onDestroy: () => void,
): MapHandle {
  const worldScale = (): number => Math.pow(2, view.zoom);
  const currentPlanOptions = (): { deviceWidth: number; deviceHeight: number; dpr: number } => {
    const size = view.size;
    return {
      deviceWidth: Math.max(1, Math.round(size.width)),
      deviceHeight: Math.max(1, Math.round(size.height)),
      dpr: 1,
    };
  };

  const viewHandle: ViewHandle = {
    get() {
      scene.assertAlive('view.get');
      return view.getSnapshot();
    },
    set(update) {
      scene.assertAlive('view.set');
      return view.set(update);
    },
    fit(bounds, options) {
      scene.assertAlive('view.fit');
      return view.fit(bounds, options);
    },
    flyTo(update, options) {
      scene.assertAlive('view.flyTo');
      return view.flyTo(update, options);
    },
    stop() {
      scene.assertAlive('view.stop');
      view.stop();
    },
    zoomAround(screen, deltaZoom) {
      scene.assertAlive('view.zoomAround');
      return view.zoomAround(screen, deltaZoom);
    },
    resize(w, h) {
      scene.assertAlive('view.resize');
      view.resize(w, h);
      backend?.resize(w, h);
    },
    positionToScreen(position) {
      scene.assertAlive('view.positionToScreen');
      return view.positionToScreen(position);
    },
    screenToPosition(screen) {
      scene.assertAlive('view.screenToPosition');
      return view.screenToPosition(screen);
    },
    getBounds() {
      scene.assertAlive('view.getBounds');
      return view.getBounds();
    },
  };

  const sources: SourcesHandle = {
    vector<G, P>(options: { readonly id: string }) {
      scene.assertAlive('sources.vector');
      assertArgument(options?.id, 'sources.vector requires an id');
      return scene.createVectorSource(options.id) as unknown as VectorSourceHandle<G, P>;
    },
    rasterTiles(options) {
      scene.assertAlive('sources.rasterTiles');
      assertArgument(options?.id, 'sources.rasterTiles requires an id');
      assertArgument(typeof options.url === 'string' && options.url.length > 0, 'rasterTiles requires a url template');
      return scene.createRasterSource(options.id, 'rasterTiles', options);
    },
    wms(options) {
      scene.assertAlive('sources.wms');
      assertArgument(options?.id, 'sources.wms requires an id');
      assertArgument(typeof options.url === 'string' && options.url.length > 0, 'wms requires a url');
      assertArgument(typeof options.layers === 'string' && options.layers.length > 0, 'wms requires layers');
      return scene.createRasterSource(options.id, 'wms', options);
    },
    image(options) {
      scene.assertAlive('sources.image');
      assertArgument(options?.id, 'sources.image requires an id');
      assertArgument(options.bounds, 'sources.image requires bounds');
      assertArgument(
        typeof options.url === 'string' || options.pixels !== undefined,
        'sources.image requires a url or pixels',
      );
      return scene.createMediaSource('image', options);
    },
    video(options) {
      scene.assertAlive('sources.video');
      assertArgument(options?.id, 'sources.video requires an id');
      assertArgument(options.bounds, 'sources.video requires bounds');
      assertArgument(typeof options.url === 'string' && options.url.length > 0, 'sources.video requires a url');
      return scene.createMediaSource('video', options);
    },
    vectorTiles(options) {
      scene.assertAlive('sources.vectorTiles');
      assertArgument(options?.id, 'sources.vectorTiles requires an id');
      assertArgument(
        typeof options.url === 'string' && options.url.length > 0,
        'vectorTiles requires a url template',
      );
      return scene.createVectorTileSource(options);
    },
    get(id) {
      scene.assertAlive('sources.get');
      return scene.getSourceHandle(id);
    },
    list() {
      return scene.listSources();
    },
    remove(id, removeOptions) {
      scene.removeSource(id, removeOptions);
    },
  };

  const layerHandles = new Map<string, LayerHandle>();

  const buildLayerHandle = (layer: LayerImpl): LayerHandle => {
    const handle: LayerHandle = {
      id: layer.id,
      get kind() {
        return layer.kind;
      },
      get sourceId() {
        return layer.sourceId;
      },
      setVisible(visible) {
        scene.assertAlive('layer.setVisible');
        scene.layers.setVisible(layer.id, visible);
      },
      getVisible() {
        return scene.layers.isEffectivelyVisible(layer);
      },
      setFilter(filter) {
        scene.assertAlive('layer.setFilter');
        layer.filter = filter;
        layer.touch();
        scene.publishStateChange();
      },
      setStyle(style) {
        scene.assertAlive('layer.setStyle');
        layer.style = style as typeof layer.style;
        layer.touch();
        scene.publishStateChange();
      },
      features: {
        setOverride(target, override) {
          scene.assertAlive('layer.features.setOverride');
          const ref = resolveLayerTarget(scene, layer, target);
          layer.setOverride(ref, override);
          scene.publishStateChange();
        },
        clearOverride(target) {
          scene.assertAlive('layer.features.clearOverride');
          const ref = resolveLayerTarget(scene, layer, target);
          layer.clearOverride(ref);
          scene.publishStateChange();
        },
        hasOverride(target) {
          const ref = resolveLayerTarget(scene, layer, target);
          return layer.overrides.has(layer.overrideKey(ref));
        },
        getOverride(target) {
          const ref = resolveLayerTarget(scene, layer, target);
          return layer.overrides.get(layer.overrideKey(ref));
        },
      },
      on(type, fn, options) {
        scene.assertAlive('layer.on');
        void type; // only 'feature' exists at layer level for now
        return layer.featureEmitter.on('feature', fn, options);
      },
      remove() {
        scene.assertAlive('layer.remove');
        removeLayer(layer.id);
      },
    };
    return handle;
  };

  const buildGroupHandle = (group: GroupImpl): GroupHandle => ({
    id: group.id,
    setVisible(visible) {
      scene.assertAlive('group.setVisible');
      scene.layers.setVisible(group.id, visible);
    },
    getVisible() {
      return group.visible;
    },
    on(type, fn, options) {
      scene.assertAlive('group.on');
      void type;
      return group.featureEmitter.on('feature', fn, options);
    },
    remove() {
      scene.assertAlive('group.remove');
      scene.layers.remove(group.id);
    },
  });

  const removeLayer = (id: string): void => {
    const layer = scene.layers.get(id);
    if (!layer) return;
    scene.layers.remove(id);
    scene.removeDependent(layer.sourceId, dependentFor(id));
    layerHandles.delete(id);
  };

  const dependents = new Map<string, { kind: 'layer'; id: string; remove: () => void }>();
  const dependentFor = (id: string): { kind: 'layer'; id: string; remove: () => void } => {
    let dependent = dependents.get(id);
    if (!dependent) {
      dependent = { kind: 'layer', id, remove: () => removeLayer(id) };
      dependents.set(id, dependent);
    }
    return dependent;
  };

  const checkLayerSource = (spec: LayerSpec): void => {
    const sourceId = typeof spec.source === 'string' ? spec.source : spec.source.id;
    const vector = scene.getSourceImpl(sourceId);
    const raster = scene.getRasterSource(sourceId);
    const media = scene.getMediaSource(sourceId);
    if (!vector && !raster && !media) {
      fail('not-found', `layer ${spec.id}: source not found: ${sourceId}`, { sourceId });
    }
    const rasterKind = spec.type === 'raster';
    if (rasterKind && !raster && !media) {
      fail('invalid-argument', `layer ${spec.id}: raster layer requires a raster or media source`, {
        sourceId,
      });
    }
    if (!rasterKind && !vector) {
      fail('invalid-argument', `layer ${spec.id}: ${spec.type} layer requires a vector source`, {
        sourceId,
      });
    }
  };

  const layers: LayersHandle = {
    add(spec) {
      scene.assertAlive('layers.add');
      assertArgument(spec?.id, 'layers.add requires an id');
      assertArgument(spec?.type, 'layers.add requires a type');
      checkLayerSource(spec);
      const layer = scene.layers.add(spec);
      const sourceId = layer.sourceId;
      scene.addDependent(sourceId, dependentFor(layer.id));
      const handle = buildLayerHandle(layer);
      layerHandles.set(layer.id, handle);
      return handle;
    },
    get(id) {
      const layer = scene.layers.get(id);
      if (!layer) return undefined;
      let handle = layerHandles.get(id);
      if (!handle) {
        handle = buildLayerHandle(layer);
        layerHandles.set(id, handle);
      }
      return handle;
    },
    list() {
      return scene.layers.list().map((layer) => {
        let handle = layerHandles.get(layer.id);
        if (!handle) {
          handle = buildLayerHandle(layer);
          layerHandles.set(layer.id, handle);
        }
        return handle;
      });
    },
    update(id, patch) {
      scene.assertAlive('layers.update');
      scene.layers.update(id, patch);
    },
    remove(id) {
      scene.assertAlive('layers.remove');
      if (!scene.layers.get(id) && !scene.layers.getGroup(id)) {
        fail('not-found', `layer or group not found: ${id}`, { id });
      }
      removeLayer(id);
    },
    move(id, target) {
      scene.assertAlive('layers.move');
      scene.layers.move(id, target);
    },
  };

  const groups: GroupsHandle = {
    add(spec) {
      scene.assertAlive('groups.add');
      return buildGroupHandle(scene.layers.addGroup(spec));
    },
    get(id) {
      const group = scene.layers.getGroup(id);
      return group ? buildGroupHandle(group) : undefined;
    },
    list() {
      return scene.layers.listGroups().map(buildGroupHandle);
    },
    remove(id) {
      scene.assertAlive('groups.remove');
      scene.layers.remove(id);
    },
    move(id, target) {
      scene.assertAlive('groups.move');
      scene.layers.move(id, target);
    },
    setVisible(id, visible) {
      scene.assertAlive('groups.setVisible');
      scene.layers.setVisible(id, visible);
    },
  };

  const assets: AssetsHandle = {
    addImage(spec) {
      scene.assertAlive('assets.addImage');
      assertArgument(spec?.id, 'assets.addImage requires an id');
      assertArgument(spec?.src, 'assets.addImage requires a src');
      return scene.createImageAsset(spec.id, spec.src);
    },
    get(id) {
      const impl = scene.assets.get(id);
      return impl ? createImageAssetHandle(impl) : undefined;
    },
    list() {
      return scene.assets.list().map(createImageAssetHandle);
    },
    addFont(spec) {
      scene.assertAlive('assets.addFont');
      assertArgument(spec?.id, 'assets.addFont requires an id');
      assertArgument(spec?.family, 'assets.addFont requires a family');
      assertArgument(spec?.src, 'assets.addFont requires a src');
      return scene.createFontAsset(spec.id, spec.family, spec.src);
    },
    getFont(id) {
      const impl = scene.assets.getFont(id);
      return impl ? createFontAssetHandle(impl) : undefined;
    },
    listFonts() {
      return scene.assets.listFonts().map(createFontAssetHandle);
    },
    remove(id) {
      scene.assertAlive('assets.remove');
      scene.removeAsset(id);
    },
  };

  const state: StateHandle = {
    get(ref) {
      scene.assertAlive('state.get');
      return scene.state.get(ref);
    },
    set(ref, patch) {
      scene.assertAlive('state.set');
      scene.state.set(ref, patch);
    },
    subscribe(fn, options) {
      return scene.state.subscribe(fn, options);
    },
  };

  const selection: SelectionHandle = {
    get() {
      scene.assertAlive('selection.get');
      return scene.selection.get();
    },
    set(refs) {
      scene.assertAlive('selection.set');
      assertArgument(Array.isArray(refs), 'selection.set expects an array of references');
      scene.selection.set(refs);
    },
    add(refs) {
      scene.assertAlive('selection.add');
      assertArgument(Array.isArray(refs), 'selection.add expects an array of references');
      scene.selection.add(refs);
    },
    remove(refs) {
      scene.assertAlive('selection.remove');
      assertArgument(Array.isArray(refs), 'selection.remove expects an array of references');
      scene.selection.remove(refs);
    },
    clear() {
      scene.assertAlive('selection.clear');
      scene.selection.clear();
    },
    subscribe(fn, options) {
      return scene.selection.subscribe(fn, options);
    },
  };

  const relations: RelationsHandle = {
    add(input) {
      scene.assertAlive('relations.add');
      return scene.runImplicit(() => scene.relations.add(input));
    },
    get(id) {
      scene.assertAlive('relations.get');
      return scene.relations.get(id);
    },
    remove(id) {
      scene.assertAlive('relations.remove');
      scene.runImplicit(() => scene.relations.remove(id));
    },
    list(filter) {
      scene.assertAlive('relations.list');
      return scene.relations.list(filter);
    },
    neighbors(ref, options) {
      scene.assertAlive('relations.neighbors');
      return scene.relations.neighbors(ref, options);
    },
    traverse(ref, options) {
      scene.assertAlive('relations.traverse');
      return scene.relations.traverse(ref, options);
    },
    subscribe(fn, options) {
      return scene.relations.subscribe(fn, options);
    },
    setEndpointPolicy(policy) {
      scene.assertAlive('relations.setEndpointPolicy');
      scene.relations.setDefaultEndpointPolicy(policy);
    },
  };

  const bindings: BindingsHandle = {
    add(input) {
      scene.assertAlive('bindings.add');
      return scene.runImplicit(() => scene.bindings.add(input));
    },
    get(id) {
      scene.assertAlive('bindings.get');
      return scene.bindings.get(id);
    },
    update(id, input) {
      scene.assertAlive('bindings.update');
      return scene.runImplicit(() => scene.bindings.update(id, input));
    },
    remove(id) {
      scene.assertAlive('bindings.remove');
      scene.runImplicit(() => scene.bindings.remove(id));
    },
    list() {
      scene.assertAlive('bindings.list');
      return scene.bindings.list();
    },
    subscribe(fn, options) {
      return scene.bindings.subscribe(fn, options);
    },
  };

  const filterHits = (
    hits: readonly { record: import('./scene/store.ts').SlotRecord; source: import('./scene/source.ts').SourceImpl }[],
    options: { readonly sources?: readonly string[]; readonly namespace?: string },
  ): typeof hits => {
    let filtered = hits;
    if (options.sources) {
      const allowed = new Set(options.sources);
      filtered = filtered.filter((hit) => allowed.has(hit.source.id));
    }
    if (options.namespace !== undefined) {
      filtered = filtered.filter((hit) => hit.record.namespace === options.namespace);
    }
    return filtered;
  };

  const query: QueryHandle = {
    at(position, options = {}) {
      scene.assertAlive('query.at');
      const tolerancePx = options.tolerancePx ?? 4;
      const toleranceWorld = tolerancePx / worldScale();
      const world = scene.crs.toWorld(scene.crs.normalize(position));
      const hits = filterHits(queryDataAt(vectorSources(scene), world, toleranceWorld), options);
      const limit = options.limit ?? hits.length;
      return hits.slice(0, limit).map((hit) => hit.source.snapshotOf(hit.record));
    },
    area(bounds, options = {}) {
      scene.assertAlive('query.area');
      if (options.cursor && options.cursor.revision !== scene.revision) {
        fail('invalid-state', 'query cursor belongs to an older revision', {
          cursorRevision: options.cursor.revision,
          revision: scene.revision,
        });
      }
      const rect = boundsToWorldRect(scene.crs, bounds as never);
      const hits = filterHits(queryDataRect(vectorSources(scene), rect, options.relation ?? 'intersects'), options);
      const offset = options.cursor?.offset ?? 0;
      const limit = options.limit ?? 100;
      const page = hits.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const next: QueryCursor | null =
        nextOffset < hits.length ? { offset: nextOffset, revision: scene.revision } : null;
      return {
        items: page.map((hit) => hit.source.snapshotOf(hit.record)),
        next,
      };
    },
    async rendered(point, options = {}) {
      scene.assertAlive('query.rendered');
      if (!backend) {
        fail('unsupported-capability', 'rendered queries require a GPU backend', {});
      }
      const results = await backend.pick(scene, point, { limit: options.limit ?? 1 });
      return results;
    },
  };

  const debug: DebugHandle = {
    layerOrder() {
      return scene.layers.flattenAll().map((layer) => layer.id);
    },
    countLayerRecords(layerId) {
      const layer = scene.layers.get(layerId);
      if (!layer) fail('not-found', `layer not found: ${layerId}`, { id: layerId });
      const source = scene.getSourceImpl(layer.sourceId);
      if (!source) return 0;
      const filter = compileFilter(layer.filter);
      let count = 0;
      source.store.forEachLive((record) => {
        if (layer.namespace !== undefined && record.namespace !== layer.namespace) return;
        const state = scene.state.stateOf(source, record);
        const ref = source.refOf(record);
        if (layer.overrides.get(layer.overrideKey(ref))?.visible === false) return;
        if (scene.bindings.isTargetHidden(ref)) return;
        if (filter({ state, id: record.id }, record.properties)) count++;
      });
      return count;
    },
    layerInstances(layerId) {
      const plan = buildFramePlan(scene, currentPlanOptions());
      let total = 0;
      for (const draw of plan.draws) {
        if (draw.type !== 'batch' || draw.batch.layerId !== layerId) continue;
        total += draw.batch.kind === 'fills' ? draw.batch.count / 3 : draw.batch.count;
      }
      return Math.round(total);
    },
    layerColor(layerId) {
      const plan = buildFramePlan(scene, currentPlanOptions());
      for (const draw of plan.draws) {
        if (draw.type !== 'batch' || draw.batch.layerId !== layerId) continue;
        const data = draw.batch.data;
        if (data.length === 0) continue;
        if (draw.batch.kind === 'points') {
          return rgbaHex(data[4]!, data[5]!, data[6]!);
        }
        if (draw.batch.kind === 'lines') {
          return rgbaHex(data[8]!, data[9]!, data[10]!);
        }
        return rgbaHex(data[4]!, data[5]!, data[6]!);
      }
      return null;
    },
    layerPickOrder(layerId) {
      const plan = buildFramePlan(scene, currentPlanOptions());
      const order: (string | number)[] = [];
      for (const draw of plan.draws) {
        if (draw.type !== 'batch' || draw.batch.layerId !== layerId) continue;
        const stride = draw.batch.kind === 'fills' ? 12 : draw.batch.kind === 'lines' ? 16 : 16;
        const pickOffset = draw.batch.kind === 'fills' ? 8 : draw.batch.kind === 'lines' ? 6 : 14;
        const count = draw.batch.kind === 'fills' ? draw.batch.count / 3 : draw.batch.count;
        for (let i = 0; i < count; i++) {
          const pickIndex = draw.batch.data[i * stride + pickOffset]!;
          const entry = plan.pickTable[pickIndex];
          if (!entry) continue;
          order.push(entry.feature.id);
        }
      }
      return order;
    },
    layerTiles(layerId) {
      const plan = buildFramePlan(scene, currentPlanOptions());
      for (const draw of plan.draws) {
        if (draw.type === 'tiles' && draw.tiles[0]?.layerId === layerId) return draw.tiles;
      }
      return [];
    },
    layerMedia(layerId) {
      const plan = buildFramePlan(scene, currentPlanOptions());
      for (const draw of plan.draws) {
        if (draw.type === 'media' && draw.media[0]?.layerId === layerId) return draw.media;
      }
      return [];
    },
    layerLabels(layerId) {
      const plan = buildFramePlan(scene, currentPlanOptions());
      for (const draw of plan.draws) {
        if (draw.type === 'labels' && draw.labels[0]?.layerId === layerId) return draw.labels;
      }
      return [];
    },
    layerSprites(layerId) {
      const plan = buildFramePlan(scene, currentPlanOptions());
      for (const draw of plan.draws) {
        if (draw.type === 'sprites' && draw.sprites[0]?.layerId === layerId) return draw.sprites;
      }
      return [];
    },
    planBuildCount() {
      return framePlanBuildCount();
    },
    relationsScanCount() {
      return scene.relations.scanCount;
    },
    bindingsEvaluatedCount() {
      return scene.bindings.evaluatedCount;
    },
    imports() {
      return scene.importPipeline.debug();
    },
    async samplePixel(point) {
      scene.assertAlive('debug.samplePixel');
      if (!backend) {
        fail('unsupported-capability', 'pixel sampling requires a GPU backend', {});
      }
      return backend.samplePixel(scene, point);
    },
    forceBackendLoss() {
      scene.assertAlive('debug.forceBackendLoss');
      if (!backend) {
        fail('unsupported-capability', 'forcing backend loss requires a GPU backend', {});
      }
      backend.simulateLoss();
    },
  };

  let destroyed = false;

  const controlsHost = container
    ? new ControlsHost(container, {
        zoom: {
          get: () => {
            const limits = view.zoomLimits;
            return {
              zoom: view.getSnapshot().zoom,
              minZoom: limits.minZoom,
              maxZoom: limits.maxZoom,
            };
          },
          stepBy: (delta) => {
            view.set({ zoom: view.getSnapshot().zoom + delta });
          },
        },
        layers: {
          list: () => [
            ...scene.layers.listGroups().map((group) => ({
              id: group.id,
              kind: 'group' as const,
              visible: group.visible,
            })),
            ...scene.layers
              .list()
              .filter((layer) => layer.parent === null)
              .map((layer) => ({ id: layer.id, kind: 'layer' as const, visible: layer.visible })),
          ],
          setVisible: (id, visible) => {
            scene.layers.setVisible(id, visible);
          },
        },
        attributions: {
          list: () =>
            attributionsForLayers(
              scene.listSources().map((id) => ({
                sourceId: id,
                attribution:
                  scene.getRasterSource(id)?.options.attribution ??
                  scene.getVectorTileSource(id)?.options.attribution ??
                  null,
              })),
              scene.layers.list().map((layer) => ({ sourceId: layer.sourceId })),
            ),
        },
        view: {
          get: () => {
            const snapshot = view.getSnapshot();
            const centerLat =
              scene.crs.positionKind === 'geographic' && 'lat' in snapshot.center
                ? snapshot.center.lat
                : 0;
            return { zoom: snapshot.zoom, centerLat, positionKind: scene.crs.positionKind };
          },
        },
        results: {
          list: (options: ListControlOptions) => {
            const bounds = view.getBounds();
            if (!bounds) return [];
            const rect = boundsToWorldRect(scene.crs, bounds as never);
            const hitOptions: { sources?: readonly string[] } = {};
            if (options.sources) hitOptions.sources = options.sources;
            const hits = filterHits(queryDataRect(vectorSources(scene), rect, 'intersects'), hitOptions);
            const limit = Math.max(1, Math.min(50, options.limit ?? 10));
            return hits.slice(0, limit).map((hit) => hit.source.snapshotOf(hit.record));
          },
        },
        selection: {
          list: () => scene.selection.get(),
          set: (refs) => scene.selection.set([...refs]),
        },
        onChange: (fn) => {
          const offCommit = scene.emitter.on('commit', fn);
          const offView = scene.emitter.on('viewchange', fn);
          return () => {
            offCommit();
            offView();
          };
        },
      })
    : null;

  const controls: ControlsHandle | null = controlsHost
    ? {
        add(spec: ControlSpec) {
          scene.assertAlive('controls.add');
          return controlsHost.add(spec);
        },
        get(id: string) {
          return controlsHost.get(id);
        },
        list() {
          return controlsHost.list();
        },
        remove(id: string) {
          scene.assertAlive('controls.remove');
          controlsHost.remove(id);
        },
      }
    : null;

  const locator = createLocator(() =>
    typeof navigator !== 'undefined' && 'geolocation' in navigator
      ? (navigator.geolocation as unknown as GeolocationLike)
      : undefined,
  );
  const activeWatches = new Set<LocateWatch>();
  const applyLocatedView = (
    position: { lat: number; lng: number },
    setView: LocateOptions['setView'],
  ): void => {
    if (!setView || scene.crs.positionKind !== 'geographic') return;
    const zoom = typeof setView === 'object' && setView.zoom !== undefined ? setView.zoom : undefined;
    const center = { lat: position.lat, lng: position.lng };
    view.set(zoom === undefined ? { center } : { center, zoom });
  };
  const locate = Object.assign(
    async (options?: LocateOptions): Promise<LocateResult> => {
      scene.assertAlive('locate');
      const result = await locator.locate(options);
      if (result.ok) applyLocatedView(result.position, options?.setView);
      return result;
    },
    {
      watch(options: LocateWatchOptions): LocateWatch {
        scene.assertAlive('locate.watch');
        const inner = locator.watch({
          ...options,
          onUpdate: (result) => {
            if (result.ok) applyLocatedView(result.position, options.setView);
            options.onUpdate?.(result);
          },
        });
        let active = true;
        const handle: LocateWatch = {
          get active() {
            return active && inner.active;
          },
          cancel: () => {
            if (!active) return;
            active = false;
            inner.cancel();
            activeWatches.delete(handle);
          },
        };
        activeWatches.add(handle);
        return handle;
      },
    },
  );

  // Lazily created: a map without details subscribes to nothing and adds no DOM.
  let detailController: DetailController | null = null;
  const detailService: DetailServiceHandle = {
    open(ref: FeatureRef, options: DetailOptions) {
      scene.assertAlive('detail.open');
      if (!container) {
        fail('unsupported-capability', 'details require a map container', {});
      }
      detailController ??= new DetailController({
        container,
        snapshotOf: (target) => {
          if (scene.destroyed) return null;
          const source = scene.getSourceImpl(target.sourceId);
          if (!source) return null;
          try {
            return source.snapshotOf(source.resolveRef(target, 'detail'));
          } catch {
            return null;
          }
        },
        screenOf: (position) => view.positionToScreen(position),
        onChange: (fn) => {
          const offCommit = scene.emitter.on('commit', fn);
          const offView = scene.emitter.on('viewchange', fn);
          return () => {
            offCommit();
            offView();
          };
        },
      });
      return detailController.open(ref, options);
    },
    close() {
      detailController?.close();
    },
    current() {
      return detailController?.current() ?? null;
    },
  };

  const map: MapHandle = {
    id: scene.id,
    view: viewHandle,
    assets,
    sources,
    layers,
    groups,
    state,
    selection,
    relations,
    bindings,
    query,
    interaction: controller
      ? {
          setOptions(options) {
            controller.setOptions(options);
          },
          options() {
            return controller.allOptions();
          },
          destroy() {
            controller.destroy();
          },
        }
      : null,
    debug,
    controls,
    detail: detailService,
    locate,
    batch(fn) {
      scene.assertAlive('batch');
      assertArgument(typeof fn === 'function', 'batch expects a callback');
      return scene.batch(fn);
    },
    whenRendered(revision, options) {
      scene.assertAlive('whenRendered');
      return scene.whenRendered(revision ?? scene.revision, options?.signal);
    },
    capabilities() {
      return scene.capabilities();
    },
    stats() {
      const stats = scene.stats();
      return { ...stats, layers: scene.layers.list().length };
    },
    on(type, fn, options) {
      return scene.emitter.on(type, fn, options);
    },
    once(type, fn, options) {
      return scene.emitter.once(type, fn, options);
    },
    off(type, fn) {
      scene.emitter.off(type, fn);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // Watches stop before the scene dies so no update can arrive afterwards.
      for (const watch of [...activeWatches]) watch.cancel();
      detailController?.destroy();
      controlsHost?.destroy();
      onDestroy();
      backend?.destroy();
      scene.destroy();
    },
    get destroyed() {
      return scene.destroyed;
    },
    size() {
      return view.size;
    },
  };
  return map;
}

function rgbaHex(r: number, g: number, b: number): string {
  const byte = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value * 255))).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function vectorSources(scene: Scene): SourceImpl[] {
  const out: SourceImpl[] = [];
  for (const id of scene.listSources()) {
    const source = scene.getSourceImpl(id);
    if (source) out.push(source);
  }
  return out;
}

function resolveLayerTarget(
  scene: Scene,
  layer: LayerImpl,
  target: FeatureRef | string | number,
): FeatureRef {
  if (typeof target === 'object' && target !== null && 'id' in target && 'generation' in target) {
    return target as FeatureRef;
  }
  const source = scene.getSourceImpl(layer.sourceId);
  if (!source) {
    fail('not-found', `layer ${layer.id}: source no longer exists`, { sourceId: layer.sourceId });
  }
  const record = source.store.get(target as string | number, undefined);
  if (!record) {
    fail('not-found', `layer ${layer.id}: feature not found: ${String(target)}`, { id: target });
  }
  return source.refOf(record);
}

/* -------------------------------------------------------------------------- */
/* Type-only helpers for consumers                                             */
/* -------------------------------------------------------------------------- */

export type { FeatureInput, RasterSourceHandle, VectorSourceHandle };
