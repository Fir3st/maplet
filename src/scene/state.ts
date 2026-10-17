/**
 * Feature state and selection.
 *
 * State (hover/selected/disabled + custom values) is data about a feature, kept
 * separately from its properties (STYLE-06) and stored sparsely. `selected` is the
 * same set as the selection API sees, so both views stay consistent.
 * SELECT-01..SELECT-06, REF-06.
 */

import { assertArgument, fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import type { FeatureRef, SubscribeOptions, Unsubscribe } from '../api/types.ts';
import { featureIdKey } from '../api/types.ts';
import type { SourceImpl } from './source.ts';
import type { SlotRecord } from './store.ts';

export interface FeatureState {
  readonly hovered: boolean;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly custom: Readonly<Record<string, unknown>>;
}

export interface FeatureStatePatch {
  readonly hovered?: boolean;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  /** Per-key custom state patch; a key set to undefined is removed. */
  readonly custom?: Readonly<Record<string, unknown>>;
}

export interface StateStoreHost {
  readonly sceneId: string;
  getSourceImpl(sourceId: string): SourceImpl | undefined;
  publishStateChange(ref: FeatureRef): void;
}

interface StateEntry {
  hovered: boolean;
  disabled: boolean;
  custom: Record<string, unknown>;
}

export class StateStore {
  private readonly entries = new Map<string, StateEntry>();
  private readonly emitter = new Emitter<{ change: StateChangeEvent }>();
  private readonly selection: SelectionStore;
  private readonly host: StateStoreHost;

  constructor(host: StateStoreHost, selection: SelectionStore) {
    this.host = host;
    this.selection = selection;
  }

  private resolve(ref: FeatureRef, operation: string): { source: SourceImpl; record: SlotRecord } {
    const source = this.host.getSourceImpl(ref.sourceId);
    if (!source) {
      fail('stale-reference', `${operation}: source no longer exists`, {
        sourceId: ref.sourceId,
      });
    }
    const record = source.resolveRef(ref, operation);
    return { source, record };
  }

  get(ref: FeatureRef): FeatureState {
    const { source, record } = this.resolve(ref, 'state.get');
    return this.stateOf(source, record);
  }

  stateOf(source: SourceImpl, record: SlotRecord): FeatureState {
    const selected = this.selection.hasRef(source, record);
    if (this.entries.size === 0 && !selected) return EMPTY_STATE;
    const key = `${source.id}\u0000${record.key}`;
    const entry = this.entries.get(key);
    return {
      hovered: entry?.hovered ?? false,
      selected,
      disabled: entry?.disabled ?? false,
      custom: entry?.custom ?? EMPTY_CUSTOM,
    };
  }

  set(ref: FeatureRef, patch: FeatureStatePatch): void {
    const { source, record } = this.resolve(ref, 'state.set');
    const key = `${source.id}\u0000${record.key}`;
    let selectionChanged = false;
    if (patch.selected !== undefined) {
      if (patch.selected) {
        selectionChanged = this.selection.addInternal(source, record);
      } else {
        selectionChanged = this.selection.removeInternal(source, record);
      }
    }
    if (selectionChanged) this.selection.notifyExternalChange();
    if (patch.hovered !== undefined || patch.disabled !== undefined || patch.custom !== undefined) {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = { hovered: false, disabled: false, custom: {} };
        this.entries.set(key, entry);
      }
      if (patch.hovered !== undefined) entry.hovered = patch.hovered;
      if (patch.disabled !== undefined) entry.disabled = patch.disabled;
      if (patch.custom !== undefined) {
        for (const customKey of Object.keys(patch.custom)) {
          const value = patch.custom[customKey];
          if (value === undefined) delete entry.custom[customKey];
          else entry.custom[customKey] = value;
        }
      }
      if (!entry.hovered && !entry.disabled && Object.keys(entry.custom).length === 0) {
        this.entries.delete(key);
      }
    }
    this.emitter.emit('change', {
      sourceId: source.id,
      id: record.id,
      state: this.stateOf(source, record),
    });
    this.host.publishStateChange(ref);
  }

  /** Drops all state of a removed feature. */
  forget(sourceId: string, record: SlotRecord): void {
    this.entries.delete(`${sourceId}\u0000${record.key}`);
    this.selection.forget(sourceId, record);
  }

  subscribe(fn: (event: StateChangeEvent) => void, options?: SubscribeOptions): Unsubscribe {
    return this.emitter.on('change', fn, options);
  }
}

export interface StateChangeEvent {
  readonly sourceId: string;
  readonly id: FeatureRef['id'];
  readonly state: FeatureState;
}

export interface SelectionChangeEvent {
  readonly revision: number;
  readonly selected: readonly FeatureRef[];
}

export class SelectionStore {
  private readonly items = new Map<string, FeatureRef>();
  private readonly emitter = new Emitter<{ change: SelectionChangeEvent }>();
  private revision = 0;
  private publish: ((refs: readonly FeatureRef[]) => void) | null = null;
  private readonly changed = new Set<FeatureRef>();

  setPublisher(publish: (refs: readonly FeatureRef[]) => void): void {
    this.publish = publish;
  }

  /** Drops invalid entries; validates scene/source/generation on read. */
  get(): readonly FeatureRef[] {
    this.prune();
    return Array.from(this.items.values());
  }

  get size(): number {
    this.prune();
    return this.items.size;
  }

  private prune(): void {
    for (const [key, ref] of this.items) {
      if (!this.isLive(ref)) this.items.delete(key);
    }
  }

  private isLive(ref: FeatureRef): boolean {
    const source = this.sourceLookup?.(ref.sourceId);
    if (!source) return false;
    const record = source.store.get(ref.id, ref.namespace);
    return record !== undefined && record.generation === ref.generation;
  }

  sourceLookup: ((sourceId: string) => SourceImpl | undefined) | null = null;

  hasRef(source: SourceImpl, record: SlotRecord): boolean {
    if (this.items.size === 0) return false;
    return this.items.has(`${source.id}\u0000${record.key}`);
  }

  add(refs: readonly FeatureRef[]): void {
    let changed = false;
    for (const ref of refs) {
      const source = this.sourceLookup?.(ref.sourceId);
      if (!source) {
        fail('stale-reference', 'selection.add: source does not exist', { sourceId: ref.sourceId });
      }
      const record = source.resolveRef(ref, 'selection.add');
      if (this.addInternal(source, record)) changed = true;
    }
    if (changed) this.emitChange();
  }

  /** Adds by value identity; returns whether anything changed. */
  addInternal(source: SourceImpl, record: SlotRecord): boolean {
    const key = `${source.id}\u0000${record.key}`;
    if (this.items.has(key)) return false;
    const ref = source.refOf(record);
    this.items.set(key, ref);
    this.changed.add(ref);
    return true;
  }

  /** Removes by value identity; returns whether anything changed. */
  removeInternal(source: SourceImpl, record: SlotRecord): boolean {
    const key = `${source.id}\u0000${record.key}`;
    const ref = this.items.get(key);
    if (!ref) return false;
    this.changed.add(ref);
    return this.items.delete(key);
  }

  /** Emits a change for a mutation performed through the state store. */
  notifyExternalChange(): void {
    this.emitChange();
  }

  set(refs: readonly FeatureRef[]): void {
    const hadItems = this.items.size > 0;
    this.clearInternal();
    let changed = false;
    for (const ref of refs) {
      const source = this.sourceLookup?.(ref.sourceId);
      if (!source) {
        fail('stale-reference', 'selection.set: source does not exist', { sourceId: ref.sourceId });
      }
      const record = source.resolveRef(ref, 'selection.set');
      if (this.addInternal(source, record)) changed = true;
    }
    if (changed || hadItems) this.emitChange();
  }

  remove(refs: readonly FeatureRef[]): void {
    let changed = false;
    for (const ref of refs) {
      const key = `${ref.sourceId}\u0000${featureIdKey(ref.id, ref.namespace)}`;
      const item = this.items.get(key);
      if (!item) continue;
      this.changed.add(item);
      this.items.delete(key);
      changed = true;
    }
    if (changed) this.emitChange();
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.clearInternal();
    this.emitChange();
  }

  private clearInternal(): void {
    for (const ref of this.items.values()) this.changed.add(ref);
    this.items.clear();
  }

  /** SELECT-04: removing a selected feature invalidates the selection entry. */
  forget(sourceId: string, record: SlotRecord): void {
    const key = `${sourceId}\u0000${record.key}`;
    const ref = this.items.get(key);
    if (ref) {
      this.changed.add(ref);
      this.items.delete(key);
      this.emitChange();
    }
  }

  private emitChange(): void {
    this.revision++;
    const changed = Array.from(this.changed);
    this.changed.clear();
    this.publish?.(changed);
    this.emitter.emit('change', { revision: this.revision, selected: this.get() });
  }

  subscribe(fn: (event: SelectionChangeEvent) => void, options?: SubscribeOptions): Unsubscribe {
    return this.emitter.on('change', fn, options);
  }
}

const EMPTY_CUSTOM: Readonly<Record<string, unknown>> = Object.freeze({});
const EMPTY_STATE: FeatureState = Object.freeze({
  hovered: false,
  selected: false,
  disabled: false,
  custom: EMPTY_CUSTOM,
});

export function assertSelectionInput(refs: unknown): asserts refs is readonly FeatureRef[] {
  assertArgument(Array.isArray(refs), 'selection expects an array of feature references', { refs });
}
