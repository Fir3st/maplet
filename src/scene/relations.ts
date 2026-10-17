/**
 * Typed relations between features: named, directed, M:N and cyclic.
 *
 * Relations have their own identity and never move or delete their endpoints.
 * Endpoint deletion follows an explicit policy:
 * - `reject` (default): the endpoint removal fails before any store change;
 * - `remove-relation`: the relation is removed in the same transaction;
 * - `keep-missing`: the relation stays; its endpoint reference keeps its original
 *   generation and can never re-bind to a new feature with the same ID.
 * REL-01..REL-09.
 */

import { fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import type { FeatureRef, SubscribeOptions, Unsubscribe } from '../api/types.ts';
import type { SourceImpl } from './source.ts';
import type { SlotRecord } from './store.ts';

export interface RelationInput {
  readonly id: string;
  readonly type: string;
  readonly from: FeatureRef;
  readonly to: FeatureRef;
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Policy applied when an endpoint is removed later. Default `reject`. */
  readonly onEndpointRemoved?: EndpointPolicy;
}

export type EndpointPolicy = 'reject' | 'remove-relation' | 'keep-missing';

export interface RelationSnapshot {
  readonly id: string;
  readonly type: string;
  readonly from: FeatureRef;
  readonly to: FeatureRef;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly endpointPolicy: EndpointPolicy;
}

export interface NeighborOptions {
  readonly direction?: 'out' | 'in' | 'both';
  readonly type?: string;
}

export interface TraverseOptions {
  readonly direction?: 'out' | 'in' | 'both';
  readonly type?: string;
  readonly maxDepth?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface RelationsHost {
  getSourceImpl(sourceId: string): SourceImpl | undefined;
  recordUndo(undo: () => void): void;
  publishStateChange(): void;
}

interface StoredRelation {
  id: string;
  type: string;
  from: FeatureRef;
  to: FeatureRef;
  properties: Readonly<Record<string, unknown>>;
  endpointPolicy: EndpointPolicy;
  /** Kept for undo and change events. */
  missing: boolean;
}

function nodeKey(ref: Pick<FeatureRef, 'sourceId' | 'namespace' | 'id' | 'generation'>): string {
  return `${ref.sourceId}\u0000${ref.namespace ?? ''}\u0000${typeof ref.id}:${ref.id}\u0000${ref.generation}`;
}

function endpointKey(ref: Pick<FeatureRef, 'sourceId' | 'namespace' | 'id'>): string {
  return `${ref.sourceId}\u0000${ref.namespace ?? ''}\u0000${typeof ref.id}:${ref.id}`;
}

export class RelationsStore {
  private readonly relations = new Map<string, StoredRelation>();
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();
  private readonly emitter = new Emitter<{ change: { revision: number } }>();
  private defaultPolicy: EndpointPolicy = 'reject';
  revision = 0;
  /** Diagnostics: adjacency entries examined since load. */
  scanCount = 0;
  private readonly host: RelationsHost;

  constructor(host: RelationsHost) {
    this.host = host;
  }

  setDefaultEndpointPolicy(policy: EndpointPolicy): void {
    this.defaultPolicy = policy;
  }

  get size(): number {
    return this.relations.size;
  }

  private validateEndpoint(ref: FeatureRef, relationId: string, role: 'from' | 'to'): SlotRecord {
    if (!ref || typeof ref !== 'object' || !('sourceId' in ref) || !('id' in ref)) {
      fail('invalid-argument', `relation ${relationId}: ${role} must be a feature reference`, {
        ref,
      });
    }
    const source = this.host.getSourceImpl(ref.sourceId);
    if (!source) {
      fail('missing-endpoint', `relation ${relationId}: ${role} source does not exist`, {
        sourceId: ref.sourceId,
      });
    }
    return source.resolveRef(ref, `relation ${relationId} (${role})`);
  }

  add(input: RelationInput): RelationSnapshot {
    if (this.relations.has(input.id)) {
      fail('duplicate-id', `relation id already exists: ${input.id}`, { id: input.id });
    }
    // Validate both endpoints before touching any index (atomic, REL-06).
    const fromRecord = this.validateEndpoint(input.from, input.id, 'from');
    const toRecord = this.validateEndpoint(input.to, input.id, 'to');
    const from = this.host.getSourceImpl(input.from.sourceId)!.refOf(fromRecord);
    const to = this.host.getSourceImpl(input.to.sourceId)!.refOf(toRecord);
    const stored: StoredRelation = {
      id: input.id,
      type: input.type,
      from,
      to,
      properties: input.properties ?? EMPTY,
      endpointPolicy: input.onEndpointRemoved ?? this.defaultPolicy,
      missing: false,
    };
    this.relations.set(stored.id, stored);
    this.attach(stored);
    this.revision++;
    this.emitter.emit('change', { revision: this.revision });
    const undo = () => {
      this.detach(stored);
      this.relations.delete(stored.id);
      this.revision++;
    };
    this.host.recordUndo(undo);
    return this.snapshot(stored);
  }

  private attach(relation: StoredRelation): void {
    addTo(this.outgoing, nodeKey(relation.from), relation.id);
    addTo(this.incoming, nodeKey(relation.to), relation.id);
  }

  private detach(relation: StoredRelation): void {
    removeFrom(this.outgoing, nodeKey(relation.from), relation.id);
    removeFrom(this.incoming, nodeKey(relation.to), relation.id);
  }

  get(id: string): RelationSnapshot | undefined {
    const relation = this.relations.get(id);
    return relation ? this.snapshot(relation) : undefined;
  }

  list(filter?: { readonly type?: string; readonly feature?: FeatureRef }): RelationSnapshot[] {
    const out: RelationSnapshot[] = [];
    for (const relation of this.relations.values()) {
      if (filter?.type !== undefined && relation.type !== filter.type) continue;
      if (filter?.feature) {
        const key = endpointKey(filter.feature);
        if (endpointKey(relation.from) !== key && endpointKey(relation.to) !== key) continue;
      }
      out.push(this.snapshot(relation));
    }
    return out;
  }

  remove(id: string): RelationSnapshot {
    const relation = this.relations.get(id);
    if (!relation) fail('not-found', `relation not found: ${id}`, { id });
    this.detach(relation);
    this.relations.delete(id);
    this.revision++;
    this.host.recordUndo(() => {
      this.relations.set(relation.id, relation);
      this.attach(relation);
      this.revision++;
    });
    this.emitter.emit('change', { revision: this.revision });
    return this.snapshot(relation);
  }

  private snapshot(relation: StoredRelation): RelationSnapshot {
    return Object.freeze({
      id: relation.id,
      type: relation.type,
      from: relation.from,
      to: relation.to,
      properties: relation.properties,
      endpointPolicy: relation.endpointPolicy,
      missing: relation.missing,
    });
  }

  /**
   * Called before an endpoint record is removed. Throws for the `reject` policy so
   * the removal never reaches the store (REL-07).
   */
  beforeEndpointRemoved(source: SourceImpl, record: SlotRecord): void {
    for (const relation of this.relationsFor(source, record)) {
      if (relation.endpointPolicy === 'reject') {
        fail(
          'dependency-conflict',
          `feature ${String(record.id)} cannot be removed: relation ${relation.id} uses it`,
          { relationId: relation.id, sourceId: source.id, id: record.id },
        );
      }
    }
  }

  /** Called after an endpoint record was removed; applies the stored policy. */
  afterEndpointRemoved(source: SourceImpl, record: SlotRecord): void {
    for (const relation of this.relationsFor(source, record)) {
      if (relation.endpointPolicy === 'remove-relation') {
        this.remove(relation.id);
      } else if (relation.endpointPolicy === 'keep-missing') {
        relation.missing = true;
      }
    }
  }

  private relationsFor(source: SourceImpl, record: SlotRecord): StoredRelation[] {
    const ref = source.refOf(record);
    const key = nodeKey(ref);
    const out: StoredRelation[] = [];
    for (const id of this.outgoing.get(key) ?? []) {
      const relation = this.relations.get(id);
      if (relation) out.push(relation);
    }
    for (const id of this.incoming.get(key) ?? []) {
      const relation = this.relations.get(id);
      if (relation && !out.includes(relation)) out.push(relation);
    }
    return out;
  }

  /** Resolves a stored endpoint; returns undefined when missing or stale. */
  private resolveEndpoint(ref: FeatureRef): FeatureRef | undefined {
    const source = this.host.getSourceImpl(ref.sourceId);
    if (!source) return undefined;
    const record = source.store.get(ref.id, ref.namespace);
    if (!record || record.generation !== ref.generation) return undefined;
    return source.refOf(record);
  }

  endpointIsLive(ref: FeatureRef): boolean {
    return this.resolveEndpoint(ref) !== undefined;
  }

  neighbors(ref: FeatureRef, options: NeighborOptions = {}): FeatureRef[] {
    const direction = options.direction ?? 'both';
    const result: FeatureRef[] = [];
    const seen = new Set<string>();
    if (direction === 'out' || direction === 'both') {
      for (const id of this.outgoing.get(nodeKey(ref)) ?? []) {
        this.scanCount++;
        const relation = this.relations.get(id);
        if (!relation) continue;
        if (options.type !== undefined && relation.type !== options.type) continue;
        const resolved = this.resolveEndpoint(relation.to);
        if (resolved && !seen.has(nodeKey(resolved))) {
          seen.add(nodeKey(resolved));
          result.push(resolved);
        }
      }
    }
    if (direction === 'in' || direction === 'both') {
      for (const id of this.incoming.get(nodeKey(ref)) ?? []) {
        this.scanCount++;
        const relation = this.relations.get(id);
        if (!relation) continue;
        if (options.type !== undefined && relation.type !== options.type) continue;
        const resolved = this.resolveEndpoint(relation.from);
        if (resolved && !seen.has(nodeKey(resolved))) {
          seen.add(nodeKey(resolved));
          result.push(resolved);
        }
      }
    }
    return result;
  }

  /** Breadth-first traversal with depth/limit/abort over cycles (REL-05). */
  traverse(start: FeatureRef, options: TraverseOptions = {}): FeatureRef[] {
    const maxDepth = options.maxDepth ?? 8;
    const limit = options.limit ?? 1000;
    const result: FeatureRef[] = [];
    const visited = new Set<string>([nodeKey(start)]);
    let frontier: FeatureRef[] = [start];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: FeatureRef[] = [];
      for (const ref of frontier) {
        if (options.signal?.aborted) fail('aborted', 'traversal aborted', {});
        for (const neighbor of this.neighbors(ref, options)) {
          const key = nodeKey(neighbor);
          if (visited.has(key)) continue;
          visited.add(key);
          result.push(neighbor);
          if (result.length >= limit) return result;
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return result;
  }

  subscribe(fn: (event: { revision: number }) => void, options?: SubscribeOptions): Unsubscribe {
    return this.emitter.on('change', fn, options);
  }

  /** All live relations touching a feature (used by bindings for cleanup). */
  relationsTouching(ref: FeatureRef): RelationSnapshot[] {
    const key = endpointKey(ref);
    const out: RelationSnapshot[] = [];
    for (const relation of this.relations.values()) {
      if (endpointKey(relation.from) === key || endpointKey(relation.to) === key) {
        out.push(this.snapshot(relation));
      }
    }
    return out;
  }

  /** How many relations reference features of this source (cascade checks). */
  referenceCountForSource(sourceId: string): number {
    let count = 0;
    for (const relation of this.relations.values()) {
      if (relation.from.sourceId === sourceId) count++;
      if (relation.to.sourceId === sourceId) count++;
    }
    return count;
  }

  /** Removes every relation referencing features of the source (cascade). */
  removeForSource(sourceId: string): void {
    for (const relation of Array.from(this.relations.values())) {
      if (relation.from.sourceId === sourceId || relation.to.sourceId === sourceId) {
        this.remove(relation.id);
      }
    }
  }
}

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function removeFrom(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key);
  if (set) {
    set.delete(id);
    if (set.size === 0) map.delete(key);
  }
}
