/**
 * Scene: the internal engine behind a `MapHandle`.
 *
 * Responsibilities:
 * - published revision (data/view/style changes) and rendered revision;
 * - transactions: implicit single-operation commits and `map.batch` groups with
 *   full rollback; binding evaluation runs inside the transaction so one revision
 *   never mixes an upstream change with an old dependent result (TX-01..TX-10);
 * - source registry, dependent bookkeeping and cascade removal checks;
 * - typed scene events, state/selection/relations/bindings stores;
 * - lifecycle: idempotent destroy that cancels pending work.
 *
 * The scene is never exposed directly; public handles are closure-based plain
 * objects built in map.ts (REF-01..REF-03).
 */

import { fail, MapletError } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import type { Capabilities, MapStats, PickStallStats } from '../api/types.ts';
import type { BackendKind } from '../api/types.ts';
import type { Crs } from '../math/crs.ts';
import { boundsToWorldRect } from './query.ts';
import { compileFilter } from './expression.ts';
import type { Position } from '../api/types.ts';
import { createSourceHandle, SourceImpl, type SourceCommitPayload, type VectorSourceHandle } from './source.ts';
import type { SlotRecord } from './store.ts';
import { RelationsStore } from './relations.ts';
import { BindingStore } from './bindings.ts';
import { SelectionStore, StateStore } from './state.ts';
import { LayerRegistry } from './layers.ts';
import { ImportPipeline } from '../io/import-pipeline.ts';
import {
  createRasterSourceHandle,
  RasterSourceImpl,
  type RasterSourceHandle,
  type RasterSourceKind,
} from './raster-source.ts';
import {
  AssetRegistry,
  createFontAssetHandle,
  createImageAssetHandle,
  type FontAssetHandle,
  type ImageAssetHandle,
} from './assets.ts';
import {
  createMediaSourceHandle,
  MediaSourceImpl,
  type ImageSourceOptions,
  type MediaSourceHandle,
  type MediaSourceKind,
  type VideoSourceOptions,
} from './media-source.ts';
import {
  VectorTileSourceImpl,
  type VectorTilesOptions,
  type VectorTilesSourceHandle,
} from './vector-tile-source.ts';
import type { RasterTilesOptions, WmsOptions } from '../formats/raster.ts';
import type { Clock, ViewImpl, ViewSnapshot } from '../view/view.ts';
import type { FeatureRef, MapFeatureEvent, MapPointerEvent } from '../api/types.ts';

export interface SceneEventMap {
  commit: { readonly revision: number };
  viewchange: { readonly type: 'viewchange'; readonly snapshot: ViewSnapshot };
  viewstart: { readonly type: 'viewstart'; readonly snapshot: ViewSnapshot };
  viewend: { readonly type: 'viewend'; readonly snapshot: ViewSnapshot };
  selectchange: { readonly revision: number; readonly selected: readonly FeatureRef[] };
  feature: MapFeatureEvent;
  pointer: MapPointerEvent;
  /**
   * Backend lifecycle announcement (GPU-07..10): emitted after a device/context
   * loss once recovery finishes, with the backend that is now active
   * (`'unavailable'` when both recovery paths failed).
   */
  backend: {
    readonly type: 'backend';
    readonly backend: BackendKind | 'unavailable';
    readonly message: string;
  };
  destroy: Record<string, never>;
}

export interface FrameDriver {
  /** Requests one frame; the driver must eventually call `scene.completeFrame()`. */
  requestFrame(scene: Scene): void;
  dispose?(): void;
}

export interface SourceDependent {
  readonly kind: 'layer' | 'binding' | 'relation' | 'group';
  readonly id: string;
  remove(): void;
}

let nextSceneNumber = 1;

export class Scene {
  readonly id: string;
  readonly crs: Crs;
  readonly emitter = new Emitter<SceneEventMap>();
  readonly clock: Clock;
  readonly relations: RelationsStore;
  readonly bindings: BindingStore;
  readonly state: StateStore;
  readonly selection: SelectionStore;
  readonly layers: LayerRegistry;

  private publishedRevision = 0;
  /** Broad render invalidation; view and local source edits do not bump it. */
  renderEpoch = 0;
  private renderedRevisionValue = 0;
  private framesValue = 0;
  private destroyedValue = false;
  private batchOpen = false;
  private batchFailed: unknown = null;
  private undoLog: (() => void)[] = [];
  private readonly pendingSources = new Set<SourceImpl>();
  private readonly sources = new Map<string, SourceImpl>();
  private readonly sourceHandles = new Map<string, VectorSourceHandle>();
  private readonly rasterSources = new Map<string, RasterSourceImpl>();
  private readonly rasterHandles = new Map<string, RasterSourceHandle>();
  private readonly mediaSources = new Map<string, MediaSourceImpl>();
  private readonly mediaHandles = new Map<string, MediaSourceHandle>();
  private readonly vectorTileSources = new Map<string, VectorTileSourceImpl>();
  private readonly vectorTileHandles = new Map<string, VectorTilesSourceHandle>();
  private readonly dependents = new Map<string, Set<SourceDependent>>();
  private readonly renderWaiters: {
    revision: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal | undefined;
    onAbort: (() => void) | null;
  }[] = [];
  private frameRequested = false;
  private frameDriver: FrameDriver | null = null;
  private view: ViewImpl | null = null;
  private finishing = false;
  private capabilitiesValue: Capabilities = {
    backend: 'unavailable',
    requestedPrimary: 'none',
    requestedFallback: false,
    notes: Object.freeze([]),
  };
  private renderedInstancesValue = 0;
  private drawCallsValue = 0;
  private gpuBytesValue = 0;
  private pickStatsValue: PickStallStats = {
    picks: 0,
    lastMs: 0,
    maxMs: 0,
    lastReadMs: 0,
    maxReadMs: 0,
    totalMs: 0,
    readback: 'none',
  };

  constructor(crs: Crs, clock: Clock) {
    this.id = `scene-${nextSceneNumber++}`;
    this.crs = crs;
    this.clock = clock;
    this.relations = new RelationsStore({
      getSourceImpl: (sourceId) => this.sources.get(sourceId),
      recordUndo: (undo) => this.recordUndo(undo),
      publishStateChange: () => this.publishStateChange(),
    });
    this.bindings = new BindingStore({
      getSourceImpl: (sourceId) => this.sources.get(sourceId),
      recordUndo: (undo) => this.recordUndo(undo),
      publishStateChange: () => this.publishStateChange(),
      crs: this.crs,
    });
    this.selection = new SelectionStore();
    this.selection.sourceLookup = (sourceId) => this.sources.get(sourceId);
    this.selection.setPublisher((refs) => {
      for (const ref of refs) this.noteFeatureState(ref);
      this.publishStateChange(true);
      this.emitter.emit('selectchange', {
        revision: this.publishedRevision,
        selected: this.selection.get(),
      });
    });
    this.state = new StateStore(
      {
        sceneId: this.id,
        getSourceImpl: (sourceId) => this.sources.get(sourceId),
        publishStateChange: (ref) => {
          this.noteFeatureState(ref);
          this.publishStateChange(true);
        },
      },
      this.selection,
    );
    this.layers = new LayerRegistry((sourceId) => this.hasSource(sourceId));
    this.layers.onChange = () => this.publishStateChange(true);
  }

  hasSource(id: string): boolean {
    return this.sources.has(id) || this.rasterSources.has(id) || this.mediaSources.has(id);
  }

  get sceneId(): string {
    return this.id;
  }

  /* ----------------------------- lifecycle -------------------------------- */

  /**
   * Lazy import-preparation pipeline. It creates its module worker on the first
   * submitted job and falls back to inline preparation without one; the scene
   * only owns its lifecycle (destroy cancels pending preparation).
   */
  get importPipeline(): ImportPipeline {
    this.importPipelineValue ??= new ImportPipeline();
    return this.importPipelineValue;
  }
  private importPipelineValue: ImportPipeline | null = null;

  get destroyed(): boolean {
    return this.destroyedValue;
  }

  assertAlive(operation: string): void {
    if (this.destroyedValue) {
      fail('destroyed', `${operation}: the map has been destroyed`, { sceneId: this.id });
    }
  }

  destroy(): void {
    if (this.destroyedValue) return;
    this.destroyedValue = true;
    // Pending import preparation is prepared work, never published: rejecting it
    // keeps the scene at its last consistent revision (IO-11, TX-09).
    this.importPipelineValue?.destroy();
    this.importPipelineValue = null;
    for (const source of this.sources.values()) {
      source.destroyStore();
    }
    this.sources.clear();
    this.sourceHandles.clear();
    // Media sources own a decoder/stream; destroying the scene must stop the
    // frame pump and release the element (MEDIA-06).
    for (const source of this.mediaSources.values()) {
      source.destroy();
    }
    this.mediaSources.clear();
    this.mediaHandles.clear();
    this.assets.destroy();
    for (let i = this.renderWaiters.length - 1; i >= 0; i--) {
      const waiter = this.renderWaiters[i]!;
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(makeDestroyedError(this.id));
    }
    this.renderWaiters.length = 0;
    this.frameDriver?.dispose?.();
    this.frameDriver = null;
    this.emitter.emit('destroy', {});
    this.emitter.clear();
  }

  setFrameDriver(driver: FrameDriver | null): void {
    this.frameDriver = driver;
  }

  setCapabilities(capabilities: Capabilities): void {
    this.capabilitiesValue = capabilities;
  }

  /* ----------------------------- revisions -------------------------------- */

  get revision(): number {
    return this.batchOpen ? this.publishedRevision + 1 : this.publishedRevision;
  }

  /**
   * Bumped whenever a raster source changes its descriptor (URL, WMS params).
   * It is part of the frame-plan identity: without it a descriptor change would
   * keep drawing the cached plan until something else changed the view.
   */
  get rasterEpoch(): number {
    return this.rasterEpochValue;
  }
  private rasterEpochValue = 0;

  get renderedRevision(): number {
    return this.renderedRevisionValue;
  }

  private publish(changes: readonly [SourceImpl, SourceCommitPayload][]): void {
    this.publishedRevision++;
    const revision = this.publishedRevision;
    for (const [source, payload] of changes) {
      source.changeEmitter.emit('change', {
        sourceId: source.id,
        revision,
        count: source.count(),
        initial: false,
        change: payload.summary,
      });
    }
    this.emitter.emit('commit', { revision });
    this.requestFrame();
  }

  /** Publishes changes caused outside source stores (layers, state, selection). */
  publishStateChange(local = false): void {
    if (this.destroyedValue) return;
    if (!local) this.renderEpoch++;
    if (this.finishing) return;
    this.publishedRevision++;
    this.emitter.emit('commit', { revision: this.publishedRevision });
    this.requestFrame();
  }

  private noteFeatureState(ref: FeatureRef): void {
    const store = this.sources.get(ref.sourceId)?.store;
    const record = store?.get(ref.id, ref.namespace);
    if (record) store!.changes.note(record.slot);
  }

  requestFrame(): void {
    if (this.destroyedValue) return;
    // Viewport-owned source work is notified on every request, before the
    // render-frame guard: a frame may already be pending (or a throttled
    // background tab may not deliver it at all) and losing the reconcile would
    // leave stale viewport data until an unrelated frame. Sources queue their
    // own microtask and deduplicate, so repeated notifications are cheap.
    for (const source of this.sources.values()) source.onFrameRequest();
    if (this.frameRequested) return;
    this.frameRequested = true;
    if (this.frameDriver) {
      this.frameDriver.requestFrame(this);
    } else {
      queueMicrotask(() => this.completeFrame());
    }
  }

  /** Called by the frame driver (or the microtask fallback) when a frame is done. */
  completeFrame(): void {
    if (this.destroyedValue) return;
    this.frameRequested = false;
    this.framesValue++;
    this.renderedRevisionValue = Math.max(this.renderedRevisionValue, this.publishedRevision);
    for (let i = this.renderWaiters.length - 1; i >= 0; i--) {
      const waiter = this.renderWaiters[i]!;
      if (waiter.revision <= this.renderedRevisionValue) {
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
        this.renderWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }

  whenRendered(revision: number, signal?: AbortSignal): Promise<void> {
    this.assertAlive('whenRendered');
    if (signal?.aborted) return Promise.reject(makeAbortedError());
    if (this.renderedRevisionValue >= revision) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.renderWaiters)[number] = {
        revision,
        resolve,
        reject,
        signal: signal ?? undefined,
        onAbort: null,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.renderWaiters.indexOf(waiter);
          if (index >= 0) this.renderWaiters.splice(index, 1);
          reject(makeAbortedError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.renderWaiters.push(waiter);
      this.requestFrame();
    });
  }

  /* ----------------------------- transactions ----------------------------- */

  recordUndo(undo: () => void): void {
    this.undoLog.push(undo);
  }

  undoMark(): number {
    return this.undoLog.length;
  }

  undoTo(mark: number): void {
    for (let i = this.undoLog.length - 1; i >= mark; i--) {
      this.undoLog[i]!();
    }
    this.undoLog.length = mark;
  }

  recordBatchFailure(error: unknown): void {
    if (this.batchFailed === null) this.batchFailed = error;
  }

  get inBatch(): boolean {
    return this.batchOpen;
  }

  get bindingsActive(): boolean {
    return this.bindings.size > 0;
  }

  trackPending(source: SourceImpl): void {
    this.pendingSources.add(source);
  }

  /**
   * Completes all pending source changes: summarizes them, runs the binding
   * evaluator inside the same transaction and collects the final change set.
   * Throws (without publishing) when a binding fails; the caller rolls back.
   */
  private finishTransaction(): [SourceImpl, SourceCommitPayload][] {
    const payloads: [SourceImpl, SourceCommitPayload][] = [];
    this.finishing = true;
    try {
      for (let guard = 0; guard < 16; guard++) {
        if (this.pendingSources.size === 0) return payloads;
        const pending = Array.from(this.pendingSources);
        this.pendingSources.clear();
        const touched: FeatureRef[] = [];
        let overflow = false;
        for (const source of pending) {
          const payload = source.finishChange();
          if (payload) {
            payloads.push([source, payload]);
            for (const ref of payload.touched) touched.push(ref);
            if (payload.touchedOverflow) overflow = true;
          }
        }
        if (this.bindingsActive) {
          this.bindings.applyChanges(touched, overflow);
        }
      }
      fail('invalid-state', 'transaction did not settle (binding evaluation loop)');
    } finally {
      this.finishing = false;
    }
  }

  private discardAllPending(): void {
    for (const source of this.sources.values()) {
      if (source.hasPendingChange()) source.discardPending();
    }
    this.pendingSources.clear();
  }

  /**
   * Runs a scene-level lifecycle mutation (relations, bindings) as one implicit
   * transaction: pending source writes flush together and undo entries are scoped.
   */
  runImplicit<T>(fn: () => T): T {
    this.assertAlive('mutate');
    const mark = this.undoMark();
    try {
      const result = fn();
      this.finishImplicitCommit();
      return result;
    } catch (error) {
      this.undoTo(mark);
      this.discardAllPending();
      throw error;
    }
  }

  /** Called by a source after a successful implicit mutation. */
  finishImplicitCommit(): void {
    let payloads: [SourceImpl, SourceCommitPayload][];
    try {
      payloads = this.finishTransaction();
    } catch (error) {
      this.discardAllPending();
      throw error;
    }
    this.undoLog.length = 0;
    this.publish(payloads);
  }

  batch<T>(fn: () => T): { revision: number } {
    this.assertAlive('batch');
    if (this.batchOpen) {
      const nested = fn();
      checkThenable(nested);
      return { revision: this.revision };
    }
    this.batchOpen = true;
    this.batchFailed = null;
    try {
      const result = fn();
      checkThenable(result);
      if (this.batchFailed !== null) {
        throw this.batchFailed;
      }
      const payloads = this.finishTransaction();
      if (this.batchFailed !== null) {
        throw this.batchFailed;
      }
      this.undoLog.length = 0;
      this.batchOpen = false;
      this.publish(payloads);
      return { revision: this.publishedRevision };
    } catch (error) {
      this.undoTo(0);
      for (const source of this.sources.values()) {
        if (source.hasPendingChange()) source.discardPending();
      }
      this.pendingSources.clear();
      this.batchOpen = false;
      const failure = this.batchFailed ?? error;
      this.batchFailed = null;
      throw failure;
    }
  }

  /* ---------------------- hooks used by the source ------------------------ */

  checkGeometryUpdate(ref: FeatureRef): void {
    this.bindings.checkGeometryOwnership(ref);
  }

  checkPropertyUpdate(ref: FeatureRef, keys: readonly string[]): void {
    this.bindings.checkPropertyOwnership(ref, keys);
  }

  beforeRecordRemoved(source: SourceImpl, record: SlotRecord): void {
    const ref = source.refOf(record);
    this.relations.beforeEndpointRemoved(source, record);
    this.bindings.beforeFeatureRemoved(ref);
  }

  afterRecordRemoved(source: SourceImpl, record: SlotRecord): void {
    const ref = source.refOf(record);
    this.relations.afterEndpointRemoved(source, record);
    this.bindings.afterFeatureRemoved(ref);
    this.state.forget(source.id, record);
  }

  /* ------------------------------- sources -------------------------------- */

  createVectorSource(id: string): VectorSourceHandle {
    this.assertAlive('sources.vector');
    if (this.hasSource(id)) {
      fail('duplicate-id', `source already exists: ${id}`, { sourceId: id });
    }
    const source = new SourceImpl(this, id, this.crs);
    this.sources.set(id, source);
    const { handle } = createSourceHandle(source, this);
    this.sourceHandles.set(id, handle);
    return handle;
  }

  createRasterSource(
    id: string,
    kind: RasterSourceKind,
    options: RasterTilesOptions | WmsOptions,
  ): RasterSourceHandle {
    this.assertAlive('sources.rasterTiles');
    if (this.hasSource(id)) {
      fail('duplicate-id', `source already exists: ${id}`, { sourceId: id });
    }
    const source = new RasterSourceImpl(id, kind, options);
    this.rasterSources.set(id, source);
    // Descriptor changes rebuild the plan and repaint immediately instead of
    // waiting for a zoom or a data change (RASTER-07). The emitter is cleared
    // when the source is destroyed.
    source.emitter.on('change', () => {
      this.rasterEpochValue++;
      this.requestFrame();
    });
    const handle = createRasterSourceHandle(source);
    this.rasterHandles.set(id, handle);
    return handle;
  }

  getRasterSource(id: string): RasterSourceImpl | undefined {
    return this.rasterSources.get(id);
  }

  /* ----------------------------- media sources ----------------------------- */

  /**
   * Image/video source placed into explicit bounds (MEDIA-01..06). Descriptor
   * changes publish a scene state change (plan rebuild + repaint); pixel and
   * frame changes only request a frame, so a playing video does not rebuild the
   * plan every frame but still returns to idle once paused (LIFE-05).
   */
  createMediaSource(kind: MediaSourceKind, options: ImageSourceOptions | VideoSourceOptions): MediaSourceHandle {
    this.assertAlive('sources.media');
    if (this.hasSource(options.id)) {
      fail('duplicate-id', `source already exists: ${options.id}`, { sourceId: options.id });
    }
    const source = new MediaSourceImpl(options, kind);
    this.mediaSources.set(options.id, source);
    source.emitter.on('change', () => this.publishStateChange());
    source.emitter.on('frame', () => this.requestFrame());
    const handle = createMediaSourceHandle(source);
    this.mediaHandles.set(options.id, handle);
    return handle;
  }

  getMediaSource(id: string): MediaSourceImpl | undefined {
    return this.mediaSources.get(id);
  }

  /* --------------------------- vector tile sources ------------------------- */

  createVectorTileSource(options: VectorTilesOptions): VectorTilesSourceHandle {
    this.assertAlive('sources.vectorTiles');
    if (this.hasSource(options.id)) {
      fail('duplicate-id', `source already exists: ${options.id}`, { sourceId: options.id });
    }
    const source = new VectorTileSourceImpl(this, options.id, this.crs, options);
    this.sources.set(options.id, source);
    this.vectorTileSources.set(options.id, source);
    const handle = source.createHandle();
    this.vectorTileHandles.set(options.id, handle);
    // Kick off the initial viewport reconcile.
    this.requestFrame();
    return handle;
  }

  getVectorTileSource(id: string): VectorTileSourceImpl | undefined {
    return this.vectorTileSources.get(id);
  }

  /* -------------------------------- assets --------------------------------- */

  readonly assets = new AssetRegistry();

  createImageAsset(id: string, src: string): ImageAssetHandle {
    this.assertAlive('assets.addImage');
    const impl = this.assets.addImage(id, src);
    // Load state changes are render-visible (fallback shape -> sprite, or an
    // explicit error), so they publish a state change and repaint (MEDIA-08).
    impl.emitter.on('change', () => this.publishStateChange());
    return createImageAssetHandle(impl);
  }

  createFontAsset(id: string, family: string, src: string): FontAssetHandle {
    this.assertAlive('assets.addFont');
    const impl = this.assets.addFont(id, family, src);
    // A late font becomes render-visible: labels must remeasure in a new
    // revision instead of keeping a stale rasterization (TEXT-05).
    impl.emitter.on('change', () => this.publishStateChange());
    return createFontAssetHandle(impl);
  }

  /** Font-atlas key component for a label family (see AssetRegistry). */
  fontSignature(family: string): string {
    return this.assets.fontSignature(family);
  }

  removeAsset(id: string): void {
    this.assets.remove(id);
    this.publishStateChange();
  }

  getSource(id: string): VectorSourceHandle | undefined {
    return this.sourceHandles.get(id);
  }

  getSourceHandle(id: string): VectorSourceHandle | RasterSourceHandle | VectorTilesSourceHandle | MediaSourceHandle | undefined {
    return (
      this.sourceHandles.get(id) ??
      this.rasterHandles.get(id) ??
      this.vectorTileHandles.get(id) ??
      this.mediaHandles.get(id)
    );
  }

  /** Internal access for layers, bindings and the frame planner. */
  getSourceImpl(id: string): SourceImpl | undefined {
    return this.sources.get(id);
  }

  listSources(): readonly string[] {
    return [
      ...Array.from(this.sources.keys()),
      ...Array.from(this.rasterSources.keys()),
      ...Array.from(this.mediaSources.keys()),
      ...Array.from(this.vectorTileSources.keys()),
    ];
  }

  addDependent(sourceId: string, dependent: SourceDependent): void {
    let set = this.dependents.get(sourceId);
    if (!set) {
      set = new Set();
      this.dependents.set(sourceId, set);
    }
    set.add(dependent);
  }

  removeDependent(sourceId: string, dependent: SourceDependent): void {
    const set = this.dependents.get(sourceId);
    if (set) {
      set.delete(dependent);
      if (set.size === 0) this.dependents.delete(sourceId);
    }
  }

  dependentsOf(sourceId: string): readonly SourceDependent[] {
    return Array.from(this.dependents.get(sourceId) ?? []);
  }

  /**
   * Removes a source. Without `cascade`, dependent layers/bindings/relations block
   * the removal (DATA-10); with `cascade`, they are removed first (DATA-11).
   */
  removeSource(id: string, options?: { cascade?: boolean }): void {
    this.assertAlive('sources.remove');
    const vector = this.sources.get(id);
    const raster = this.rasterSources.get(id);
    const media = this.mediaSources.get(id);
    if (!vector && !raster && !media) {
      fail('not-found', `source not found: ${id}`, { sourceId: id });
    }
    const dependentNotes = [
      ...this.dependentsOf(id).map((dependent) => `${dependent.kind}:${dependent.id}`),
      ...(this.relations.referenceCountForSource(id) > 0 ? ['relations'] : []),
      ...(this.bindings.referenceCountForSource(id) > 0 ? ['bindings'] : []),
    ];
    if (dependentNotes.length > 0 && !options?.cascade) {
      fail('dependency-conflict', `source ${id} is still used by dependents`, {
        sourceId: id,
        dependents: dependentNotes,
      });
    }
    if (options?.cascade) {
      for (const dependent of this.dependentsOf(id)) dependent.remove();
      this.relations.removeForSource(id);
      this.bindings.removeForSource(id);
    }
    this.sources.delete(id);
    this.sourceHandles.delete(id);
    this.rasterSources.delete(id);
    this.rasterHandles.delete(id);
    this.vectorTileSources.delete(id);
    this.vectorTileHandles.delete(id);
    this.mediaSources.delete(id);
    this.mediaHandles.delete(id);
    vector?.destroyStore();
    raster?.destroy();
    media?.destroy();
    this.publishStateChange();
  }

  /* --------------------------------- view --------------------------------- */

  attachView(view: ViewImpl): void {
    this.view = view;
  }

  get attachedView(): ViewImpl {
    if (!this.view) fail('invalid-state', 'the scene has no view');
    return this.view;
  }

  publishViewChange(kind: 'start' | 'change' | 'end'): void {
    if (this.destroyedValue) return;
    this.publishedRevision++;
    const snapshot = this.attachedView.getSnapshot();
    if (kind === 'start') this.emitter.emit('viewstart', { type: 'viewstart', snapshot });
    else if (kind === 'end') this.emitter.emit('viewend', { type: 'viewend', snapshot });
    else this.emitter.emit('viewchange', { type: 'viewchange', snapshot });
    this.emitter.emit('commit', { revision: this.publishedRevision });
    this.requestFrame();
  }

  get sceneRevision(): number {
    return this.revision;
  }

  /* ----------------------------- feature events ---------------------------- */

  /**
   * Bubbles a feature event layer -> group(s) -> map (EVENT-01). A handler that
   * calls `stopPropagation()` ends the chain at its level; gesture resolution is
   * not part of this chain (EVENT-02).
   */
  emitFeatureEvent(event: MapFeatureEvent): void {
    if (this.destroyedValue) return;
    const layer = this.layers.get(event.layerId);
    if (layer) {
      layer.featureEmitter.emit('feature', event);
      let group: import('./layers.ts').GroupImpl | null = layer.parent;
      while (group && !event.propagationStopped) {
        group.featureEmitter.emit('feature', event);
        group = group.parent;
      }
    }
    if (!event.propagationStopped) this.emitter.emit('feature', event);
  }

  /* ------------------------------ diagnostics ----------------------------- */

  setFrameStats(info: { instances: number; drawCalls: number; gpuBytes: number }): void {
    this.renderedInstancesValue = info.instances;
    this.drawCallsValue = info.drawCalls;
    this.gpuBytesValue = info.gpuBytes;
  }

  /** Pick stall measurement published by the active backend (PICK-12). */
  setPickStats(stats: PickStallStats): void {
    this.pickStatsValue = stats;
  }

  /**
   * Box selection: references of interactive features inside the bounds.
   * INPUT-08: selection respects layer interaction and overrides.
   */
  querySelection(bounds: import('../math/bounds.ts').Bounds<Position>): FeatureRef[] {
    const rect = boundsToWorldRect(this.crs, bounds as never);
    const refs: FeatureRef[] = [];
    const seen = new Set<string>();
    for (const layer of this.layers.flatten()) {
      if (!layer.interactionEnabled || layer.kind === 'raster') continue;
      const source = this.sources.get(layer.sourceId);
      if (!source) continue;
      const filter = compileFilter(layer.filter);
      source.store.queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY, (record) => {
        if (layer.namespace !== undefined && record.namespace !== layer.namespace) return;
        const bbox = record.geometry
          ? record.geometry.bbox
          : [record.wx, record.wy, record.wx, record.wy];
        if (
          bbox[2]! < rect.minX ||
          bbox[0]! > rect.maxX ||
          bbox[3]! < rect.minY ||
          bbox[1]! > rect.maxY
        ) {
          return;
        }
        const state = this.state.stateOf(source, record);
        const ref = source.refOf(record);
        const override = layer.overrides.get(layer.overrideKey(ref));
        // INPUT-08: only interactive and visible targets are eligible.
        if (override?.interactive === false || override?.visible === false) return;
        if (this.bindings.isTargetHidden(ref)) return;
        if (!filter({ state, id: record.id }, record.properties)) return;
        const key = `${ref.sourceId}\u0000${ref.namespace ?? ''}\u0000${typeof ref.id}:${ref.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        refs.push(ref);
      });
    }
    return refs;
  }

  featureCount(): number {
    let total = 0;
    for (const source of this.sources.values()) total += source.count();
    return total;
  }

  stats(): MapStats {
    return {
      revision: this.revision,
      renderedRevision: this.renderedRevisionValue,
      sources: this.sources.size,
      layers: 0,
      features: this.featureCount(),
      drawCalls: this.drawCallsValue,
      instances: this.renderedInstancesValue,
      renderedInstances: this.renderedInstancesValue,
      gpuBytes: this.gpuBytesValue,
      frames: this.framesValue,
      picking: this.pickStatsValue,
    };
  }

  capabilities(): Capabilities {
    return this.capabilitiesValue;
  }
}

function checkThenable(value: unknown): void {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    fail('invalid-argument', 'map.batch does not accept an async callback', {});
  }
}

export function makeAbortedError(): MapletError {
  return new MapletError('aborted', 'operation aborted');
}

function makeDestroyedError(sceneId: string): MapletError {
  return new MapletError('destroyed', 'the map has been destroyed', { sceneId });
}
