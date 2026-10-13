/** Resident geometry with generation-bound picks and per-feature upload ranges. */
import type { FeatureId } from '../api/types.ts';
import type { LayerImpl } from '../scene/layers.ts';
import type { SourceImpl } from '../scene/source.ts';
import type { Scene } from '../scene/scene.ts';
import type { SlotRecord } from '../scene/store.ts';
import { evaluateStyleValue } from '../scene/expression.ts';
import { transformOrigin, worldScaleAt, type ViewTransform } from '../math/transform.ts';
import { FLAG_HIDDEN, FILL_STRIDE, LINE_STRIDE, POINT_STRIDE, PlanPickTable, type PlanBatch, type BufferUpload } from './frame-plan.ts';

export interface ResidentRect { minX: number; minY: number; maxX: number; maxY: number }
export type VectorCompiler = (rect: ResidentRect, origin: { x: number; y: number }, scale: number,
  picks: PlanPickTable, records?: readonly SlotRecord[]) => readonly PlanBatch[];

interface FeatureRanges {
  readonly slot: number;
  readonly picks: number[];
  readonly ranges: { batch: number; start: number; end: number }[];
  readonly z: number;
  readonly geometry: SlotRecord['geometry'];
}

function stride(batch: PlanBatch): number { return batch.kind === 'fills' ? FILL_STRIDE : batch.kind === 'lines' ? LINE_STRIDE : POINT_STRIDE; }
function pickOffset(batch: PlanBatch): number { return batch.kind === 'fills' ? 8 : batch.kind === 'lines' ? 6 : 14; }

export class VectorCache {
  readonly source: SourceImpl;
  readonly entries;
  private readonly scene: Scene;
  private readonly layer: LayerImpl;
  private readonly compile: VectorCompiler;
  private readonly origin;
  private readonly rect: ResidentRect;
  private readonly scale: number;
  private readonly zoom: number;
  private readonly layoutRevision: number;
  private readonly renderEpoch: number;
  private sourceEpoch: number;
  private overrideEpoch: number;
  private readonly batches: readonly PlanBatch[];
  private readonly features = new Map<number, FeatureRanges>();
  private readonly uploads: BufferUpload[];
  private readonly visibleCounts: number[];
  private readonly weights: (Uint32Array | null)[];

  constructor(scene: Scene, layer: LayerImpl, source: SourceImpl, view: ViewTransform, compile: VectorCompiler) {
    this.scene = scene; this.layer = layer; this.source = source; this.compile = compile;
    this.origin = transformOrigin(view); this.scale = worldScaleAt(view.zoom); this.zoom = view.zoom;
    this.layoutRevision = layer.layoutRevision; this.renderEpoch = scene.renderEpoch;
    this.sourceEpoch = source.store.changes.epoch; this.overrideEpoch = layer.overrideChanges.epoch;
    this.rect = { minX: this.origin.x - 32 / this.scale, minY: this.origin.y - 32 / this.scale,
      maxX: this.origin.x + (view.width + 32) / this.scale, maxY: this.origin.y + (view.height + 32) / this.scale };
    const picks = new PlanPickTable();
    this.batches = compile(this.rect, this.origin, this.scale, picks);
    this.entries = Array.from({ length: picks.length }, (_, i) => picks.get(i)!);
    this.uploads = this.batches.map(() => ({ version: 0, previousVersion: -1, ranges: [] }));
    this.weights = this.batches.map((batch) => {
      if (!batch.indices) return null;
      const weights = new Uint32Array(batch.data.length / FILL_STRIDE);
      for (const index of batch.indices) weights[index]!++;
      return weights;
    });
    this.visibleCounts = this.batches.map((batch, i) => {
      let visible = 0;
      for (let row = 0; row < batch.data.length / stride(batch); row++) {
        if (batch.data[row * stride(batch) + pickOffset(batch) + 1]! < FLAG_HIDDEN) visible += this.weights[i]?.[row] ?? 1;
      }
      return batch.kind === 'fills' ? visible / 3 : visible;
    });
    const byPick: FeatureRanges[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const ref = this.entries[i]!.feature;
      const record = source.store.get(ref.id, ref.namespace)!;
      let feature = this.features.get(record.slot);
      if (!feature) {
        feature = { slot: record.slot, picks: [], ranges: [], z: this.z(record), geometry: record.geometry };
        this.features.set(record.slot, feature);
      }
      feature.picks.push(i); byPick[i] = feature;
    }
    this.batches.forEach((batch, index) => {
      const step = stride(batch), pick = pickOffset(batch);
      for (let start = 0; start < batch.data.length; start += step) {
        const feature = byPick[batch.data[start + pick]!]!;
        const last = feature.ranges[feature.ranges.length - 1];
        if (last && last.batch === index && last.end === start) last.end += step;
        else feature.ranges.push({ batch: index, start, end: start + step });
      }
    });
  }

  private z(record: SlotRecord): number {
    const style = this.layer.style as { zIndex?: import('../scene/expression.ts').ExpressionInput<number> };
    return evaluateStyleValue(style.zIndex, 0, { properties: record.properties,
      state: this.scene.state.stateOf(this.source, record), zoom: this.zoom }) +
      (this.layer.overrides.get(this.layer.overrideKey(this.source.refOf(record)))?.zIndex ?? 0);
  }

  update(view: ViewTransform): boolean {
    if (view.zoom !== this.zoom || this.layoutRevision !== this.layer.layoutRevision || this.renderEpoch !== this.scene.renderEpoch) return false;
    const origin = transformOrigin(view);
    if (origin.x < this.rect.minX || origin.y < this.rect.minY ||
      origin.x + view.width / this.scale > this.rect.maxX || origin.y + view.height / this.scale > this.rect.maxY) return false;
    const changes = this.source.store.changes.since(this.sourceEpoch);
    const overrides = this.layer.overrideChanges.since(this.overrideEpoch);
    if (!changes || !overrides) return false;
    const slots = new Set(changes);
    for (const target of overrides) {
      const ref = typeof target === 'object' ? target : { id: target as FeatureId, namespace: undefined };
      const record = this.source.store.get(ref.id, ref.namespace);
      if (record) slots.add(record.slot);
    }
    // Validate all patches before changing any resident data.
    const patches: { feature: FeatureRanges; data: readonly PlanBatch[] | null }[] = [];
    for (const slot of slots) {
      const record = this.source.store.getBySlot(slot), feature = this.features.get(slot);
      if (!feature) {
        if (record) return false;
        continue;
      }
      const ref = this.entries[feature.picks[0]!]!.feature;
      if (record && (record.id !== ref.id || record.namespace !== ref.namespace || record.generation !== ref.generation || this.z(record) !== feature.z)) return false;
      if (record && record.geometry !== feature.geometry && feature.ranges.some((range) => this.batches[range.batch]!.indices !== undefined)) return false;
      const picks = new PlanPickTable();
      const compiled = record ? this.compile(this.rect, this.origin, this.scale, picks, [record]) : [];
      if (compiled.length === 0) { patches.push({ feature, data: null }); continue; }
      if (picks.length !== feature.picks.length) return false;
      for (const batch of compiled) {
        const ranges = feature.ranges.filter((range) => this.batches[range.batch]!.kind === batch.kind);
        if (ranges.reduce((count, range) => count + range.end - range.start, 0) !== batch.data.length) return false;
        const step = stride(batch), pick = pickOffset(batch);
        for (let i = pick; i < batch.data.length; i += step) batch.data[i] = feature.picks[batch.data[i]!]!;
      }
      if (feature.ranges.some((range) => !compiled.some((batch) => batch.kind === this.batches[range.batch]!.kind))) return false;
      patches.push({ feature, data: compiled });
    }
    const dirty = this.batches.map(() => [] as { start: number; end: number }[]);
    for (const { feature, data } of patches) {
      const offsets = new Map<string, number>();
      for (const range of feature.ranges) {
        const batch = this.batches[range.batch]!;
        const flag = pickOffset(batch) + 1, step = stride(batch);
        const visibleWeight = (): number => {
          let count = 0;
          for (let at = range.start; at < range.end; at += step) {
            if (batch.data[at + flag]! < FLAG_HIDDEN) count += this.weights[range.batch]?.[at / step] ?? 1;
          }
          return batch.kind === 'fills' ? count / 3 : count;
        };
        const before = visibleWeight();
        if (data) {
          const part = data.find((part) => part.kind === batch.kind)!;
          const from = offsets.get(batch.kind) ?? 0;
          batch.data.set(part.data.subarray(from, from + range.end - range.start), range.start);
          offsets.set(batch.kind, from + range.end - range.start);
        } else {
          for (let at = range.start + pickOffset(batch) + 1; at < range.end; at += stride(batch)) batch.data[at] = FLAG_HIDDEN;
        }
        this.visibleCounts[range.batch]! += visibleWeight() - before;
        dirty[range.batch]!.push({ start: range.start, end: range.end });
      }
    }
    dirty.forEach((ranges, i) => {
      if (ranges.length === 0) return;
      ranges.sort((a, b) => a.start - b.start);
      const merged: { start: number; end: number }[] = [];
      for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
      }
      const version = this.uploads[i]!.version;
      this.uploads[i] = { version: version + 1, previousVersion: version, ranges: merged };
    });
    this.sourceEpoch = this.source.store.changes.epoch; this.overrideEpoch = this.layer.overrideChanges.epoch;
    return true;
  }

  draws(view: ViewTransform, pickBase: number): readonly PlanBatch[] {
    const origin = transformOrigin(view);
    return this.batches.map((batch, i) => ({ ...batch, visibleCount: this.visibleCounts[i]!, upload: this.uploads[i]!, pickBase,
      offsetX: (this.origin.x - origin.x) * this.scale, offsetY: (this.origin.y - origin.y) * this.scale }));
  }
}
