/** Retained plain-point geometry. Pan changes uniforms; edits change instance ranges. */
import type { FeatureId } from '../api/types.ts';
import type { Scene } from '../scene/scene.ts';
import type { SourceImpl } from '../scene/source.ts';
import type { SlotRecord } from '../scene/store.ts';
import type { LayerImpl, PointsLayerStyle, PointShape } from '../scene/layers.ts';
import { compileFilter, evaluateStyleValue, type ExpressionContext, type ExpressionInput, type ColorValue } from '../scene/expression.ts';
import { transformOrigin, worldScaleAt, type ViewTransform } from '../math/transform.ts';
import { POINT_STRIDE, POINT_SHAPES, FLAG_INTERACTIVE, FLAG_HIDDEN, type PickEntry, type PickEntries, type PlanBatch, type BufferUpload } from './frame-plan.ts';
import { parseColor, type Rgba } from './color.ts';

interface Rect { minX: number; minY: number; maxX: number; maxY: number }
const BLUE: Rgba = [0.23, 0.51, 0.96, 1];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

function valueReader<T>(input: ExpressionInput<T> | undefined, fallback: T): (ctx: ExpressionContext) => T {
  if (input === undefined) return () => fallback;
  if (typeof input === 'object' && input !== null && 'evaluate' in input) {
    if (!input.constant) return (ctx) => evaluateStyleValue(input, fallback, ctx);
    const value = input.evaluate({ properties: {}, state: { hovered: false, selected: false, disabled: false }, zoom: 0 });
    return () => value;
  }
  return () => input as T;
}

function colorReader(input: ExpressionInput<ColorValue> | undefined, fallback: Rgba): (ctx: ExpressionContext) => Rgba {
  const read = valueReader(input, fallback);
  let last: ColorValue | undefined;
  let color = fallback;
  return (ctx) => {
    const next = read(ctx);
    if (next !== last || Array.isArray(next)) { color = parseColor(next, fallback); last = next; }
    return color;
  };
}

export class PointCache {
  private readonly scene: Scene;
  readonly source: SourceImpl;
  readonly layer: LayerImpl;
  readonly entries: PickEntries;
  private readonly pickIds: FeatureId[];
  private readonly pickNamespaces: (string | undefined)[];
  private readonly pickGenerations: Float64Array;
  readonly data: Float32Array;
  private readonly slotToInstance: Int32Array;
  private readonly zValues: Float64Array;
  private readonly visible: Uint8Array;
  private readonly origin: { x: number; y: number };
  private readonly scale: number;
  private readonly rect: Rect;
  private readonly zoom: number;
  private readonly layoutRevision: number;
  private readonly renderEpoch: number;
  private sourceEpoch: number;
  private overrideEpoch: number;
  private visibleCount = 0;
  private upload: BufferUpload = { version: 0, previousVersion: -1, ranges: [] };
  private readonly filter: ReturnType<typeof compileFilter>;
  private readonly radius;
  private readonly color;
  private readonly opacity;
  private readonly shape;
  private readonly strokeWidth;
  private readonly strokeColor;
  private readonly zIndex;

  constructor(scene: Scene, layer: LayerImpl, source: SourceImpl, view: ViewTransform) {
    this.scene = scene;
    this.source = source;
    this.layer = layer;
    this.zoom = view.zoom;
    this.scale = worldScaleAt(view.zoom);
    this.origin = transformOrigin(view);
    this.layoutRevision = layer.layoutRevision;
    this.renderEpoch = scene.renderEpoch;
    this.sourceEpoch = source.store.changes.epoch;
    this.overrideEpoch = layer.overrideChanges.epoch;
    this.rect = {
      minX: this.origin.x - 32 / this.scale, minY: this.origin.y - 32 / this.scale,
      maxX: this.origin.x + (view.width + 32) / this.scale,
      maxY: this.origin.y + (view.height + 32) / this.scale,
    };
    const style = layer.style as PointsLayerStyle;
    this.filter = compileFilter(layer.filter);
    this.radius = valueReader(style.radiusPx, 5);
    this.color = colorReader(style.color, BLUE);
    this.opacity = valueReader(style.opacity, 1);
    this.shape = valueReader<PointShape>(style.shape, 'circle');
    this.strokeWidth = valueReader(style.strokeWidthPx, 0);
    this.strokeColor = colorReader(style.strokeColor, TRANSPARENT);
    this.zIndex = valueReader(style.zIndex, 0);
    const candidates: { record: SlotRecord; z: number }[] = [];
    source.store.queryRect(this.rect.minX, this.rect.minY, this.rect.maxX, this.rect.maxY, (record) => {
      if (!this.contains(record) || layer.namespace !== undefined && layer.namespace !== record.namespace) return;
      candidates.push({ record, z: this.recordZ(record) });
    });
    candidates.sort((a, b) => a.z - b.z || a.record.slot - b.record.slot);
    this.data = new Float32Array(candidates.length * POINT_STRIDE);
    this.zValues = new Float64Array(candidates.length);
    this.visible = new Uint8Array(candidates.length);
    this.pickIds = new Array(candidates.length);
    this.pickNamespaces = new Array(candidates.length);
    this.pickGenerations = new Float64Array(candidates.length);
    this.entries = { length: candidates.length, get: (index) => this.pickEntry(index) };
    this.slotToInstance = new Int32Array(source.store.slotCapacity);
    this.slotToInstance.fill(-1);
    for (let i = 0; i < candidates.length; i++) {
      const { record, z } = candidates[i]!;
      this.slotToInstance[record.slot] = i;
      this.zValues[i] = z;
      this.pickIds[i] = record.id;
      this.pickNamespaces[i] = record.namespace;
      this.pickGenerations[i] = record.generation;
      this.write(record, i);
    }
  }

  /** Snapshot identity columns, never a live/recyclable SlotView, back each pick. */
  private pickEntry(index: number): PickEntry | undefined {
    if (index < 0 || index >= this.entries.length) return undefined;
    const namespace = this.pickNamespaces[index];
    return { layerId: this.layer.id, feature: {
      sceneId: this.scene.id, sourceId: this.source.id, id: this.pickIds[index]!,
      generation: this.pickGenerations[index]!, ...(namespace === undefined ? {} : { namespace }),
    } };
  }

  private contains(record: SlotRecord): boolean {
    return record.wx >= this.rect.minX && record.wx <= this.rect.maxX && record.wy >= this.rect.minY && record.wy <= this.rect.maxY;
  }

  private override(record: SlotRecord) {
    if (this.layer.overrides.size === 0) return undefined;
    return this.layer.overrides.get(this.layer.overrideKey(this.source.refOf(record)));
  }

  private recordZ(record: SlotRecord): number {
    return this.zIndex({ properties: record.properties, state: this.scene.state.stateOf(this.source, record), zoom: this.zoom }) + (this.override(record)?.zIndex ?? 0);
  }

  private write(record: SlotRecord | undefined, instance: number): void {
    const at = instance * POINT_STRIDE;
    // Unwritten rows are not yet counted. Retained hidden rows stay out of both passes.
    const wasVisible = this.visible[instance] === 1;
    const override = record ? this.override(record) : undefined;
    const state = record ? this.scene.state.stateOf(this.source, record) : undefined;
    const visible = record !== undefined && this.contains(record) && override?.visible !== false &&
      this.filter({ id: record.id, state: state! }, record.properties) &&
      (!this.scene.bindingsActive || !this.scene.bindings.isTargetHidden(this.entries.get(instance)!.feature));
    if (wasVisible) this.visibleCount--;
    if (!visible) {
      this.visible[instance] = 0;
      this.data[at + 15] = FLAG_HIDDEN;
      return;
    }
    this.visibleCount++;
    this.visible[instance] = 1;
    const ctx = { properties: record.properties, state: state!, zoom: this.zoom };
    const color = override?.color === undefined ? this.color(ctx) : parseColor(override.color, BLUE);
    const stroke = this.strokeColor(ctx);
    const width = this.strokeWidth(ctx);
    const radius = override?.radiusPx ?? this.radius(ctx);
    const data = this.data;
    data[at] = (record.wx - this.origin.x) * this.scale;
    data[at + 1] = (record.wy - this.origin.y) * this.scale;
    data[at + 2] = radius; data[at + 3] = radius;
    data[at + 4] = color[0]; data[at + 5] = color[1]; data[at + 6] = color[2];
    data[at + 7] = color[3] * (override?.opacity ?? this.opacity(ctx));
    data[at + 8] = stroke[0]; data[at + 9] = stroke[1]; data[at + 10] = stroke[2];
    data[at + 11] = width > 0 ? stroke[3] || 1 : 0;
    data[at + 12] = POINT_SHAPES[this.shape(ctx)] ?? 0;
    data[at + 13] = width; data[at + 14] = instance;
    data[at + 15] = this.layer.interactionEnabled && (override?.interactive ?? true) ? FLAG_INTERACTIVE : 0;
  }

  /** false requests a fresh resident set/order, never a silently stale buffer. */
  update(view: ViewTransform): boolean {
    if (view.zoom !== this.zoom || this.layoutRevision !== this.layer.layoutRevision || this.renderEpoch !== this.scene.renderEpoch) return false;
    const origin = transformOrigin(view);
    if (origin.x < this.rect.minX || origin.y < this.rect.minY ||
        origin.x + view.width / this.scale > this.rect.maxX || origin.y + view.height / this.scale > this.rect.maxY) return false;
    const sourceChanges = this.source.store.changes.since(this.sourceEpoch);
    const overrideChanges = this.layer.overrideChanges.since(this.overrideEpoch);
    if (!sourceChanges || !overrideChanges) return false;
    const slots = new Set(sourceChanges);
    for (const target of overrideChanges) {
      const ref = typeof target === 'object' ? target : { id: target as FeatureId, namespace: undefined };
      const record = this.source.store.get(ref.id, ref.namespace);
      if (record) slots.add(record.slot);
    }
    const changed: number[] = [];
    for (const slot of slots) {
      const record = this.source.store.getBySlot(slot);
      const instance = this.slotToInstance[slot] ?? -1;
      if (instance < 0) {
        if (record && this.contains(record) && (this.layer.namespace === undefined || record.namespace === this.layer.namespace)) return false;
        continue;
      }
      const ref = this.entries.get(instance)!.feature;
      if (record && (record.id !== ref.id || record.namespace !== ref.namespace || record.generation !== ref.generation || this.recordZ(record) !== this.zValues[instance])) return false;
      changed.push(instance);
    }
    for (const instance of changed) {
      // entries retain immutable generation-bound references; removal only hides a row.
      const ref = this.entries.get(instance)!.feature;
      this.write(this.source.store.get(ref.id, ref.namespace), instance);
    }
    this.sourceEpoch = this.source.store.changes.epoch;
    this.overrideEpoch = this.layer.overrideChanges.epoch;
    if (changed.length > 0) {
      changed.sort((a, b) => a - b);
      const ranges: { start: number; end: number }[] = [];
      for (const instance of changed) {
        const start = instance * POINT_STRIDE;
        const last = ranges[ranges.length - 1];
        if (last && last.end === start) last.end += POINT_STRIDE;
        else ranges.push({ start, end: start + POINT_STRIDE });
      }
      this.upload = { version: this.upload.version + 1, previousVersion: this.upload.version, ranges };
    }
    return true;
  }

  batch(view: ViewTransform, pickBase: number): PlanBatch {
    const origin = transformOrigin(view);
    return {
      layerId: this.layer.id, kind: 'points', data: this.data, count: this.entries.length,
      visibleCount: this.visibleCount, upload: this.upload, pickBase,
      offsetX: (this.origin.x - origin.x) * this.scale,
      offsetY: (this.origin.y - origin.y) * this.scale,
    };
  }
}
