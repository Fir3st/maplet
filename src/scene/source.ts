/**
 * Vector data source: canonical features with stable identity, generation and
 * properties. A source is referenced by one or more display layers; it never
 * contains a second copy of a feature per layer.
 *
 * All public mutation methods participate in `map.batch` transactions: inside a
 * batch they stage into the open transaction (reads see staged state, nothing is
 * published), outside they commit immediately as a single operation.
 */

import { assertArgument, fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import type {
  Commit,
  FeatureId,
  FeatureProperties,
  FeatureRef,
  FeatureSnapshot,
  Geometry,
  SubscribeOptions,
  Unsubscribe,
} from '../api/types.ts';
import { featureIdKey, isArrayValue } from '../api/types.ts';
import type { Crs, Position } from '../math/index.ts';
import { nativeProjectionCode } from '../math/crs.ts';
import { prepareParts, type PreparedPartsImport } from '../io/parts.ts';
import { boundsFromPositions, type Bounds } from '../math/bounds.ts';
import { geometryPositions, type PreparedFeatureGeometry } from '../geometry/geometry.ts';
import { EMPTY_PROPERTIES, FeatureStore, type GeometryState, type SlotRecord } from './store.ts';
import { featuresToGeoJson, type GeoJsonFeatureCollection } from '../formats/geojson.ts';
import type { ColumnarBatch, ColumnarPointBatch } from '../io/columnar.ts';
import type { ImportPipeline } from '../io/import-pipeline.ts';

export interface SourceChange {
  readonly addedCount: number;
  readonly updatedCount: number;
  readonly removedCount: number;
  /** Sample of affected IDs (capped for very large changes). */
  readonly added: readonly FeatureId[];
  readonly updated: readonly FeatureId[];
  readonly removed: readonly FeatureId[];
}

export interface SourceSnapshot {
  readonly sourceId: string;
  readonly revision: number;
  readonly count: number;
  /** True for the snapshot emitted on subscribe. */
  readonly initial: boolean;
  readonly change: SourceChange | null;
}

export interface FeatureInput<G = Geometry, P = FeatureProperties> {
  readonly id?: FeatureId;
  readonly namespace?: string;
  readonly geometry: G;
  readonly properties?: P;
}

export interface FeaturePatch<G = Geometry, P = FeatureProperties> {
  readonly geometry?: G;
  /** Shallow per-key patch; a key set to undefined is removed. */
  readonly properties?: Partial<P>;
}

export interface FeatureQueryOptions {
  readonly namespace?: string;
}

export interface AddOptions extends FeatureQueryOptions {
  /** Allows replacing an existing feature with the same identity. */
  readonly upsert?: boolean;
}

export interface RemoveOptions extends FeatureQueryOptions {
  /** Reserved for dependent removal policies; relations and bindings use their own. */
  readonly cascade?: boolean;
}

export interface ReplaceOptions extends FeatureQueryOptions {
  readonly signal?: AbortSignal;
  /** Keeps generations of retained identities (default). */
  readonly upsert?: boolean;
}

export interface CommitWithRefs<G = Geometry, P = FeatureProperties> extends Commit {
  readonly refs: readonly FeatureRef<G, P>[];
}

export interface SourceCommitPayload {
  readonly summary: SourceChange;
  readonly touched: readonly FeatureRef[];
  readonly touchedOverflow: boolean;
}

/* -------------------------------------------------------------------------- */
/* Internal types shared with the scene                                        */
/* -------------------------------------------------------------------------- */

export interface SourceInternals {
  readonly sceneId: string;
  readonly crs: Crs;
  readonly inBatch: boolean;
  readonly revision: number;
  /** True when at least one binding exists; touched-reference collection is skipped otherwise. */
  readonly bindingsActive: boolean;
  recordUndo(undo: () => void): void;
  undoMark(): number;
  undoTo(mark: number): void;
  trackPending(source: SourceImpl): void;
  recordBatchFailure(error: unknown): void;
  finishImplicitCommit(): void;
  checkGeometryUpdate(ref: FeatureRef): void;
  checkPropertyUpdate(ref: FeatureRef, keys: readonly string[]): void;
  beforeRecordRemoved(source: SourceImpl, record: SlotRecord): void;
  afterRecordRemoved(source: SourceImpl, record: SlotRecord): void;
}

const CHANGE_ID_SAMPLE_LIMIT = 4096;
const TOUCHED_LIMIT = 4096;

interface PendingChange {
  added: FeatureId[];
  updated: FeatureId[];
  removed: FeatureId[];
  touched: FeatureRef[];
  touchedOverflow: boolean;
}

function emptyChange(): PendingChange {
  return { added: [], updated: [], removed: [], touched: [], touchedOverflow: false };
}

/* -------------------------------------------------------------------------- */
/* Source implementation                                                       */
/* -------------------------------------------------------------------------- */

export class SourceImpl {
  readonly id: string;
  readonly type: 'vector';
  readonly store: FeatureStore;
  readonly crs: Crs;
  readonly changeEmitter = new Emitter<{ change: SourceEvent }>();
  private autoIdCounter = 0;
  private destroyed = false;
  private pendingChange: PendingChange | null = null;
  private readonly scene: SourceInternals;

  constructor(scene: SourceInternals, id: string, crs: Crs) {
    this.scene = scene;
    this.id = id;
    this.type = 'vector';
    this.crs = crs;
    this.store = new FeatureStore(crs);
  }

  private ensureAlive(): void {
    if (this.destroyed) {
      fail('destroyed', `source ${this.id} has been destroyed`, { sourceId: this.id });
    }
  }

  private beginPending(): PendingChange {
    if (!this.pendingChange) {
      this.pendingChange = emptyChange();
      this.scene.trackPending(this);
    }
    return this.pendingChange;
  }

  private noteTouched(change: PendingChange, ref: FeatureRef): void {
    if (!this.scene.bindingsActive) return;
    if (change.touched.length >= TOUCHED_LIMIT) {
      change.touchedOverflow = true;
      return;
    }
    change.touched.push(ref);
  }

  /** Runs a mutation either inside the open batch or as an implicit commit. */
  mutate<T>(fn: (change: PendingChange) => T): T {
    this.ensureAlive();
    const implicit = !this.scene.inBatch;
    const mark = this.scene.undoMark();
    const change = this.beginPending();
    try {
      const result = fn(change);
      if (implicit) {
        this.scene.finishImplicitCommit();
      }
      return result;
    } catch (error) {
      if (implicit) {
        this.pendingChange = null;
        this.scene.undoTo(mark);
      } else {
        // The batch owner decides the final outcome; the first failure is kept.
        this.scene.recordBatchFailure(error);
      }
      throw error;
    }
  }

  /** Called by the scene when a commit finishes; returns the change payload. */
  finishChange(): SourceCommitPayload | null {
    const change = this.pendingChange;
    if (!change) return null;
    this.pendingChange = null;
    return {
      summary: summarizeChange(change),
      touched: change.touched,
      touchedOverflow: change.touchedOverflow,
    };
  }

  hasPendingChange(): boolean {
    return this.pendingChange !== null;
  }

  /**
   * Hook: the scene asks sources to ensure viewport-owned work on every frame
   * request (vector tiles reconcile their needed tile set here). The base
   * source owns no viewport work.
   */
  onFrameRequest(): void {}

  pendingTouchedOverflow(): boolean {
    return this.pendingChange?.touchedOverflow ?? false;
  }

  /** Called by the scene when a transaction rolls back. */
  discardPending(): void {
    this.pendingChange = null;
  }

  /* ------------------------------ reads ---------------------------------- */

  snapshotOf(record: SlotRecord): FeatureSnapshot {
    const geometry = record.geometry
      ? geometryPositions(this.crs, record.geometry)
      : {
          type: 'point',
          position:
            record.alt === undefined
              ? this.crs.fromWorld({ x: record.wx, y: record.wy })
              : { ...this.crs.fromWorld({ x: record.wx, y: record.wy }), altitude: record.alt },
        };
    return {
      ref: this.refOf(record),
      geometry: geometry as Geometry,
      properties: { ...record.properties },
    };
  }

  refOf(record: SlotRecord): FeatureRef<Geometry, FeatureProperties> {
    return {
      sceneId: this.scene.sceneId,
      sourceId: this.id,
      ...(record.namespace === undefined ? {} : { namespace: record.namespace }),
      id: record.id,
      generation: record.generation,
    };
  }

  /** Validates an external reference against the current store state. */
  resolveRef(ref: FeatureRef, operation: string): SlotRecord {
    if (ref.sceneId !== this.scene.sceneId) {
      fail('stale-reference', `${operation}: reference belongs to another scene`, {
        expectedScene: this.scene.sceneId,
        actualScene: ref.sceneId,
      });
    }
    if (ref.sourceId !== this.id) {
      fail('stale-reference', `${operation}: reference belongs to another source`, {
        expectedSource: this.id,
        actualSource: ref.sourceId,
      });
    }
    const record = this.store.get(ref.id, ref.namespace);
    if (!record) {
      fail('stale-reference', `${operation}: feature no longer exists`, {
        id: ref.id,
        namespace: ref.namespace ?? null,
      });
    }
    if (record.generation !== ref.generation) {
      fail('stale-reference', `${operation}: reference generation is stale`, {
        id: ref.id,
        expectedGeneration: record.generation,
        actualGeneration: ref.generation,
      });
    }
    return record;
  }

  bounds(): Bounds<Position> | null {
    const bbox = this.store.boundsNow();
    if (!bbox) return null;
    const positions: Position[] = [
      this.crs.fromWorld({ x: bbox[0]!, y: bbox[1]! }),
      this.crs.fromWorld({ x: bbox[2]!, y: bbox[3]! }),
    ];
    return boundsFromPositions(positions);
  }

  count(): number {
    return this.store.count;
  }

  /* ------------------------------ writes ---------------------------------- */

  nextId(): FeatureId {
    this.autoIdCounter++;
    return `auto:${this.autoIdCounter}`;
  }

  /** Fresh point imports use one atomic store adoption, not per-row CRUD/undo. */
  initializePointImport(
    change: PendingChange,
    batch: ColumnarPointBatch,
    signal?: AbortSignal,
  ): boolean {
    if (!this.store.pristine) return false;
    const result = this.store.initializePoints(batch, () => this.nextId(), signal);
    this.scene.recordUndo(result.undo);
    if (change.added.length === 0) change.added = result.ids;
    else for (const id of result.ids) change.added.push(id);
    if (this.scene.bindingsActive) {
      const available = TOUCHED_LIMIT - change.touched.length;
      for (let slot = 0; slot < Math.min(result.ids.length, available); slot++) {
        this.noteTouched(change, this.refOf(this.store.getBySlot(slot)!));
      }
      if (result.ids.length > available) change.touchedOverflow = true;
    }
    return true;
  }

  addOne(
    change: PendingChange,
    input: FeatureInput,
    options: AddOptions,
  ): { ref: FeatureRef<Geometry, FeatureProperties>; slot: number } {
    const id = input.id ?? this.nextId();
    const namespace = input.namespace ?? options.namespace;
    const result = this.store.add(
      {
        id,
        namespace,
        geometry: input.geometry,
        properties: input.properties,
      },
      options.upsert === true,
    );
    return this.finishInsert(change, id, namespace, result);
  }

  private finishInsert(
    change: PendingChange,
    id: FeatureId,
    namespace: string | undefined,
    result: import('./store.ts').AddRecordResult,
  ): { ref: FeatureRef<Geometry, FeatureProperties>; slot: number } {
    const undoStore = this.store;
    if (result.previous) {
      const previousRecord = result.previous;
      this.noteTouched(change, this.refOf(previousRecord));
      this.scene.recordUndo(() => {
        const current = undoStore.get(id, namespace);
        if (current) {
          undoStore.restoreReplacing(previousRecord, recordBoxOf(current));
        } else {
          undoStore.restore(previousRecord);
        }
      });
      change.updated.push(id);
    } else {
      this.scene.recordUndo(() => {
        if (undoStore.get(id, namespace)) {
          undoStore.removeRecord(id, namespace);
        }
      });
      change.added.push(id);
    }
    const record = this.store.getBySlot(result.slot)!;
    const ref = this.refOf(record);
    this.noteTouched(change, ref);
    return { ref, slot: record.slot };
  }

  importPreparedParts(
    change: PendingChange,
    batch: PreparedPartsImport,
    mode: 'replace' | 'append',
    signal?: AbortSignal,
  ): void {
    const ids = batch.geometries.map((_, i) => batch.ids?.[i] ?? this.nextId());
    const seen = new Set<string>();
    for (const id of ids) {
      const key = featureIdKey(id);
      if (seen.has(key))
        fail('duplicate-id', `columnar import: duplicate id in input: ${String(id)}`, { id });
      seen.add(key);
    }
    if (this.store.pristine) {
      this.scene.recordUndo(this.store.initializePrepared(batch, ids, signal));
      for (const id of ids) change.added.push(id);
      if (this.scene.bindingsActive) {
        const available = TOUCHED_LIMIT - change.touched.length;
        for (let slot = 0; slot < Math.min(ids.length, available); slot++)
          this.noteTouched(change, this.refOf(this.store.getBySlot(slot)!));
        if (ids.length > available) change.touchedOverflow = true;
      }
      return;
    }
    if (mode === 'replace') {
      const removed: FeatureRef[] = [];
      this.store.forEachLive((record) => {
        if (!seen.has(record.key)) removed.push(this.refOf(record));
      });
      for (const ref of removed) {
        throwIfAborted(signal);
        this.removeOne(change, ref, 'importColumnar');
      }
    }
    for (let i = 0; i < ids.length; i++) {
      throwIfAborted(signal);
      const id = ids[i]!,
        prepared = batch.geometries[i]!,
        properties = batch.properties?.[i] ?? EMPTY_PROPERTIES;
      const record = this.store.get(id);
      if (mode === 'replace' && record) {
        const ref = this.refOf(record);
        this.scene.checkGeometryUpdate(ref);
        this.scene.checkPropertyUpdate(
          ref,
          Array.from(new Set([...Object.keys(record.properties), ...Object.keys(properties)])),
        );
        this.applyPreparedGeometry(record, prepared);
        const previous = this.store.setProperties(record.slot, properties);
        this.scene.recordUndo(() => {
          this.store.setProperties(record.slot, previous);
        });
        change.updated.push(id);
        this.noteTouched(change, ref);
      } else {
        const result = this.store.addPrepared({ id, namespace: undefined, prepared, properties });
        this.finishInsert(change, id, undefined, result);
      }
    }
  }

  updateOne(
    change: PendingChange,
    ref: FeatureRef,
    patch: FeaturePatch,
    operation: string,
  ): SlotRecord {
    const record = this.resolveRef(ref, operation);
    if (patch.geometry !== undefined) {
      this.scene.checkGeometryUpdate(ref);
      this.applyGeometry(change, record, patch.geometry);
    }
    if (patch.properties !== undefined) {
      this.scene.checkPropertyUpdate(ref, Object.keys(patch.properties));
      this.applyProperties(change, record, patch.properties);
    }
    change.updated.push(ref.id);
    const current = this.store.getBySlot(record.slot)!;
    this.noteTouched(change, this.refOf(current));
    return current;
  }

  /** Replaces geometry and properties wholesale (used by `replace`). */
  replaceOne(change: PendingChange, ref: FeatureRef, item: FeatureInput): void {
    const record = this.resolveRef(ref, 'features.replace');
    this.scene.checkGeometryUpdate(ref);
    const nextProperties = item.properties ?? EMPTY_PROPERTIES;
    const keys = new Set([...Object.keys(record.properties), ...Object.keys(nextProperties)]);
    this.scene.checkPropertyUpdate(ref, Array.from(keys));
    this.applyGeometry(change, record, item.geometry);
    const previousProperties = this.store.setProperties(record.slot, nextProperties);
    this.scene.recordUndo(() => {
      this.store.setProperties(record.slot, previousProperties);
    });
    change.updated.push(ref.id);
    const current = this.store.getBySlot(record.slot)!;
    this.noteTouched(change, this.refOf(current));
  }

  /* Internal writes used by the binding evaluator: same transaction, no
     ownership checks (the evaluator is the owner), undo recorded. */

  replaceGeometryInternal(slot: number, prepared: PreparedFeatureGeometry): void {
    this.ensureAlive();
    const record = this.store.getBySlot(slot);
    if (!record) fail('invalid-state', 'binding target slot is not live', { slot });
    const change = this.beginPending();
    this.applyPreparedGeometry(record, prepared);
    this.noteTouched(change, this.refOf(this.store.getBySlot(slot)!));
  }

  mergePropertiesInternal(slot: number, patch: Readonly<Record<string, unknown>>): void {
    this.ensureAlive();
    const record = this.store.getBySlot(slot);
    if (!record) fail('invalid-state', 'binding target slot is not live', { slot });
    const change = this.beginPending();
    this.applyProperties(change, record, patch);
    this.noteTouched(change, this.refOf(this.store.getBySlot(slot)!));
  }

  private applyGeometry(_change: PendingChange, record: SlotRecord, geometry: unknown): void {
    // User input is always prepared here; prepared objects only reach the store
    // through `replaceGeometryInternal` (bindings). Duck-typing a user geometry
    // by its keys misclassified data (e.g. an object carrying bbox/payload).
    this.applyPreparedGeometry(record, this.store.prepareGeometry(geometry));
  }

  private applyPreparedGeometry(record: SlotRecord, prepared: PreparedFeatureGeometry): void {
    const previous: GeometryState = this.store.replaceGeometry(record.slot, prepared);
    this.scene.recordUndo(() => {
      const current = this.store.getBySlot(record.slot);
      if (current) {
        this.store.restoreGeometryState(record.slot, previous, recordBoxOf(current));
      }
    });
  }

  private applyProperties(
    _change: PendingChange,
    record: SlotRecord,
    patch: Readonly<Record<string, unknown>>,
  ): void {
    const next = mergeProperties(record.properties, patch);
    if (next === record.properties) return;
    const previous = this.store.setProperties(record.slot, next);
    this.scene.recordUndo(() => {
      this.store.setProperties(record.slot, previous);
    });
  }

  /** Drag updates reuse the normal patch path (ownership checks included). */
  mutateDrag(ref: FeatureRef, position: Position): void {
    this.mutate((change) => {
      this.updateOne(change, ref, { geometry: { type: 'point', position } as never }, 'drag');
    });
  }

  removeOne(change: PendingChange, ref: FeatureRef, operation: string): SlotRecord {
    const record = this.resolveRef(ref, operation);
    this.scene.beforeRecordRemoved(this, record);
    const removed = this.store.removeRecord(ref.id, ref.namespace);
    if (!removed) {
      fail('stale-reference', `${operation}: feature no longer exists`, { id: ref.id });
    }
    this.scene.recordUndo(() => {
      this.store.restore(removed);
    });
    this.scene.afterRecordRemoved(this, removed);
    change.removed.push(ref.id);
    this.noteTouched(change, this.refOf(removed));
    return removed;
  }

  destroyStore(): void {
    this.destroyed = true;
    this.store.dispose();
    this.changeEmitter.clear();
  }
}

export type SourceEvent = SourceSnapshot;

function recordBoxOf(record: SlotRecord): Float64Array {
  if (record.geometry) return record.geometry.bbox;
  return Float64Array.of(record.wx, record.wy, record.wx, record.wy);
}

function mergeProperties(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let changed = false;
  const next: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
      continue;
    }
    if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? next : current;
}

function summarizeChange(change: PendingChange): SourceChange {
  return {
    addedCount: change.added.length,
    updatedCount: change.updated.length,
    removedCount: change.removed.length,
    added: change.added.slice(0, CHANGE_ID_SAMPLE_LIMIT),
    updated: change.updated.slice(0, CHANGE_ID_SAMPLE_LIMIT),
    removed: change.removed.slice(0, CHANGE_ID_SAMPLE_LIMIT),
  };
}

/* -------------------------------------------------------------------------- */
/* Public handle                                                               */
/* -------------------------------------------------------------------------- */

export interface FeaturesHandle<G = Geometry, P = FeatureProperties> {
  get(id: FeatureId, options?: FeatureQueryOptions): FeatureSnapshot<G, P> | undefined;
  ref(id: FeatureId, options?: FeatureQueryOptions): FeatureRef<G, P>;
  has(id: FeatureId, options?: FeatureQueryOptions): boolean;
  add(
    items: FeatureInput<G, P> | readonly FeatureInput<G, P>[],
    options?: AddOptions,
  ): CommitWithRefs<G, P>;
  update(
    idOrRef: FeatureId | FeatureRef<G, P>,
    patch: FeaturePatch<G, P>,
    options?: FeatureQueryOptions,
  ): Commit;
  updateMany(
    entries: readonly {
      readonly id: FeatureId | FeatureRef<G, P>;
      readonly patch: FeaturePatch<G, P>;
    }[],
  ): Commit;
  remove(
    idOrRef: FeatureId | FeatureRef<G, P> | readonly FeatureId[],
    options?: RemoveOptions,
  ): Commit;
  replace(items: readonly FeatureInput<G, P>[], options?: ReplaceOptions): Promise<Commit>;
  append(items: readonly FeatureInput<G, P>[], options?: ReplaceOptions): Promise<Commit>;
  count(): number;
  ids(options?: FeatureQueryOptions): FeatureId[];
  each(visit: (snapshot: FeatureSnapshot<G, P>) => void, options?: FeatureQueryOptions): number;
}

export interface ColumnarImportOptions {
  readonly mode?: 'replace' | 'append';
  /**
   * Default `true`: the import worker receives a structured-clone copy and the
   * input arrays stay usable (IO-06). `false` transfers the batch's typed
   * arrays (a move — the buffers detach); without a worker it degrades to the
   * copy semantics (IO-07, IO-08).
   */
  readonly copy?: boolean;
  readonly signal?: AbortSignal;
}

export interface VectorSourceHandle<G = Geometry, P = FeatureProperties> {
  readonly id: string;
  readonly type: 'vector';
  readonly features: FeaturesHandle<G, P>;
  /** Readonly source snapshot. */
  snapshot(): { readonly sourceId: string; readonly revision: number; readonly count: number };
  getBounds(): Bounds<Position> | null;
  /**
   * GeoJSON import; default mode replaces the source content atomically after the
   * whole input validated (IO-03), `mode: 'append'` adds to it.
   */
  importGeoJson(
    geojson: string | object,
    options?: { readonly mode?: 'replace' | 'append'; readonly signal?: AbortSignal },
  ): Promise<Commit>;
  /**
   * Columnar (typed-array) import; the batch is validated before publication and
   * prepared by the import worker when available (IO-05..IO-11).
   */
  importColumnar(batch: ColumnarBatch, options?: ColumnarImportOptions): Promise<Commit>;
  /** GeoJSON export of the canonical data (not the clipped render fragments). */
  exportGeoJson(options?: { readonly ids?: readonly FeatureId[] }): GeoJsonFeatureCollection;
  subscribe(fn: (snapshot: SourceSnapshot) => void, options?: SubscribeOptions): Unsubscribe;
  on(
    type: 'change',
    fn: (snapshot: SourceSnapshot) => void,
    options?: SubscribeOptions,
  ): Unsubscribe;
}

/** Scene services a vector source handle needs beyond its own store. */
export interface SourceHandleContext {
  readonly revision: number;
  readonly importPipeline: ImportPipeline;
}

export function createSourceHandle(
  source: SourceImpl,
  scene: SourceHandleContext,
): {
  handle: VectorSourceHandle;
  source: SourceImpl;
} {
  const features: FeaturesHandle = {
    get(id, options) {
      const record = source.store.get(id, options?.namespace);
      return record ? source.snapshotOf(record) : undefined;
    },
    ref(id, options) {
      const record = source.store.get(id, options?.namespace);
      if (!record) {
        fail('not-found', `feature not found: ${String(id)}`, {
          id,
          sourceId: source.id,
          namespace: options?.namespace ?? null,
        });
      }
      return source.refOf(record);
    },
    has(id, options) {
      return source.store.has(id, options?.namespace);
    },
    add(items, options = {}) {
      const list = Array.isArray(items) ? items : [items as FeatureInput];
      assertArgument(list.length > 0, 'features.add: at least one item is required');
      const refs: FeatureRef<Geometry, FeatureProperties>[] = [];
      source.mutate((change) => {
        for (const item of list) {
          const { ref } = source.addOne(change, item as FeatureInput, options);
          refs.push(ref);
        }
      });
      return { revision: scene.revision, refs };
    },
    update(idOrRef, patch, options) {
      const ref = resolveInput(source, idOrRef, options);
      source.mutate((change) => {
        source.updateOne(change, ref, patch, 'features.update');
      });
      return { revision: scene.revision };
    },
    updateMany(entries) {
      assertArgument(entries.length > 0, 'features.updateMany: at least one entry is required');
      source.mutate((change) => {
        for (const entry of entries) {
          const ref = resolveInput(source, entry.id, undefined);
          source.updateOne(change, ref, entry.patch, 'features.updateMany');
        }
      });
      return { revision: scene.revision };
    },
    remove(idOrRef, options = {}) {
      source.mutate((change) => {
        if (isArrayValue(idOrRef)) {
          for (const id of idOrRef as readonly FeatureId[]) {
            const record = source.store.get(id, options.namespace);
            if (!record) {
              fail('not-found', `feature not found: ${String(id)}`, { id, sourceId: source.id });
            }
            source.removeOne(change, source.refOf(record), 'features.remove');
          }
          return;
        }
        const ref = resolveInput(source, idOrRef as FeatureId | FeatureRef, options);
        source.removeOne(change, ref, 'features.remove');
      });
      return { revision: scene.revision };
    },
    // Validation failures reject the returned promise instead of throwing
    // synchronously, which is the documented async contract (IO-09).
    // eslint-disable-next-line @typescript-eslint/require-await
    async replace(items, options = {}) {
      assertArgument(isArrayValue(items), 'features.replace: expected an array of features');
      throwIfAborted(options.signal);
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (typeof item !== 'object' || item === null || !('geometry' in item)) {
          fail('invalid-argument', `features.replace: item ${index} has no geometry`, { index });
        }
      }
      throwIfAborted(options.signal);
      source.mutate((change) => {
        replaceTransaction(source, change, items, options);
      });
      return { revision: scene.revision };
    },
    // See replace above: the rejection contract is part of the async signature.
    // eslint-disable-next-line @typescript-eslint/require-await
    async append(items, options = {}) {
      assertArgument(isArrayValue(items), 'features.append: expected an array of features');
      throwIfAborted(options.signal);
      source.mutate((change) => {
        for (const item of items) {
          source.addOne(change, item, {
            upsert: options.upsert === true,
            ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
          });
        }
      });
      return { revision: scene.revision };
    },
    count() {
      return source.count();
    },
    ids(options) {
      const out: FeatureId[] = [];
      source.store.forEachLive((record) => {
        if (options?.namespace !== undefined && record.namespace !== options.namespace) return;
        out.push(record.id);
      });
      return out;
    },
    each(visit, options) {
      let seen = 0;
      source.store.forEachLive((record) => {
        if (options?.namespace !== undefined && record.namespace !== options.namespace) return;
        visit(source.snapshotOf(record));
        seen++;
      });
      return seen;
    },
  };

  const applyPrepared = async (
    items: readonly FeatureInput[],
    mode: 'replace' | 'append',
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    throwIfAborted(signal);
    const options = signal ? { signal } : {};
    if (mode === 'replace') {
      await features.replace(items, options);
    } else {
      await features.append(items, options);
    }
  };

  const pipelineOptions = (options: {
    readonly signal?: AbortSignal;
    readonly copy?: boolean;
  }): { signal?: AbortSignal; copy?: boolean; revision: number } => ({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.copy === undefined ? {} : { copy: options.copy }),
    revision: scene.revision,
  });

  const handle: VectorSourceHandle = {
    id: source.id,
    type: 'vector',
    features,
    snapshot() {
      return { sourceId: source.id, revision: scene.revision, count: source.count() };
    },
    getBounds() {
      return source.bounds();
    },
    async importGeoJson(geojson, options = {}) {
      const items = await scene.importPipeline.submit(
        { kind: 'geojson', sourceId: source.id, input: geojson },
        pipelineOptions(options),
      );
      await applyPrepared(items, options.mode ?? 'replace', options.signal);
      return { revision: scene.revision };
    },
    async importColumnar(batch, options = {}) {
      if (batch?.kind === 'point') {
        const prepared = await scene.importPipeline.submit(
          {
            kind: 'columnar-points',
            sourceId: source.id,
            batch,
            positionKind: source.crs.positionKind,
          },
          pipelineOptions(options),
        );
        await cancellationCheckpoint(options.signal);
        throwIfAborted(options.signal);
        source.mutate((change) =>
          importPointTransaction(
            source,
            change,
            prepared,
            options.mode ?? 'replace',
            options.signal,
          ),
        );
        return { revision: scene.revision };
      }
      const projectionCode = nativeProjectionCode(source.crs);
      const parts = await scene.importPipeline.submit(
        {
          kind: 'columnar-parts',
          sourceId: source.id,
          batch,
          positionKind: source.crs.positionKind,
          ...(projectionCode === undefined ? {} : { projectionCode }),
        },
        pipelineOptions(options),
      );
      throwIfAborted(options.signal);
      await cancellationCheckpoint(options.signal);
      const prepared =
        parts.kind === 'raw-parts'
          ? prepareParts(parts.batch, source.crs, `columnar(${source.id})`)
          : parts;
      source.mutate((change) =>
        source.importPreparedParts(change, prepared, options.mode ?? 'replace', options.signal),
      );
      return { revision: scene.revision };
    },
    exportGeoJson(options = {}) {
      const snapshots: FeatureSnapshot[] = [];
      if (options.ids) {
        for (const id of options.ids) {
          const record = source.store.get(id);
          if (record) snapshots.push(source.snapshotOf(record));
        }
      } else {
        source.store.forEachLive((record) => {
          snapshots.push(source.snapshotOf(record));
        });
      }
      return featuresToGeoJson(snapshots);
    },
    subscribe(fn, options) {
      fn(initialSnapshot(source, scene.revision));
      return source.changeEmitter.on('change', fn, options);
    },
    on(type, fn, options) {
      if (type !== 'change') {
        fail('invalid-argument', `unknown source event: ${String(type)}`);
      }
      return source.changeEmitter.on('change', fn, options);
    },
  };
  return { handle, source };
}

function initialSnapshot(source: SourceImpl, revision: number): SourceSnapshot {
  return {
    sourceId: source.id,
    revision,
    count: source.count(),
    initial: true,
    change: null,
  };
}

function resolveInput(
  source: SourceImpl,
  input: FeatureId | FeatureRef,
  options: FeatureQueryOptions | undefined,
): FeatureRef {
  if (typeof input === 'object' && input !== null && 'id' in input && 'generation' in input) {
    return input;
  }
  const id = input;
  const namespace = options?.namespace;
  const record = source.store.get(id, namespace);
  if (!record) {
    fail('not-found', `feature not found: ${String(id)}`, {
      id,
      sourceId: source.id,
      namespace: namespace ?? null,
    });
  }
  return source.refOf(record);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    fail('aborted', 'operation aborted', {});
  }
}

/** Let queued abort tasks run after preparation before atomic, synchronous publication. */
async function cancellationCheckpoint(signal: AbortSignal | undefined): Promise<void> {
  if (signal) {
    throwIfAborted(signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(signal);
  }
}

function replaceTransaction(
  source: SourceImpl,
  change: PendingChange,
  items: readonly FeatureInput[],
  options: ReplaceOptions,
): void {
  // Validate all identities before touching live data.
  const seen = new Set<string>();
  const resolved: FeatureInput[] = items.map((item) => {
    const id = item.id ?? source.nextId();
    const namespace = item.namespace ?? options.namespace;
    const key = featureIdKey(id, namespace);
    if (seen.has(key)) {
      fail('duplicate-id', `features.replace: duplicate id in input: ${String(id)}`, { id });
    }
    seen.add(key);
    return {
      id,
      geometry: item.geometry,
      ...(namespace === undefined ? {} : { namespace }),
      ...(item.properties === undefined ? {} : { properties: item.properties }),
    };
  });
  // A replace keeps identities of retained features (upsert) and removes the rest.
  const retained = new Set(resolved.map((item) => featureIdKey(item.id!, item.namespace)));
  const toRemove: SlotRecord[] = [];
  source.store.forEachLive((record) => {
    if (!retained.has(record.key)) toRemove.push(record);
  });
  for (const record of toRemove) {
    throwIfAborted(options.signal);
    source.removeOne(change, source.refOf(record), 'features.replace');
  }
  for (const item of resolved) {
    throwIfAborted(options.signal);
    const before = source.store.get(item.id!, item.namespace);
    if (before) {
      source.replaceOne(change, source.refOf(before), item);
    } else {
      source.addOne(change, item, options);
    }
  }
}

/** Publish the validated columns directly, avoiding a second full feature-object tree. */
function importPointTransaction(
  source: SourceImpl,
  change: PendingChange,
  batch: ColumnarPointBatch,
  mode: 'replace' | 'append',
  signal: AbortSignal | undefined,
): void {
  if (source.initializePointImport(change, batch, signal)) return;
  const count = batch.positions.length / 2;
  const ids: FeatureId[] = new Array<FeatureId>(count);
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const id = batch.ids?.[i] ?? source.nextId();
    const key = featureIdKey(id);
    if (seen.has(key))
      fail('duplicate-id', `columnar import: duplicate id in input: ${String(id)}`, { id });
    seen.add(key);
    ids[i] = id;
  }
  if (mode === 'replace') {
    const removed: SlotRecord[] = [];
    source.store.forEachLive((record) => {
      if (!seen.has(record.key)) removed.push(record);
    });
    for (const record of removed) source.removeOne(change, source.refOf(record), 'importColumnar');
  }
  for (let i = 0; i < count; i++) {
    throwIfAborted(signal);
    const x = batch.positions[i * 2]!;
    const y = batch.positions[i * 2 + 1]!;
    const altitude = batch.altitudes?.[i];
    const position =
      source.crs.positionKind === 'planar'
        ? { x, y }
        : altitude === undefined || Number.isNaN(altitude)
          ? { lng: x, lat: y }
          : { lng: x, lat: y, altitude };
    const input = {
      id: ids[i]!,
      geometry: { type: 'point', position } as Geometry,
      properties: batch.properties?.[i] ?? EMPTY_PROPERTIES,
    };
    const record = source.store.get(input.id);
    if (record && mode === 'replace') source.replaceOne(change, source.refOf(record), input);
    else source.addOne(change, input, {});
  }
}
