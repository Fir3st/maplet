/**
 * Feature store: stable identity, generations, geometry and properties.
 *
 * Design:
 * - identity is the compound key (namespace, typeof id, id); `42` and `'42'` are
 *   different features (DATA-03);
 * - removal keeps a per-identity generation counter forever, so a removed and
 *   re-created feature can never alias an old reference (REF-06, DATA-08);
 * - point features keep their world position inline (hot path); complex geometry
 *   stores a prepared payload with vertex pools and a world-space bounding box;
 * - live records are indexed by an incremental uniform grid used by spatial
 *   queries and the frame planner; oversized features live in a fallback list.
 */

import { fail } from '../api/errors.ts';
import type { FeatureId, Position } from '../api/types.ts';
import { featureIdKey } from '../api/types.ts';
import { ChangeJournal } from './change-journal.ts';
import type { Crs } from '../math/crs.ts';
import {
  GEOMETRY_KIND,
  prepareGeometry,
  positionToWorldChecked,
  type GeometryKindCode,
  type PreparedFeatureGeometry,
} from '../geometry/geometry.ts';

export interface SlotRecord {
  readonly slot: number;
  readonly key: string;
  readonly id: FeatureId;
  readonly namespace: string | undefined;
  generation: number;
  kind: GeometryKindCode;
  /** Point fast path: world position. */
  wx: number;
  wy: number;
  /** Point altitude in metres, when the source position had one. */
  alt: number | undefined;
  /** Complex geometry; `null` for plain points. */
  geometry: PreparedFeatureGeometry | null;
  properties: Readonly<Record<string, unknown>>;
}

export interface AddRecordInput {
  readonly id: FeatureId;
  readonly namespace: string | undefined;
  readonly geometry: unknown;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

export interface AddRecordResult {
  readonly slot: number;
  readonly generation: number;
  readonly replaced: boolean;
  readonly previous: SlotRecord | null;
}

/** Prepared geometry ingest (vector tiles); skips the public geometry validation. */
export interface AddPreparedRecordInput {
  readonly id: FeatureId;
  readonly namespace: string | undefined;
  readonly prepared: PreparedFeatureGeometry;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

export interface GeometryState {
  readonly kind: GeometryKindCode;
  readonly wx: number;
  readonly wy: number;
  readonly alt: number | undefined;
  readonly geometry: PreparedFeatureGeometry | null;
  readonly bbox: Float64Array;
}

type RecordGeometry = Pick<SlotRecord, 'kind' | 'wx' | 'wy' | 'alt' | 'geometry'>;

const INDEX_LEVEL = 12;
const MAX_CELLS_PER_FEATURE = 64;
export const EMPTY_PROPERTIES: Readonly<Record<string, unknown>> = Object.freeze({});

export function recordBBox(record: SlotRecord): Float64Array {
  if (record.geometry) return record.geometry.bbox;
  return Float64Array.of(record.wx, record.wy, record.wx, record.wy);
}

export class SpatialIndex {
  private readonly n = 1 << INDEX_LEVEL;
  private readonly cells = new Map<number, number[]>();
  private readonly oversized = new Set<number>();

  private clampCell(value: number): number {
    if (value < 0) return 0;
    if (value >= this.n) return this.n - 1;
    return value;
  }

  private clampRange(minX: number, minY: number, maxX: number, maxY: number): {
    x0: number; y0: number; x1: number; y1: number;
  } {
    return {
      x0: this.clampCell(Math.floor((minX / 256) * this.n)),
      y0: this.clampCell(Math.floor((minY / 256) * this.n)),
      x1: this.clampCell(Math.floor((maxX / 256) * this.n)),
      y1: this.clampCell(Math.floor((maxY / 256) * this.n)),
    };
  }

  add(slot: number, bbox: Float64Array): void {
    const { x0, y0, x1, y1 } = this.clampRange(bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!);
    const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (cellCount > MAX_CELLS_PER_FEATURE) {
      this.oversized.add(slot);
      return;
    }
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        this.addToCell(cy * this.n + cx, slot);
      }
    }
  }

  /** A point occupies one cell; no temporary rectangle or typed array is needed. */
  addPoint(slot: number, wx: number, wy: number): void {
    const cx = this.clampCell(Math.floor((wx / 256) * this.n));
    const cy = this.clampCell(Math.floor((wy / 256) * this.n));
    this.addToCell(cy * this.n + cx, slot);
  }

  private addToCell(key: number, slot: number): void {
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(slot);
  }

  removeWithBBox(slot: number, bbox: Float64Array): void {
    if (this.oversized.delete(slot)) return;
    const { x0, y0, x1, y1 } = this.clampRange(bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        this.removeFromCell(cy * this.n + cx, slot);
      }
    }
  }

  private removeFromCell(cell: number, slot: number): void {
    const bucket = this.cells.get(cell);
    if (!bucket) return;
    const at = bucket.indexOf(slot);
    if (at < 0) return;
    bucket[at] = bucket[bucket.length - 1]!;
    bucket.pop();
    if (bucket.length === 0) this.cells.delete(cell);
  }

  update(slot: number, previousBBox: Float64Array, bbox: Float64Array): void {
    this.removeWithBBox(slot, previousBBox);
    this.add(slot, bbox);
  }

  /** Visits candidate slots whose cells intersect the world-space rectangle. */
  queryRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (slot: number) => void,
  ): void {
    const { x0, y0, x1, y1 } = this.clampRange(minX, minY, maxX, maxY);
    const cellsInRange = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (cellsInRange * 4 >= this.cells.size) {
      for (const bucket of this.cells.values()) {
        for (const slot of bucket) visit(slot);
      }
    } else {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const bucket = this.cells.get(cy * this.n + cx);
          if (!bucket) continue;
          for (const slot of bucket) visit(slot);
        }
      }
    }
    for (const slot of this.oversized) visit(slot);
  }

  statistics(): { buckets: number; entries: number; oversized: number } {
    let entries = 0;
    for (const bucket of this.cells.values()) entries += bucket.length;
    return { buckets: this.cells.size, entries, oversized: this.oversized.size };
  }
}

export class FeatureStore {
  readonly changes = new ChangeJournal<number>();
  private complexCount = 0;
  private readonly byKey = new Map<string, number>();
  /** Generation counter per identity; kept for the store's whole lifetime. */
  private readonly generationCounters = new Map<string, number>();
  private readonly slots: (SlotRecord | null)[] = [];
  private readonly freeSlots: number[] = [];
  private liveCount = 0;
  private bounds: Float64Array | null = null;
  private boundsDirty = false;
  private readonly index = new SpatialIndex();
  private visitStamp: Uint32Array = new Uint32Array(0);
  private visitEpoch = 0;
  private readonly crs: Crs;

  constructor(crs: Crs) {
    this.crs = crs;
  }

  get count(): number {
    return this.liveCount;
  }

  get pointOnly(): boolean { return this.complexCount === 0; }
  get slotCapacity(): number { return this.slots.length; }

  keyOf(id: FeatureId, namespace?: string): string {
    return featureIdKey(id, namespace);
  }

  has(id: FeatureId, namespace?: string): boolean {
    return this.byKey.has(this.keyOf(id, namespace));
  }

  get(id: FeatureId, namespace?: string): SlotRecord | undefined {
    const slot = this.byKey.get(this.keyOf(id, namespace));
    return slot === undefined ? undefined : this.slots[slot] ?? undefined;
  }

  getBySlot(slot: number): SlotRecord | undefined {
    return this.slots[slot] ?? undefined;
  }

  /** Validates and prepares a record without mutating the store. */
  prepareGeometry(geometry: unknown): PreparedFeatureGeometry {
    return prepareGeometry(this.crs, geometry, 'geometry');
  }

  /**
   * Adds or replaces a record. Duplicate IDs are rejected unless `upsert` is set.
   * Returns the previous record so callers can build undo entries.
   */
  add(input: AddRecordInput, upsert = false): AddRecordResult {
    const geometry = input.geometry;
    if (typeof geometry === 'object' && geometry !== null && (geometry as { type?: unknown }).type === 'point') {
      // Keep the same CRS validation/normalization, but store the checked point
      // inline instead of allocating a prepared payload and degenerate bbox.
      const point = positionToWorldChecked(this.crs, (geometry as { position: Position }).position, 'geometry.position');
      return this.insert(input, {
        kind: GEOMETRY_KIND.point,
        wx: point.wx,
        wy: point.wy,
        alt: point.alt,
        geometry: null,
      }, upsert);
    }
    return this.addPrepared(
      {
        id: input.id,
        namespace: input.namespace,
        prepared: this.prepareGeometry(input.geometry),
        properties: input.properties,
      },
      upsert,
    );
  }

  /** Adds a record whose geometry was prepared by the caller (vector tiles). */
  addPrepared(input: AddPreparedRecordInput, upsert = false): AddRecordResult {
    const prepared = input.prepared;
    return this.insert(input, {
      kind: prepared.kind,
      wx: prepared.anchorX,
      wy: prepared.anchorY,
      alt: prepared.kind === GEOMETRY_KIND.point && prepared.payload.kind === GEOMETRY_KIND.point
        ? prepared.payload.alt : undefined,
      geometry: prepared.kind === GEOMETRY_KIND.point ? null : prepared,
    }, upsert);
  }

  private insert(input: Omit<AddRecordInput, 'geometry'>, geometry: RecordGeometry, upsert: boolean): AddRecordResult {
    const key = this.keyOf(input.id, input.namespace);
    const existingSlot = this.byKey.get(key);
    if (existingSlot !== undefined && !upsert) {
      fail('duplicate-id', `feature id already exists: ${String(input.id)}`, {
        id: input.id,
        namespace: input.namespace ?? null,
      });
    }
    const generation = (this.generationCounters.get(key) ?? 0) + 1;
    this.generationCounters.set(key, generation);
    let previous: SlotRecord | null = null;
    if (existingSlot !== undefined) {
      const old = this.slots[existingSlot];
      if (old) {
        previous = old;
        this.index.removeWithBBox(existingSlot, recordBBox(old));
      }
    }
    const slot = existingSlot ?? this.freeSlots.pop() ?? this.slots.length;
    const record: SlotRecord = {
      slot,
      key,
      id: input.id,
      namespace: input.namespace,
      generation,
      kind: geometry.kind,
      wx: geometry.wx,
      wy: geometry.wy,
      alt: geometry.alt,
      geometry: geometry.geometry,
      properties: input.properties ?? EMPTY_PROPERTIES,
    };
    this.slots[slot] = record;
    if (previous?.geometry) this.complexCount--;
    if (record.geometry) this.complexCount++;
    this.changes.note(slot);
    this.byKey.set(key, slot);
    if (record.geometry) this.index.add(slot, record.geometry.bbox);
    else this.index.addPoint(slot, record.wx, record.wy);
    if (existingSlot === undefined) this.liveCount++;
    this.boundsDirty = true;
    return { slot, generation, replaced: existingSlot !== undefined, previous };
  }

  /** Undo support: re-inserts a previous record at its own slot (after a removal). */
  restore(record: SlotRecord): void {
    const free = this.freeSlots.indexOf(record.slot);
    if (free >= 0) this.freeSlots.splice(free, 1);
    this.slots[record.slot] = record;
    if (record.geometry) this.complexCount++;
    this.changes.note(record.slot);
    this.byKey.set(record.key, record.slot);
    this.index.add(record.slot, recordBBox(record));
    this.liveCount++;
    this.boundsDirty = true;
  }

  /**
   * Undo support for replacements: replaces the current record at `previous.slot`
   * with the previous one. Live count and identity do not change.
   */
  restoreReplacing(previous: SlotRecord, currentBBox: Float64Array): void {
    const current = this.slots[previous.slot];
    if (!current) fail('invalid-state', `slot ${previous.slot} is not live`);
    this.index.removeWithBBox(previous.slot, currentBBox);
    if (current.geometry) this.complexCount--;
    if (previous.geometry) this.complexCount++;
    this.changes.note(previous.slot);
    this.slots[previous.slot] = previous;
    this.byKey.set(previous.key, previous.slot);
    this.index.add(previous.slot, recordBBox(previous));
    this.boundsDirty = true;
  }

  /** Removes a record and returns it (for undo logs and change sets). */
  removeRecord(id: FeatureId, namespace?: string): SlotRecord | null {
    const key = this.keyOf(id, namespace);
    const slot = this.byKey.get(key);
    if (slot === undefined) return null;
    const record = this.slots[slot];
    if (!record) return null;
    this.index.removeWithBBox(slot, recordBBox(record));
    if (record.geometry) this.complexCount--;
    this.changes.note(slot);
    this.slots[slot] = null;
    this.byKey.delete(key);
    this.freeSlots.push(slot);
    this.liveCount--;
    this.boundsDirty = true;
    return record;
  }

  replaceGeometry(slot: number, prepared: PreparedFeatureGeometry): GeometryState {
    const record = this.slots[slot];
    if (!record) fail('invalid-state', `slot ${slot} is not live`);
    const previous: GeometryState = {
      kind: record.kind,
      wx: record.wx,
      wy: record.wy,
      alt: record.alt,
      geometry: record.geometry,
      bbox: recordBBox(record),
    };
    if (record.geometry) this.complexCount--;
    record.kind = prepared.kind;
    record.wx = prepared.anchorX;
    record.wy = prepared.anchorY;
    record.alt =
      prepared.kind === GEOMETRY_KIND.point && prepared.payload.kind === GEOMETRY_KIND.point
        ? prepared.payload.alt
        : undefined;
    record.geometry = prepared.kind === GEOMETRY_KIND.point ? null : prepared;
    if (record.geometry) this.complexCount++;
    this.changes.note(slot);
    this.index.update(slot, previous.bbox, recordBBox(record));
    this.boundsDirty = true;
    return previous;
  }

  restoreGeometryState(slot: number, state: GeometryState, currentBBox: Float64Array): void {
    const record = this.slots[slot];
    if (!record) fail('invalid-state', `slot ${slot} is not live`);
    this.index.removeWithBBox(slot, currentBBox);
    if (record.geometry) this.complexCount--;
    record.kind = state.kind;
    record.wx = state.wx;
    record.wy = state.wy;
    record.alt = state.alt;
    record.geometry = state.geometry;
    if (record.geometry) this.complexCount++;
    this.changes.note(slot);
    this.index.add(slot, state.bbox);
    this.boundsDirty = true;
  }

  setProperties(
    slot: number,
    properties: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const record = this.slots[slot];
    if (!record) fail('invalid-state', `slot ${slot} is not live`);
    const previous = record.properties;
    record.properties = properties;
    this.changes.note(slot);
    return previous;
  }

  boundsNow(): Float64Array | null {
    if (this.bounds && !this.boundsDirty) return this.bounds;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const record of this.slots) {
      if (!record) continue;
      const bbox = recordBBox(record);
      if (bbox[0]! < minX) minX = bbox[0]!;
      if (bbox[1]! < minY) minY = bbox[1]!;
      if (bbox[2]! > maxX) maxX = bbox[2]!;
      if (bbox[3]! > maxY) maxY = bbox[3]!;
    }
    this.bounds = Number.isFinite(minX) ? Float64Array.of(minX, minY, maxX, maxY) : null;
    this.boundsDirty = false;
    return this.bounds;
  }

  forEachLive(visit: (record: SlotRecord) => void): void {
    for (const record of this.slots) {
      if (record) visit(record);
    }
  }

  /** Visits each live record at most once for the given world rectangle. */
  queryRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (record: SlotRecord) => void,
  ): void {
    if (this.visitStamp.length < this.slots.length) {
      const next = new Uint32Array(this.slots.length * 2 + 64);
      next.set(this.visitStamp);
      this.visitStamp = next;
    }
    this.visitEpoch++;
    if (this.visitEpoch >= 0xffffffff) {
      this.visitStamp.fill(0);
      this.visitEpoch = 1;
    }
    const epoch = this.visitEpoch;
    const stamp = this.visitStamp;
    this.index.queryRect(minX, minY, maxX, maxY, (slot) => {
      if (stamp[slot] === epoch) return;
      stamp[slot] = epoch;
      const record = this.slots[slot];
      if (record) visit(record);
    });
  }

  indexStatistics(): { buckets: number; entries: number; oversized: number } {
    return this.index.statistics();
  }
}
