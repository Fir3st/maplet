/**
 * Vector tile (MVT) source.
 *
 * The source is viewport-driven: frame requests reconcile the set of needed
 * tiles, in-flight responses are discarded when their tile was retired (MVT-08),
 * and only then are decoded features assembled into canonical store records.
 *
 * Identity rules (docs/decisions.md):
 * - namespace = MVT source layer, so the same provider id in `roads` and
 *   `buildings` stays two identities (MVT-02);
 * - a provider id is exact, uint64 beyond 2^53 becomes a decimal string (MVT-03);
 * - a feature without a provider id gets an explicit tile-local identity
 *   (`tl:z/x/y:seq`) whose lifetime is the loaded tile: after an unload/reload
 *   it is a new identity and no state transfers to it (MVT-04, MVT-06);
 * - one logical feature keeps ONE store record whose geometry is the union of
 *   its loaded tile fragments, so selection and state never split between
 *   fragments (MVT-01);
 * - unloading tiles removes provider features that have no loaded fragment
 *   left; the source is read-only, so this is a declared availability change,
 *   not a user deletion (MVT-05). Edits belong in a mutable overlay source
 *   (MVT-07).
 */

import { fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import {
  featureIdKey,
  type FeatureId,
  type FeatureProperties,
  type FeatureRef,
  type FeatureSnapshot,
  type Geometry,
  type SubscribeOptions,
  type Unsubscribe,
} from '../api/types.ts';
import type { Crs } from '../math/crs.ts';
import { GEOMETRY_KIND, type PreparedFeatureGeometry } from '../geometry/geometry.ts';
import {
  decodeMvtTile,
  type MvtFeature,
  type MvtLayer,
  type MvtLineGeometry,
  type MvtPointGeometry,
  type MvtPolygonGeometry,
} from '../formats/mvt.ts';
import { formatTileUrl, tilesForWorldRect, type TileCoord } from '../formats/raster.ts';
import { SourceImpl, type SourceChange, type SourceInternals, type SourceSnapshot } from './source.ts';
import type { ViewImpl } from '../view/view.ts';

/* ------------------------------- options --------------------------------- */

export interface TileFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type TileFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<TileFetchResponse>;

export interface VectorTilesOptions {
  readonly id: string;
  /** URL template with `{z}` `{x}` `{y}` (and optional `{s}` subdomains). */
  readonly url: string;
  /** Lowest tile zoom to request; defaults to 0. */
  readonly minZoom?: number;
  /** Highest tile zoom the provider has; above it tiles are overzoomed; defaults to 14. */
  readonly maxZoom?: number;
  /** Tile grid size used for the request grid; defaults to 256. */
  readonly tileSize?: number;
  /** Hard cap on simultaneously kept (loading + loaded) tiles; defaults to 128. */
  readonly maxTiles?: number;
  /** Concurrent requests; defaults to 4. */
  readonly maxParallel?: number;
  readonly subdomains?: readonly string[];
  readonly tms?: boolean;
  readonly attribution?: string;
  /** Injection point for tests and non-browser environments. */
  readonly fetchFn?: TileFetch;
}

export interface VectorTilesStats {
  /** Tiles currently loaded, in request grid order. */
  readonly loaded: readonly TileCoord[];
  readonly loading: number;
  /** Tiles that failed to fetch or decode; retried after eviction and return. */
  readonly failed: number;
  /** Needed tiles not scheduled because the budget is full. */
  readonly deferred: number;
  readonly fragments: number;
}

export interface VectorTilesSourceSnapshot {
  readonly sourceId: string;
  readonly revision: number;
  readonly url: string;
  readonly count: number;
  readonly stats: VectorTilesStats;
}

/** Read-only access to the provider features (MVT-07: edits use an overlay). */
export interface VectorTilesFeaturesHandle<G = Geometry, P = FeatureProperties> {
  get(id: FeatureId, options?: { readonly namespace?: string }): FeatureSnapshot<G, P> | undefined;
  ref(id: FeatureId, options?: { readonly namespace?: string }): FeatureRef<G, P>;
  has(id: FeatureId, options?: { readonly namespace?: string }): boolean;
  count(options?: { readonly namespace?: string }): number;
  ids(options?: { readonly namespace?: string }): FeatureId[];
  each(
    visit: (snapshot: FeatureSnapshot<G, P>) => void,
    options?: { readonly namespace?: string },
  ): number;
}

export interface VectorTilesSourceHandle {
  readonly id: string;
  readonly type: 'vectorTiles';
  readonly features: VectorTilesFeaturesHandle;
  snapshot(): VectorTilesSourceSnapshot;
  /** URL/grid change; loaded tiles are dropped and re-requested. */
  update(patch: Partial<VectorTilesOptions>): void;
  subscribe(fn: (snapshot: VectorTilesSourceSnapshot) => void, options?: SubscribeOptions): Unsubscribe;
  on(
    type: 'change',
    fn: (snapshot: VectorTilesSourceSnapshot) => void,
    options?: SubscribeOptions,
  ): Unsubscribe;
}

/* -------------------------------- internals ------------------------------ */

export interface VectorTileSceneInternals extends SourceInternals {
  readonly attachedView: ViewImpl;
  requestFrame(): void;
  publishStateChange(): void;
}

interface FragmentRecord {
  readonly tile: TileState;
  readonly logicalKey: string;
  readonly id: FeatureId;
  readonly layerName: string;
  readonly extent: number;
  readonly feature: MvtFeature;
}

interface TileState {
  readonly key: string;
  readonly coord: TileCoord;
  state: 'loading' | 'ready' | 'error';
  error: string | null;
  fragments: FragmentRecord[];
  controller: AbortController | null;
  queued: boolean;
  retired: boolean;
  /** Sticky failure count is tracked on the source; the flag keeps retries honest. */
  failed: boolean;
}

interface LogicalEntry {
  readonly namespace: string;
  readonly id: FeatureId;
  readonly tileLocal: boolean;
  fragments: FragmentRecord[];
}

const CHANGE_SAMPLE_LIMIT = 4096;

function tileKey(coord: TileCoord): string {
  return `${coord.z}/${coord.x}/${coord.y}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ------------------------------- source ---------------------------------- */

export class VectorTileSourceImpl extends SourceImpl {
  options: VectorTilesOptions;
  readonly tileEmitter = new Emitter<{ change: VectorTilesSourceSnapshot }>();
  private readonly host: VectorTileSceneInternals;
  private readonly tiles = new Map<string, TileState>();
  private readonly logical = new Map<string, LogicalEntry>();
  private readonly queue: TileState[] = [];
  private readonly dirty = new Set<string>();
  private fetchFn: TileFetch;
  private inflight = 0;
  private localSeq = 0;
  private deferred = 0;
  private reconcileQueued = false;
  private destroyedFlag = false;
  private failedTiles = 0;
  private rejectedFeatures = 0;

  constructor(
    scene: VectorTileSceneInternals,
    id: string,
    crs: Crs,
    options: VectorTilesOptions,
  ) {
    super(scene, id, crs);
    this.host = scene;
    this.options = normalizeOptions(options);
    this.fetchFn = options.fetchFn ?? defaultFetch;
  }

  override destroyStore(): void {
    this.destroyedFlag = true;
    for (const tile of this.tiles.values()) {
      tile.retired = true;
      tile.controller?.abort();
    }
    this.tiles.clear();
    this.logical.clear();
    this.queue.length = 0;
    this.dirty.clear();
    this.tileEmitter.clear();
    super.destroyStore();
  }

  /** The scene asks for viewport-owned work on every frame request. */
  override onFrameRequest(): void {
    if (this.destroyedFlag || this.reconcileQueued) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      this.reconcile();
    });
  }

  update(patch: Partial<VectorTilesOptions>): void {
    if (this.destroyedFlag) fail('destroyed', `source ${this.id} has been destroyed`, { sourceId: this.id });
    this.options = normalizeOptions({ ...this.options, ...patch });
    if (patch.fetchFn) this.fetchFn = patch.fetchFn;
    // Drop every tile: the URL/grid contract changed.
    for (const tile of Array.from(this.tiles.values())) this.retireTile(tile);
    this.applyDirty();
    this.emitChange(null);
  }

  stats(): VectorTilesStats {
    const loaded: TileCoord[] = [];
    let loading = 0;
    let fragments = 0;
    for (const tile of this.tiles.values()) {
      if (tile.state === 'ready') loaded.push(tile.coord);
      if (tile.state === 'loading') loading++;
      fragments += tile.fragments.length;
    }
    loaded.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
    return {
      loaded,
      loading,
      failed: this.failedTiles,
      deferred: this.deferred,
      fragments,
    };
  }

  /* --------------------------- viewport reconcile ------------------------ */

  private reconcile(): void {
    if (this.destroyedFlag) return;
    if (this.host.inBatch) return;
    let view: ViewImpl;
    try {
      view = this.host.attachedView;
    } catch {
      return;
    }
    const transform = view.transform();
    const minZoom = this.options.minZoom ?? 0;
    const maxZoom = this.options.maxZoom ?? 14;
    const zoom = Math.max(minZoom, Math.min(maxZoom, Math.floor(transform.zoom)));
    const scale = 2 ** transform.zoom;
    const halfWidth = transform.width / (2 * scale);
    const halfHeight = transform.height / (2 * scale);
    const coords = tilesForWorldRect(
      transform.centerWorld.x - halfWidth,
      transform.centerWorld.y - halfHeight,
      transform.centerWorld.x + halfWidth,
      transform.centerWorld.y + halfHeight,
      zoom,
      this.options.tileSize ?? 256,
      { wrap: false, minZoom, maxZoom },
    );
    const needed = new Set<string>();
    for (const coord of coords) needed.add(tileKey(coord));
    // Viewport residency: tiles outside the current need are retired (MVT-05).
    for (const tile of Array.from(this.tiles.values())) {
      if (!needed.has(tile.key)) this.retireTile(tile);
    }
    const maxTiles = this.options.maxTiles ?? 128;
    const center = transform.centerWorld;
    const tileWorld = (this.options.tileSize ?? 256) / 2 ** zoom;
    const ordered = coords
      .slice()
      .sort((a, b) => {
        const da = Math.hypot(
          (a.x + 0.5) * tileWorld - center.x,
          (a.y + 0.5) * tileWorld - center.y,
        );
        const db = Math.hypot(
          (b.x + 0.5) * tileWorld - center.x,
          (b.y + 0.5) * tileWorld - center.y,
        );
        return da - db || a.y - b.y || a.x - b.x;
      });
    let deferred = 0;
    for (const coord of ordered) {
      const key = tileKey(coord);
      if (this.tiles.has(key)) continue;
      if (this.tiles.size >= maxTiles) {
        deferred++;
        continue;
      }
      this.startTile(coord);
    }
    this.deferred = deferred;
    this.applyDirty();
  }

  private startTile(coord: TileCoord): void {
    const tile: TileState = {
      key: tileKey(coord),
      coord,
      state: 'loading',
      error: null,
      fragments: [],
      controller: null,
      queued: false,
      retired: false,
      failed: false,
    };
    this.tiles.set(tile.key, tile);
    const maxParallel = this.options.maxParallel ?? 4;
    if (this.inflight < maxParallel) {
      this.beginFetch(tile);
    } else {
      tile.queued = true;
      this.queue.push(tile);
    }
  }

  private beginFetch(tile: TileState): void {
    const controller = new AbortController();
    tile.controller = controller;
    this.inflight++;
    const url = formatTileUrl(
      this.options.subdomains
        ? { url: this.options.url, subdomains: this.options.subdomains }
        : { url: this.options.url },
      tile.coord,
      { tms: this.options.tms ?? false },
    );
    let request: Promise<TileFetchResponse>;
    try {
      request = this.fetchFn(url, { signal: controller.signal });
    } catch (error) {
      this.finishFetch(tile);
      this.fetchFailed(tile, error);
      return;
    }
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.finishFetch(tile);
    };
    request
      .then(async (response) => {
        if (!response.ok) throw new Error(`tile request failed: HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        finish();
        // Stale responses never overwrite a newer tile state (MVT-08).
        if (this.destroyedFlag || tile.retired || this.tiles.get(tile.key) !== tile) return;
        try {
          const decoded = decodeMvtTile(buffer);
          this.installTile(tile, decoded.tile.layers, decoded.rejectedFeatures);
        } catch (error) {
          tile.state = 'error';
          tile.error = messageOf(error);
          tile.failed = true;
          this.failedTiles++;
          this.emitChange(null);
        }
      })
      .catch((error) => {
        finish();
        if (this.destroyedFlag || tile.retired || this.tiles.get(tile.key) !== tile) return;
        this.fetchFailed(tile, error);
      });
  }

  private fetchFailed(tile: TileState, error: unknown): void {
    tile.state = 'error';
    tile.error = messageOf(error);
    tile.failed = true;
    this.failedTiles++;
    this.emitChange(null);
  }

  private finishFetch(tile: TileState): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (tile.controller) {
      tile.controller = null;
    }
    while (this.inflight < (this.options.maxParallel ?? 4) && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.queued = false;
      if (next.retired || this.tiles.get(next.key) !== next) continue;
      this.beginFetch(next);
    }
  }

  private retireTile(tile: TileState): void {
    tile.retired = true;
    tile.controller?.abort();
    if (tile.queued) {
      const at = this.queue.indexOf(tile);
      if (at >= 0) this.queue.splice(at, 1);
      tile.queued = false;
    }
    for (const fragment of tile.fragments) {
      const entry = this.logical.get(fragment.logicalKey);
      if (!entry) continue;
      const at = entry.fragments.indexOf(fragment);
      if (at >= 0) entry.fragments.splice(at, 1);
      this.dirty.add(fragment.logicalKey);
    }
    if (tile.state === 'error') this.failedTiles = Math.max(0, this.failedTiles - 1);
    tile.fragments = [];
    this.tiles.delete(tile.key);
  }

  private installTile(tile: TileState, layers: readonly MvtLayer[], rejectedFeatures: number): void {
    tile.state = 'ready';
    this.rejectedFeatures += rejectedFeatures;
    for (const layer of layers) {
      for (const feature of layer.features) {
        const id: FeatureId = feature.id ?? `tl:${tile.key}:${feature.index}#${this.localSeq++}`;
        const key = featureIdKey(id, layer.name);
        let entry = this.logical.get(key);
        if (!entry) {
          entry = {
            namespace: layer.name,
            id,
            tileLocal: feature.id === null,
            fragments: [],
          };
          this.logical.set(key, entry);
        }
        const fragment: FragmentRecord = {
          tile,
          logicalKey: key,
          id,
          layerName: layer.name,
          extent: layer.extent,
          feature,
        };
        entry.fragments.push(fragment);
        tile.fragments.push(fragment);
        this.dirty.add(key);
      }
    }
    this.applyDirty();
  }

  private applyDirty(): void {
    if (this.dirty.size === 0) return;
    if (this.host.inBatch) return;
    const keys = Array.from(this.dirty);
    this.dirty.clear();
    const added: FeatureId[] = [];
    const updated: FeatureId[] = [];
    const removed: FeatureId[] = [];
    for (const key of keys) {
      const entry = this.logical.get(key);
      if (!entry) continue;
      const existing = this.store.get(entry.id, entry.namespace);
      if (entry.fragments.length === 0) {
        if (existing) {
          this.store.removeRecord(entry.id, entry.namespace);
          removed.push(entry.id);
        }
        this.logical.delete(key);
        continue;
      }
      const prepared = this.assemble(entry);
      if (!prepared) continue;
      const properties = entry.fragments[0]!.feature.properties;
      if (existing) {
        this.store.replaceGeometry(existing.slot, prepared);
        this.store.setProperties(existing.slot, properties);
        updated.push(entry.id);
      } else {
        this.store.addPrepared({
          id: entry.id,
          namespace: entry.namespace,
          prepared,
          properties,
        });
        added.push(entry.id);
      }
    }
    if (added.length + updated.length + removed.length === 0) return;
    this.emitChange({ added, updated, removed });
  }

  /* ------------------------------ assembly -------------------------------- */

  private assemble(entry: LogicalEntry): PreparedFeatureGeometry | null {
    const fragments = entry.fragments
      .slice()
      .sort(
        (a, b) =>
          a.tile.coord.z - b.tile.coord.z ||
          a.tile.coord.y - b.tile.coord.y ||
          a.tile.coord.x - b.tile.coord.x ||
          a.feature.index - b.feature.index,
      );
    const kind = fragments[0]!.feature.geometry.kind;
    if (fragments.some((fragment) => fragment.feature.geometry.kind !== kind)) {
      this.rejectedFeatures++;
      return null;
    }
    if (kind === 'point') {
      const points: number[] = [];
      for (const fragment of fragments) {
        const geometry = fragment.feature.geometry as MvtPointGeometry;
        const transform = this.tileTransform(fragment);
        for (let i = 0; i < geometry.points.length; i += 2) {
          points.push(
            transform.x0 + geometry.points[i]! * transform.scale,
            transform.y0 + geometry.points[i + 1]! * transform.scale,
          );
        }
      }
      if (points.length < 2) return null;
      if (points.length === 2) {
        const wx = points[0]!;
        const wy = points[1]!;
        return {
          kind: GEOMETRY_KIND.point,
          payload: { kind: GEOMETRY_KIND.point, wx, wy },
          bbox: Float64Array.of(wx, wy, wx, wy),
          anchorX: wx,
          anchorY: wy,
        };
      }
      const array = Float64Array.from(points);
      const bbox = bboxOf(array);
      return {
        kind: GEOMETRY_KIND.multiPoint,
        payload: { kind: GEOMETRY_KIND.multiPoint, points: array },
        bbox,
        anchorX: (bbox[0]! + bbox[2]!) / 2,
        anchorY: (bbox[1]! + bbox[3]!) / 2,
      };
    }
    if (kind === 'line') {
      const vertices: number[] = [];
      const parts: number[] = [];
      for (const fragment of fragments) {
        const geometry = fragment.feature.geometry as MvtLineGeometry;
        const transform = this.tileTransform(fragment);
        const start = vertices.length / 2;
        for (let i = 0; i < geometry.vertices.length; i += 2) {
          vertices.push(
            transform.x0 + geometry.vertices[i]! * transform.scale,
            transform.y0 + geometry.vertices[i + 1]! * transform.scale,
          );
        }
        parts.push(start, geometry.vertices.length / 2);
      }
      if (parts.length === 0) return null;
      const array = Float64Array.from(vertices);
      const bbox = bboxOf(array);
      const kindCode =
        parts.length === 2 ? GEOMETRY_KIND.lineString : GEOMETRY_KIND.multiLineString;
      return {
        kind: kindCode,
        payload: { kind: kindCode, vertices: array, parts: Uint32Array.from(parts) },
        bbox,
        anchorX: (bbox[0]! + bbox[2]!) / 2,
        anchorY: (bbox[1]! + bbox[3]!) / 2,
      };
    }
    const ringVertices: number[] = [];
    const rings: number[] = [];
    const ringOuter: number[] = [];
    let outerCount = 0;
    for (const fragment of fragments) {
      const geometry = fragment.feature.geometry as MvtPolygonGeometry;
      const transform = this.tileTransform(fragment);
      const vertexOffset = ringVertices.length / 2;
      for (let i = 0; i < geometry.ringVertices.length; i += 2) {
        ringVertices.push(
          transform.x0 + geometry.ringVertices[i]! * transform.scale,
          transform.y0 + geometry.ringVertices[i + 1]! * transform.scale,
        );
      }
      for (let r = 0; r < geometry.rings.length; r += 2) {
        rings.push(vertexOffset + geometry.rings[r]!, geometry.rings[r + 1]!);
      }
      for (let r = 0; r < geometry.ringOuter.length; r++) {
        ringOuter.push(geometry.ringOuter[r]!);
        if (geometry.ringOuter[r] === 1) outerCount++;
      }
    }
    if (rings.length === 0) return null;
    const array = Float64Array.from(ringVertices);
    const bbox = bboxOf(array);
    const kindCode = outerCount === 1 ? GEOMETRY_KIND.polygon : GEOMETRY_KIND.multiPolygon;
    return {
      kind: kindCode,
      payload: {
        kind: kindCode,
        ringVertices: array,
        rings: Uint32Array.from(rings),
        ringOuter: Uint8Array.from(ringOuter),
      },
      bbox,
      anchorX: (bbox[0]! + bbox[2]!) / 2,
      anchorY: (bbox[1]! + bbox[3]!) / 2,
    };
  }

  private tileTransform(fragment: FragmentRecord): { x0: number; y0: number; scale: number } {
    const { z, x, y } = fragment.tile.coord;
    const tileWorld = 256 / 2 ** z;
    return {
      x0: x * tileWorld,
      y0: y * tileWorld,
      scale: tileWorld / fragment.extent,
    };
  }

  private emitChange(parts: { added: FeatureId[]; updated: FeatureId[]; removed: FeatureId[] } | null): void {
    if (this.destroyedFlag) return;
    this.host.publishStateChange();
    const change: SourceChange | null = parts
      ? {
          addedCount: parts.added.length,
          updatedCount: parts.updated.length,
          removedCount: parts.removed.length,
          added: parts.added.slice(0, CHANGE_SAMPLE_LIMIT),
          updated: parts.updated.slice(0, CHANGE_SAMPLE_LIMIT),
          removed: parts.removed.slice(0, CHANGE_SAMPLE_LIMIT),
        }
      : null;
    const snapshot: VectorTilesSourceSnapshot & SourceSnapshot = {
      sourceId: this.id,
      revision: this.host.revision,
      count: this.count(),
      initial: false,
      change,
      url: this.options.url,
      stats: this.stats(),
    };
    this.changeEmitter.emit('change', snapshot);
    this.tileEmitter.emit('change', snapshot);
  }

  /* ------------------------------ read-only handle ------------------------ */

  createHandle(): VectorTilesSourceHandle {
    const features: VectorTilesFeaturesHandle = {
      get: (id, options) => {
        const record = this.store.get(id, options?.namespace);
        return record ? this.snapshotOf(record) : undefined;
      },
      ref: (id, options) => {
        const record = this.store.get(id, options?.namespace);
        if (!record) {
          fail('not-found', `feature not found: ${String(id)}`, {
            id,
            sourceId: this.id,
            namespace: options?.namespace ?? null,
          });
        }
        return this.refOf(record);
      },
      has: (id, options) => this.store.has(id, options?.namespace),
      count: (options) => {
        if (options?.namespace === undefined) return this.count();
        let seen = 0;
        this.store.forEachLive((record) => {
          if (record.namespace === options.namespace) seen++;
        });
        return seen;
      },
      ids: (options) => {
        const out: FeatureId[] = [];
        this.store.forEachLive((record) => {
          if (options?.namespace !== undefined && record.namespace !== options.namespace) return;
          out.push(record.id);
        });
        return out;
      },
      each: (visit, options) => {
        let seen = 0;
        this.store.forEachLive((record) => {
          if (options?.namespace !== undefined && record.namespace !== options.namespace) return;
          visit(this.snapshotOf(record));
          seen++;
        });
        return seen;
      },
    };
    const snapshot = (): VectorTilesSourceSnapshot => ({
      sourceId: this.id,
      revision: this.host.revision,
      url: this.options.url,
      count: this.count(),
      stats: this.stats(),
    });
    return {
      id: this.id,
      type: 'vectorTiles',
      features,
      snapshot,
      update: (patch) => {
        this.update(patch);
      },
      subscribe: (fn, options) => {
        fn(snapshot());
        return this.tileEmitter.on('change', fn, options);
      },
      on: (type, fn, options) => {
        if (type !== 'change') fail('invalid-argument', `unknown source event: ${String(type)}`);
        return this.tileEmitter.on('change', fn, options);
      },
    };
  }
}

/* -------------------------------- helpers -------------------------------- */

function bboxOf(vertices: Float64Array): Float64Array {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vertices.length; i += 2) {
    const x = vertices[i]!;
    const y = vertices[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Float64Array.of(minX, minY, maxX, maxY);
}

function normalizeOptions(options: VectorTilesOptions): VectorTilesOptions {
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 14;
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom > maxZoom) {
    fail('invalid-argument', 'invalid vector tile zoom limits', { minZoom, maxZoom });
  }
  if (typeof options.url !== 'string' || options.url.length === 0) {
    fail('invalid-argument', 'vectorTiles requires a url template', {});
  }
  return {
    ...options,
    minZoom,
    maxZoom,
    tileSize: options.tileSize ?? 256,
    maxTiles: options.maxTiles ?? 128,
    maxParallel: Math.max(1, options.maxParallel ?? 4),
  };
}

const defaultFetch: TileFetch = (url, init) => {
  if (typeof fetch !== 'function') {
    fail('environment', 'vector tiles require a fetch() implementation', { url });
  }
  return fetch(url, { signal: init.signal }) as unknown as Promise<TileFetchResponse>;
};
