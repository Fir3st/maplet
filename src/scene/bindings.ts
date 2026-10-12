/**
 * Computational bindings: derived geometry and properties computed from upstream
 * features.
 *
 * - the dependency graph must be acyclic (BIND-03); rank ordering evaluates chains
 *   upstream-first (BIND-02, BIND-08);
 * - a binding owns its target field: manual updates to that geometry/field are
 *   rejected unless the binding is removed first (BIND-04, BIND-05, BIND-10);
 * - missing inputs follow the declared policy: `reject` rolls the whole commit
 *   back, `retain` keeps the last good result, `hide` hides the target in render
 *   and picking (BIND-06, BIND-07);
 * - evaluation runs synchronously inside the transaction that changed an upstream
 *   feature, so one revision never mixes a new point with an old dependent line
 *   (BIND-01, TX-06).
 *
 * Label *rendering* is a later stage; the `copyProperty` binding derives the value
 * a label layer would display.
 */

import { fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import type { FeatureRef, SubscribeOptions, Unsubscribe } from '../api/types.ts';
import type { Crs } from '../math/crs.ts';
import { prepareGeometry } from '../geometry/geometry.ts';
import type { SourceImpl } from './source.ts';
import type { SlotRecord } from './store.ts';

export interface LineBetweenDescriptor {
  readonly kind: 'lineBetween';
  readonly from: FeatureRef;
  readonly to: FeatureRef;
}

export interface AnchorOnLineDescriptor {
  readonly kind: 'anchorOnLine';
  readonly line: FeatureRef;
  /** 0..1 along the accumulated world-space length of the line. */
  readonly fraction: number;
}

export type GeometryBindingDescriptor = LineBetweenDescriptor | AnchorOnLineDescriptor;

export interface CopyPropertyDescriptor {
  readonly kind: 'copyProperty';
  readonly from: FeatureRef;
  readonly field: string;
  /** Target property key; defaults to the source field name. */
  readonly toField?: string;
}

export type OnMissingPolicy = 'reject' | 'retain' | 'hide';

export interface BindingInput {
  readonly id: string;
  readonly target: FeatureRef;
  readonly geometry?: GeometryBindingDescriptor;
  readonly properties?: CopyPropertyDescriptor;
  readonly onMissing?: OnMissingPolicy;
}

export interface BindingSnapshot {
  readonly id: string;
  readonly target: FeatureRef;
  readonly geometry: GeometryBindingDescriptor | null;
  readonly properties: CopyPropertyDescriptor | null;
  readonly onMissing: OnMissingPolicy;
}

interface StoredBinding {
  id: string;
  target: FeatureRef;
  geometry: GeometryBindingDescriptor | null;
  properties: CopyPropertyDescriptor | null;
  onMissing: OnMissingPolicy;
  lastValid: boolean;
}

interface BindingHost {
  getSourceImpl(sourceId: string): SourceImpl | undefined;
  recordUndo(undo: () => void): void;
  publishStateChange(): void;
  readonly crs: Crs;
}

export class BindingStore {
  private readonly bindings = new Map<string, StoredBinding>();
  private readonly depIndex = new Map<string, Set<string>>();
  private readonly rank = new Map<string, number>();
  private readonly hidden = new Set<string>();
  private readonly emitter = new Emitter<{ change: { revision: number } }>();
  private revision = 0;
  private evaluating = false;
  /** Diagnostics: number of binding evaluations since load. */
  evaluatedCount = 0;
  private readonly host: BindingHost;

  constructor(host: BindingHost) {
    this.host = host;
  }

  get size(): number {
    return this.bindings.size;
  }

  list(): BindingSnapshot[] {
    return Array.from(this.bindings.values(), (binding) => this.snapshot(binding));
  }

  get(id: string): BindingSnapshot | undefined {
    const binding = this.bindings.get(id);
    return binding ? this.snapshot(binding) : undefined;
  }

  private snapshot(binding: StoredBinding): BindingSnapshot {
    return Object.freeze({
      id: binding.id,
      target: binding.target,
      geometry: binding.geometry,
      properties: binding.properties,
      onMissing: binding.onMissing,
    });
  }

  /* ---------------------------- dependency graph --------------------------- */

  private inputRefs(binding: StoredBinding): FeatureRef[] {
    const refs: FeatureRef[] = [];
    if (binding.geometry) {
      if (binding.geometry.kind === 'lineBetween') {
        refs.push(binding.geometry.from, binding.geometry.to);
      } else {
        refs.push(binding.geometry.line);
      }
    }
    if (binding.properties) refs.push(binding.properties.from);
    return refs;
  }

  private refNodeKey(ref: FeatureRef): string {
    return `${ref.sourceId}\u0000${ref.namespace ?? ''}\u0000${typeof ref.id}:${ref.id}\u0000${ref.generation}`;
  }

  private targetNodeKey(binding: StoredBinding): string {
    return this.refNodeKey(binding.target);
  }

  /**
   * Adding edges input -> target must not create a cycle: reject when the target
   * can already reach any of the new inputs (BIND-03).
   */
  /**
   * Forward reachability over existing edges (input -> target). Adding an edge
   * input -> target creates a cycle iff the target can already reach the input.
   */
  private reaches(from: FeatureRef, to: FeatureRef): boolean {
    const goal = this.refNodeKey(to);
    const seen = new Set<string>();
    const stack = [this.refNodeKey(from)];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (key === goal) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const bindingId of this.depIndex.get(key) ?? []) {
        const binding = this.bindings.get(bindingId);
        if (binding) stack.push(this.targetNodeKey(binding));
      }
    }
    return false;
  }

  private recomputeRanks(): void {
    this.rank.clear();
    const keys = new Set<string>();
    for (const binding of this.bindings.values()) {
      keys.add(this.targetNodeKey(binding));
      for (const input of this.inputRefs(binding)) keys.add(this.refNodeKey(input));
    }
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const key of keys) inDegree.set(key, 0);
    for (const binding of this.bindings.values()) {
      const targetKey = this.targetNodeKey(binding);
      for (const input of this.inputRefs(binding)) {
        const inputKey = this.refNodeKey(input);
        const list = adjacency.get(inputKey) ?? [];
        list.push(targetKey);
        adjacency.set(inputKey, list);
        inDegree.set(targetKey, (inDegree.get(targetKey) ?? 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const [key, degree] of inDegree) {
      if (degree === 0) {
        this.rank.set(key, 0);
        queue.push(key);
      }
    }
    while (queue.length > 0) {
      const key = queue.shift()!;
      const currentRank = this.rank.get(key) ?? 0;
      for (const next of adjacency.get(key) ?? []) {
        this.rank.set(next, Math.max(this.rank.get(next) ?? 0, currentRank + 1));
        const degree = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, degree);
        if (degree === 0) queue.push(next);
      }
    }
    if (this.rank.size !== keys.size) {
      fail('cycle', 'binding dependency graph contains a cycle', {});
    }
  }

  /* ------------------------------- ownership ------------------------------- */

  private ownedFields(targetNodeKey: string): { geometry: string | null; fields: Map<string, string> } {
    let record = this.ownership.get(targetNodeKey);
    if (!record) {
      record = { geometry: null, fields: new Map() };
      this.ownership.set(targetNodeKey, record);
    }
    return record;
  }

  private readonly ownership = new Map<
    string,
    { geometry: string | null; fields: Map<string, string> }
  >();

  private checkOwnershipConflict(binding: StoredBinding): void {
    const owner = this.ownership.get(this.targetNodeKey(binding));
    if (!owner) return;
    if (binding.geometry && owner.geometry) {
      fail('ownership-conflict', `target geometry is already bound by ${owner.geometry}`, {
        bindingId: binding.id,
        owner: owner.geometry,
      });
    }
    if (binding.properties) {
      const field = binding.properties.toField ?? binding.properties.field;
      const existing = owner.fields.get(field);
      if (existing) {
        fail('ownership-conflict', `target property '${field}' is already bound by ${existing}`, {
          bindingId: binding.id,
          owner: existing,
          field,
        });
      }
    }
  }

  private claim(binding: StoredBinding): void {
    const owner = this.ownedFields(this.targetNodeKey(binding));
    if (binding.geometry) owner.geometry = binding.id;
    if (binding.properties) {
      owner.fields.set(binding.properties.toField ?? binding.properties.field, binding.id);
    }
  }

  private release(binding: StoredBinding): void {
    const owner = this.ownership.get(this.targetNodeKey(binding));
    if (!owner) return;
    if (owner.geometry === binding.id) owner.geometry = null;
    if (binding.properties) {
      const field = binding.properties.toField ?? binding.properties.field;
      if (owner.fields.get(field) === binding.id) owner.fields.delete(field);
    }
  }

  /* --------------------------------- CRUD ---------------------------------- */

  add(input: BindingInput): BindingSnapshot {
    if (this.bindings.has(input.id)) {
      fail('duplicate-id', `binding id already exists: ${input.id}`, { id: input.id });
    }
    if (!input.geometry && !input.properties) {
      fail('invalid-argument', `binding ${input.id} needs a geometry or properties descriptor`);
    }
    const targetSource = this.host.getSourceImpl(input.target.sourceId);
    if (!targetSource) {
      fail('missing-endpoint', `binding ${input.id}: target source does not exist`, {
        sourceId: input.target.sourceId,
      });
    }
    const targetRecord = targetSource.resolveRef(input.target, `binding ${input.id} (target)`);
    const target = targetSource.refOf(targetRecord);
    const stored: StoredBinding = {
      id: input.id,
      target,
      geometry: input.geometry ?? null,
      properties: input.properties ?? null,
      onMissing: input.onMissing ?? 'reject',
      lastValid: false,
    };
    // Validate inputs exist and no cycle appears.
    for (const ref of this.inputRefs(stored)) {
      const source = this.host.getSourceImpl(ref.sourceId);
      if (!source) {
        fail('missing-endpoint', `binding ${input.id}: input source does not exist`, {
          sourceId: ref.sourceId,
        });
      }
      source.resolveRef(ref, `binding ${input.id} (input)`);
      if (this.reaches(target, ref)) {
        fail('cycle', `binding ${input.id} would create a dependency cycle`, {});
      }
    }
    this.checkOwnershipConflict(stored);
    this.bindings.set(stored.id, stored);
    this.claim(stored);
    for (const ref of this.inputRefs(stored)) {
      addTo(this.depIndex, this.refNodeKey(ref), stored.id);
    }
    this.recomputeRanks();
    this.revision++;
    this.host.recordUndo(() => {
      this.removeInternal(stored.id);
    });
    // Evaluate right away so the target starts from the derived state.
    this.evaluating = true;
    try {
      this.evaluatedCount++;
      this.evaluate(stored);
    } finally {
      this.evaluating = false;
    }
    return this.snapshot(stored);
  }

  update(id: string, input: Omit<BindingInput, 'id'>): BindingSnapshot {
    const existing = this.bindings.get(id);
    if (!existing) fail('not-found', `binding not found: ${id}`, { id });
    const previous: StoredBinding = { ...existing };
    this.removeInternal(id, { keepUndoEntry: true });
    try {
      const snapshot = this.add({ id, ...input });
      return snapshot;
    } catch (error) {
      // Restore the previous binding; `add` may have left partial state.
      if (!this.bindings.has(id)) {
        this.bindings.set(id, previous);
        this.claim(previous);
        for (const ref of this.inputRefs(previous)) {
          addTo(this.depIndex, this.refNodeKey(ref), id);
        }
        this.recomputeRanks();
      }
      throw error;
    }
  }

  private removeInternal(id: string, options: { keepUndoEntry?: boolean } = {}): void {
    const binding = this.bindings.get(id);
    if (!binding) return;
    this.bindings.delete(id);
    this.release(binding);
    for (const ref of this.inputRefs(binding)) {
      removeFrom(this.depIndex, this.refNodeKey(ref), id);
    }
    this.hidden.delete(this.targetNodeKey(binding));
    this.recomputeRanks();
    this.revision++;
    if (!options.keepUndoEntry) {
      this.host.recordUndo(() => {
        this.bindings.set(id, binding);
        this.claim(binding);
        for (const ref of this.inputRefs(binding)) {
          addTo(this.depIndex, this.refNodeKey(ref), id);
        }
        this.recomputeRanks();
      });
    }
  }

  remove(id: string): void {
    if (!this.bindings.has(id)) fail('not-found', `binding not found: ${id}`, { id });
    this.removeInternal(id);
    this.emitter.emit('change', { revision: this.revision });
  }

  /* ------------------------------- evaluation ------------------------------ */

  isTargetHidden(ref: FeatureRef): boolean {
    if (this.hidden.size === 0) return false;
    return this.hidden.has(this.refNodeKey(ref));
  }

  /** Post-commit effect: bindings were evaluated synchronously before publish. */
  private resolveTargetSlot(ref: FeatureRef): { source: SourceImpl; record: SlotRecord } | null {
    const source = this.host.getSourceImpl(ref.sourceId);
    if (!source) return null;
    const record = source.store.get(ref.id, ref.namespace);
    if (!record || record.generation !== ref.generation) return null;
    return { source, record };
  }

  private anchorOf(ref: FeatureRef): { x: number; y: number } {
    const resolved = this.resolveTargetSlot(ref);
    if (!resolved) fail('missing-endpoint', 'binding input no longer exists', { id: ref.id });
    return { x: resolved.record.wx, y: resolved.record.wy };
  }

  private linePoints(ref: FeatureRef): Float64Array {
    const resolved = this.resolveTargetSlot(ref);
    if (!resolved) fail('missing-endpoint', 'binding input no longer exists', { id: ref.id });
    const geometry = resolved.record.geometry;
    if (!geometry) {
      fail('invalid-argument', 'anchorOnLine expects a line-like input geometry', {
        id: ref.id,
        kind: resolved.record.kind,
      });
    }
    const payload = geometry.payload;
    if (payload.kind === 1 || payload.kind === 2 || payload.kind === 3) {
      // multiPoint is not line-like
      if (payload.kind === 1) {
        fail('invalid-argument', 'anchorOnLine expects a line-like input geometry', { id: ref.id });
      }
      return payload.vertices;
    }
    fail('invalid-argument', 'anchorOnLine expects a line-like input geometry', {
      id: ref.id,
      kind: payload.kind,
    });
  }

  /** Evaluates one binding. May write to the target source (same transaction). */
  private evaluate(binding: StoredBinding): void {
    const resolvedTarget = this.resolveTargetSlot(binding.target);
    if (!resolvedTarget) {
      fail('stale-reference', `binding ${binding.id}: target no longer exists`, {
        bindingId: binding.id,
      });
    }
    const { source: targetSource, record: targetRecord } = resolvedTarget;
    const missing = this.firstMissingInput(binding);
    if (missing) {
      if (binding.onMissing === 'reject') {
        fail('missing-endpoint', `binding ${binding.id}: input is missing`, {
          bindingId: binding.id,
          input: missing,
        });
      }
      if (binding.onMissing === 'hide') {
        this.hidden.add(this.targetNodeKey(binding));
        this.host.publishStateChange();
      }
      // retain: keep the last valid result
      return;
    }
    this.hidden.delete(this.targetNodeKey(binding));
    if (binding.geometry) {
      const positions = this.computeGeometry(binding);
      const crs = this.host.crs;
      const geometry =
        binding.geometry.kind === 'lineBetween'
          ? {
              type: 'lineString',
              positions: [crs.fromWorld(positions[0]!), crs.fromWorld(positions[1]!)],
            }
          : { type: 'point', position: crs.fromWorld(positions[0]!) };
      const prepared = prepareGeometry(crs, geometry, `binding ${binding.id}`);
      targetSource.replaceGeometryInternal(targetRecord.slot, prepared);
    }
    if (binding.properties) {
      const input = this.resolveTargetSlot(binding.properties.from);
      if (!input) {
        fail('missing-endpoint', `binding ${binding.id}: input is missing`, {
          bindingId: binding.id,
        });
      }
      const toField = binding.properties.toField ?? binding.properties.field;
      targetSource.mergePropertiesInternal(targetRecord.slot, {
        [toField]: input.record.properties[binding.properties.field],
      });
    }
    binding.lastValid = true;
  }

  private computeGeometry(binding: StoredBinding): { x: number; y: number }[] {
    const descriptor = binding.geometry!;
    if (descriptor.kind === 'lineBetween') {
      return [this.anchorOf(descriptor.from), this.anchorOf(descriptor.to)];
    }
    const vertices = this.linePoints(descriptor.line);
    const fraction = Math.max(0, Math.min(1, descriptor.fraction));
    let total = 0;
    for (let i = 2; i < vertices.length; i += 2) {
      total += Math.hypot(vertices[i]! - vertices[i - 2]!, vertices[i + 1]! - vertices[i - 1]!);
    }
    const target = total * fraction;
    let walked = 0;
    for (let i = 2; i < vertices.length; i += 2) {
      const segment = Math.hypot(vertices[i]! - vertices[i - 2]!, vertices[i + 1]! - vertices[i - 1]!);
      if (walked + segment >= target || i === vertices.length - 2) {
        const t = segment === 0 ? 0 : (target - walked) / segment;
        return [
          {
            x: vertices[i - 2]! + (vertices[i]! - vertices[i - 2]!) * t,
            y: vertices[i - 1]! + (vertices[i + 1]! - vertices[i - 1]!) * t,
          },
        ];
      }
      walked += segment;
    }
    return [{ x: vertices[0]!, y: vertices[1]! }];
  }

  private firstMissingInput(binding: StoredBinding): FeatureRef | null {
    for (const ref of this.inputRefs(binding)) {
      const resolved = this.resolveTargetSlot(ref);
      if (!resolved) return ref;
    }
    return null;
  }

  /**
   * Applies bindings after source changes inside the current transaction.
   * `touched` are the feature refs whose data changed in this commit; when
   * `overflow` is set (very large changes) every binding is evaluated.
   */
  applyChanges(touched: readonly FeatureRef[], overflow = false): void {
    if (this.bindings.size === 0) return;
    if (!overflow && touched.length === 0) return;
    // Collect affected bindings transitively (a computed target can feed another).
    const affected = new Set<string>();
    const queue: string[] = [];
    if (overflow) {
      for (const id of this.bindings.keys()) queue.push(id);
    } else {
      for (const ref of touched) {
        const direct = this.depIndex.get(this.refNodeKey(ref));
        for (const id of direct ?? []) queue.push(id);
      }
    }
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (affected.has(id)) continue;
      const binding = this.bindings.get(id);
      if (!binding) continue;
      affected.add(id);
      const targetDeps = this.depIndex.get(this.targetNodeKey(binding));
      for (const dependent of targetDeps ?? []) queue.push(dependent);
    }
    if (affected.size === 0) return;
    const ordered = Array.from(affected).sort((a, b) => {
      const bindingA = this.bindings.get(a)!;
      const bindingB = this.bindings.get(b)!;
      return (this.rank.get(this.targetNodeKey(bindingA)) ?? 0) - (this.rank.get(this.targetNodeKey(bindingB)) ?? 0);
    });
    this.evaluating = true;
    try {
      for (const id of ordered) {
        const binding = this.bindings.get(id);
        if (binding) {
          this.evaluatedCount++;
          this.evaluate(binding);
        }
      }
    } finally {
      this.evaluating = false;
    }
  }

  /* ------------------------------ update guards ---------------------------- */

  /**
   * Called from public source update paths. Returns an error message when the
   * update touches a binding-owned field (BIND-04, BIND-10).
   */
  checkGeometryOwnership(ref: FeatureRef): void {
    if (this.evaluating) return;
    const owner = this.ownership.get(this.refNodeKey(ref));
    if (owner?.geometry) {
      fail('ownership-conflict', `geometry is computed by binding ${owner.geometry}`, {
        bindingId: owner.geometry,
        id: ref.id,
      });
    }
  }

  checkPropertyOwnership(ref: FeatureRef, keys: readonly string[]): void {
    if (this.evaluating) return;
    const owner = this.ownership.get(this.refNodeKey(ref));
    if (!owner) return;
    for (const key of keys) {
      const bindingId = owner.fields.get(key);
      if (bindingId) {
        fail('ownership-conflict', `property '${key}' is computed by binding ${bindingId}`, {
          bindingId,
          id: ref.id,
          field: key,
        });
      }
    }
  }

  /** Pre-removal guard: reject-policy bindings protect their input features. */
  beforeFeatureRemoved(ref: FeatureRef): void {
    const key = this.refNodeKey(ref);
    for (const binding of this.bindings.values()) {
      if (binding.onMissing !== 'reject') continue;
      for (const input of this.inputRefs(binding)) {
        if (this.refNodeKey(input) === key) {
          fail(
            'dependency-conflict',
            `feature ${String(ref.id)} is an input of binding ${binding.id}`,
            { bindingId: binding.id, id: ref.id },
          );
        }
      }
    }
  }

  /** Post-removal cleanup: a removed target feature drops its bindings. */
  afterFeatureRemoved(ref: FeatureRef): void {
    for (const binding of Array.from(this.bindings.values())) {
      if (this.refNodeKey(binding.target) === this.refNodeKey(ref)) {
        this.removeInternal(binding.id);
      }
    }
  }

  subscribe(fn: (event: { revision: number }) => void, options?: SubscribeOptions): Unsubscribe {
    return this.emitter.on('change', fn, options);
  }

  /** How many bindings reference features of this source (cascade checks). */
  referenceCountForSource(sourceId: string): number {
    let count = 0;
    for (const binding of this.bindings.values()) {
      if (binding.target.sourceId === sourceId) count++;
      for (const input of this.inputRefs(binding)) {
        if (input.sourceId === sourceId) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  /** Removes every binding referencing features of the source (cascade). */
  removeForSource(sourceId: string): void {
    for (const binding of Array.from(this.bindings.values())) {
      if (
        binding.target.sourceId === sourceId ||
        this.inputRefs(binding).some((input) => input.sourceId === sourceId)
      ) {
        this.removeInternal(binding.id);
      }
    }
  }
}

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
