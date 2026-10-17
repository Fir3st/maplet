/**
 * Display layers and groups.
 *
 * A layer references one source and one style; it never owns a second copy of the
 * data (LAYER-01, LAYER-02). Groups order and toggle layers together; effective
 * visibility is the layer's own flag AND all ancestor group flags (LAYER-07).
 * Per-feature overrides belong to one layer only (LAYER-06). The registry is a
 * tree so `move` on a group moves its whole subtree (LAYER-09); inserting a group
 * into its own descendant is rejected atomically (LAYER-08).
 */

import { fail } from '../api/errors.ts';
import type { FeatureId, FeatureRef, MapFeatureEvent } from '../api/types.ts';
import { featureRefKey } from '../api/types.ts';
import { Emitter } from '../api/events.ts';
import { ChangeJournal } from './change-journal.ts';
import type { ExpressionInput, Filter, ColorValue } from './expression.ts';

export type LayerKind = 'raster' | 'points' | 'lines' | 'fills' | 'labels';

export type PointShape = 'circle' | 'square' | 'diamond' | 'triangle';

export interface PointsLayerStyle {
  readonly radiusPx?: ExpressionInput<number>;
  readonly color?: ExpressionInput<ColorValue>;
  readonly opacity?: ExpressionInput<number>;
  readonly strokeColor?: ExpressionInput<ColorValue>;
  readonly strokeWidthPx?: ExpressionInput<number>;
  readonly shape?: ExpressionInput<PointShape>;
  /**
   * Registered image asset id. Once the asset is ready the point draws as a
   * sprite; until then (or on load error) the plain shape is drawn, so a broken
   * asset is never a silently empty symbol (MEDIA-07/08).
   */
  readonly icon?: ExpressionInput<string>;
  /** Square sprite size in CSS px; default is the natural size / DPR. */
  readonly iconSize?: ExpressionInput<number>;
  /** Sprite centre offset from the feature position (default centred). */
  readonly iconAnchor?: { readonly x: number; readonly y: number };
  /**
   * Sprite rotation in degrees clockwise around the anchor point (GEOM-04).
   * The plain shape fallback of a loading/failed icon is not rotated.
   */
  readonly iconRotate?: ExpressionInput<number>;
  /**
   * RGBA multiplier applied to the icon texture; default white (no tint).
   * Alpha combines with `opacity`. Only the ready sprite is tinted — the plain
   * shape fallback of a loading/failed icon keeps its `color` (MEDIA-07/08).
   */
  readonly iconTint?: ExpressionInput<ColorValue>;
  readonly zIndex?: ExpressionInput<number>;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export interface LinesLayerStyle {
  readonly widthPx?: ExpressionInput<number>;
  readonly color?: ExpressionInput<ColorValue>;
  readonly opacity?: ExpressionInput<number>;
  readonly dash?: readonly number[];
  readonly cap?: 'round' | 'butt';
  readonly join?: 'round' | 'bevel';
  readonly zIndex?: ExpressionInput<number>;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export interface FillsLayerStyle {
  readonly fill?: boolean;
  readonly fillColor?: ExpressionInput<ColorValue>;
  readonly fillOpacity?: ExpressionInput<number>;
  readonly strokeColor?: ExpressionInput<ColorValue>;
  readonly strokeWidthPx?: ExpressionInput<number>;
  readonly dash?: readonly number[];
  readonly visible?: boolean;
  readonly zIndex?: ExpressionInput<number>;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export interface LabelsLayerStyle {
  /**
   * Label text; defaults to the feature's `name` property. Empty text is skipped.
   * `\n` splits the text into a vertically centred multi-line block.
   */
  readonly text?: ExpressionInput<string | number | null>;
  /** Font size in CSS px (DPR-independent); default 12. */
  readonly sizePx?: ExpressionInput<number>;
  readonly color?: ExpressionInput<ColorValue>;
  readonly fontFamily?: string;
  /**
   * Base direction used when rasterizing bidi text into the glyph atlas
   * (TEXT-04); `'auto'` resolves the first strong character per label.
   */
  readonly direction?: 'ltr' | 'rtl' | 'auto';
  /** Shifts the label centre relative to the anchor point. */
  readonly offsetPx?: { readonly x: number; readonly y: number };
  /**
   * Label rotation in degrees clockwise around its centre (anchor + offset,
   * TEXT-06); collision and picking use the rotated quad.
   */
  readonly rotate?: ExpressionInput<number>;
  /** Higher priority wins collisions; ties keep the stable slot order (TEXT-07). */
  readonly priority?: ExpressionInput<number>;
  /** Suppress labels whose box intersects an already drawn higher-priority label. */
  readonly collision?: boolean;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export interface RasterLayerStyle {
  readonly opacity?: number;
}

export interface LayerStyleMap {
  readonly raster: RasterLayerStyle;
  readonly points: PointsLayerStyle;
  readonly lines: LinesLayerStyle;
  readonly fills: FillsLayerStyle;
  readonly labels: LabelsLayerStyle;
}

export interface SourceReference {
  readonly id: string;
}

export interface LayerSpec<K extends LayerKind = LayerKind> {
  readonly id: string;
  readonly type: K;
  readonly source: string | SourceReference;
  readonly style?: LayerStyleMap[K];
  readonly filter?: Filter | null;
  /** Draws only one source layer of a vector tile source (MVT namespace). */
  readonly namespace?: string;
  readonly visible?: boolean;
  /** Human-readable name for layer controls; defaults to the id. */
  readonly label?: string;
  readonly interaction?: { readonly enabled?: boolean; readonly draggable?: boolean };
  /** Group id; when present the layer is appended to that group. */
  readonly group?: string;
}

export interface FeatureOverride {
  readonly color?: ColorValue;
  readonly opacity?: number;
  /** Per-feature icon asset id; overrides the layer's `icon` (MEDIA-07/08 fallback). */
  readonly icon?: string;
  /** Per-feature square sprite size in CSS px; overrides `iconSize`. */
  readonly iconSize?: number;
  /** Per-feature sprite centre offset; overrides `iconAnchor`. */
  readonly iconAnchor?: { readonly x: number; readonly y: number };
  readonly iconTint?: ColorValue;
  readonly fillColor?: ColorValue;
  readonly fillOpacity?: number;
  readonly radiusPx?: number;
  readonly widthPx?: number;
  readonly visible?: boolean;
  readonly interactive?: boolean;
  /** Per-feature dragging; `interaction.draggable` already covers a whole layer. */
  readonly draggable?: boolean;
  readonly zIndex?: number;
}

export interface GroupSpec {
  readonly id: string;
  readonly visible?: boolean;
  /** Human-readable name for layer controls; defaults to the id. */
  readonly label?: string;
  readonly parent?: string;
}

export type MoveTarget =
  | { readonly before: string }
  | { readonly after: string }
  | { readonly index: number }
  | { readonly into: string | null; readonly index?: number };

/**
 * True when the pointer can drag this feature: either the whole layer opted in
 * with `interaction.draggable`, or the feature carries its own override — the
 * shared marker layer uses the override so one pin can drag while others pan
 * the map (INPUT-10). A feature override wins in both directions, so a single
 * feature can opt out of a draggable layer.
 */
export function featureIsDraggable(layer: LayerImpl, ref: FeatureRef): boolean {
  return layer.overrides.get(layer.overrideKey(ref))?.draggable ?? layer.draggable;
}

export class LayerImpl {
  readonly id: string;
  kind: LayerKind;
  sourceId: string;
  style: LayerStyleMap[LayerKind];
  filter: Filter | null;
  namespace: string | undefined;
  visible: boolean;
  /** Optional control label; the id is the fallback. */
  label: string | undefined;
  interactionEnabled: boolean;
  /** True when `interaction.enabled` was set explicitly on the layer. */
  interactionExplicit: boolean;
  draggable: boolean;
  readonly overrides = new Map<string, FeatureOverride>();
  /** Feature events delivered to this layer before their group chain (EVENT-01). */
  readonly featureEmitter = new Emitter<{ feature: MapFeatureEvent }>();
  readonly lifetime = new AbortController();
  parent: GroupImpl | null = null;
  removed = false;
  /** Incremented on every change that affects what this layer draws. */
  revision = 0;
  /** Whole-layer changes are distinct from local overrides. */
  layoutRevision = 0;
  readonly overrideChanges = new ChangeJournal<FeatureRef | FeatureId>();

  constructor(spec: LayerSpec) {
    this.id = spec.id;
    this.kind = spec.type;
    this.sourceId = typeof spec.source === 'string' ? spec.source : spec.source.id;
    this.style = spec.style ?? {};
    this.filter = spec.filter ?? null;
    this.namespace = spec.namespace;
    this.visible = spec.visible ?? true;
    this.label = spec.label;
    this.interactionEnabled = spec.interaction?.enabled ?? true;
    this.interactionExplicit = spec.interaction?.enabled !== undefined;
    this.draggable = spec.interaction?.draggable ?? false;
  }

  touch(): void {
    this.revision++;
    this.layoutRevision++;
  }

  overrideKey(target: FeatureRef | FeatureId): string {
    if (typeof target === 'object' && target !== null && 'id' in target && 'generation' in target) {
      return featureRefKey(target);
    }
    return featureRefKey({ id: target });
  }

  setOverride(target: FeatureRef | FeatureId, override: FeatureOverride): void {
    this.overrides.set(this.overrideKey(target), override);
    this.overrideChanges.note(target);
    this.revision++;
  }

  clearOverride(target: FeatureRef | FeatureId): void {
    this.overrides.delete(this.overrideKey(target));
    this.overrideChanges.note(target);
    this.revision++;
  }
}

export class GroupImpl {
  readonly id: string;
  visible: boolean;
  /** Optional control label; the id is the fallback. */
  readonly label: string | undefined;
  parent: GroupImpl | null = null;
  children: (LayerImpl | GroupImpl)[] = [];
  /** Feature events bubble through groups between their layer and the map. */
  readonly featureEmitter = new Emitter<{ feature: MapFeatureEvent }>();
  readonly lifetime = new AbortController();
  removed = false;

  constructor(spec: GroupSpec) {
    this.id = spec.id;
    this.visible = spec.visible ?? true;
    this.label = spec.label;
  }

  isAncestorOf(entry: LayerImpl | GroupImpl): boolean {
    let current: GroupImpl | null = entry.parent;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }
}

export class LayerRegistry {
  private readonly layers = new Map<string, LayerImpl>();
  private readonly groups = new Map<string, GroupImpl>();
  readonly root: (LayerImpl | GroupImpl)[] = [];
  onChange: (() => void) | null = null;
  private readonly sourceExists: (sourceId: string) => boolean;

  constructor(sourceExists: (sourceId: string) => boolean) {
    this.sourceExists = sourceExists;
  }

  private notify(): void {
    this.onChange?.();
  }

  add(spec: LayerSpec): LayerImpl {
    if (this.layers.has(spec.id) || this.groups.has(spec.id)) {
      fail('duplicate-id', `layer id already exists: ${spec.id}`, { id: spec.id });
    }
    const sourceId = typeof spec.source === 'string' ? spec.source : spec.source.id;
    if (!this.sourceExists(sourceId)) {
      fail('not-found', `layer ${spec.id}: source not found: ${sourceId}`, { sourceId });
    }
    const layer = new LayerImpl(spec);
    this.layers.set(layer.id, layer);
    const parent = spec.group ? this.groups.get(spec.group) : undefined;
    if (spec.group && !parent) {
      this.layers.delete(layer.id);
      fail('not-found', `layer ${spec.id}: group not found: ${spec.group}`, { group: spec.group });
    }
    if (parent) {
      layer.parent = parent;
      parent.children.push(layer);
    } else {
      this.root.push(layer);
    }
    this.notify();
    return layer;
  }

  addGroup(spec: GroupSpec): GroupImpl {
    if (this.layers.has(spec.id) || this.groups.has(spec.id)) {
      fail('duplicate-id', `group id already exists: ${spec.id}`, { id: spec.id });
    }
    const group = new GroupImpl(spec);
    this.groups.set(group.id, group);
    const parent = spec.parent ? this.groups.get(spec.parent) : undefined;
    if (spec.parent && !parent) {
      this.groups.delete(group.id);
      fail('not-found', `group ${spec.id}: parent group not found: ${spec.parent}`, {
        group: spec.parent,
      });
    }
    if (parent) {
      group.parent = parent;
      parent.children.push(group);
    } else {
      this.root.push(group);
    }
    this.notify();
    return group;
  }

  get(id: string): LayerImpl | undefined {
    return this.layers.get(id);
  }

  getGroup(id: string): GroupImpl | undefined {
    return this.groups.get(id);
  }

  getEntry(id: string): LayerImpl | GroupImpl | undefined {
    return this.layers.get(id) ?? this.groups.get(id);
  }

  list(): LayerImpl[] {
    return Array.from(this.layers.values()).filter((layer) => !layer.removed);
  }

  listGroups(): GroupImpl[] {
    return Array.from(this.groups.values()).filter((group) => !group.removed);
  }

  /** Flatten ignoring visibility flags (diagnostics and ordering tests). */
  flattenAll(): LayerImpl[] {
    const out: LayerImpl[] = [];
    const visit = (entries: (LayerImpl | GroupImpl)[]): void => {
      for (const entry of entries) {
        if (entry.removed) continue;
        if (entry instanceof GroupImpl) visit(entry.children);
        else out.push(entry);
      }
    };
    visit(this.root);
    return out;
  }

  /** Depth-first rendering order: earlier entries are drawn below later ones. */
  flatten(): LayerImpl[] {
    const out: LayerImpl[] = [];
    const visit = (entries: (LayerImpl | GroupImpl)[]): void => {
      for (const entry of entries) {
        if (entry.removed) continue;
        if (entry instanceof GroupImpl) {
          if (entry.visible) visit(entry.children);
        } else {
          out.push(entry);
        }
      }
    };
    visit(this.root);
    return out;
  }

  isEffectivelyVisible(layer: LayerImpl): boolean {
    if (!layer.visible) return false;
    let parent = layer.parent;
    while (parent) {
      if (!parent.visible) return false;
      parent = parent.parent;
    }
    return true;
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.getEntry(id);
    if (!entry) fail('not-found', `layer or group not found: ${id}`, { id });
    entry.visible = visible;
    if (entry instanceof LayerImpl) entry.touch();
    this.notify();
  }

  update(
    id: string,
    patch: Partial<
      Pick<LayerSpec, 'style' | 'filter' | 'namespace' | 'visible' | 'label' | 'interaction'>
    >,
  ): LayerImpl {
    const layer = this.layers.get(id);
    if (!layer) fail('not-found', `layer not found: ${id}`, { id });
    if (patch.style !== undefined) layer.style = patch.style;
    if (patch.filter !== undefined) layer.filter = patch.filter;
    if (patch.namespace !== undefined) layer.namespace = patch.namespace;
    if (patch.visible !== undefined) layer.visible = patch.visible;
    if (patch.label !== undefined) layer.label = patch.label;
    if (patch.interaction !== undefined) {
      if (patch.interaction.enabled !== undefined) layer.interactionExplicit = true;
      layer.interactionEnabled = patch.interaction.enabled ?? layer.interactionEnabled;
      layer.draggable = patch.interaction.draggable ?? layer.draggable;
    }
    layer.touch();
    this.notify();
    return layer;
  }

  /** Removes a layer (or a group with its subtree); shared source data stays. */
  remove(id: string): void {
    const layer = this.layers.get(id);
    if (layer) {
      this.detach(layer);
      layer.removed = true;
      layer.lifetime.abort();
      layer.featureEmitter.clear();
      this.layers.delete(id);
      this.notify();
      return;
    }
    const group = this.groups.get(id);
    if (group) {
      this.detach(group);
      this.removeSubtree(group);
      this.notify();
      return;
    }
    fail('not-found', `layer or group not found: ${id}`, { id });
  }

  private removeSubtree(group: GroupImpl): void {
    for (const child of group.children) {
      if (child instanceof GroupImpl) this.removeSubtree(child);
      else {
        child.removed = true;
        child.lifetime.abort();
        child.featureEmitter.clear();
        this.layers.delete(child.id);
      }
    }
    group.children = [];
    group.removed = true;
    group.lifetime.abort();
    group.featureEmitter.clear();
    this.groups.delete(group.id);
  }

  private detach(entry: LayerImpl | GroupImpl): void {
    const siblings = entry.parent ? entry.parent.children : this.root;
    const index = siblings.indexOf(entry);
    if (index >= 0) siblings.splice(index, 1);
    entry.parent = null;
  }

  /**
   * Moves a layer or group. Inserting a group into its own descendant is rejected
   * without changing the tree (LAYER-08).
   */
  move(id: string, target: MoveTarget): void {
    const entry = this.getEntry(id);
    if (!entry) fail('not-found', `layer or group not found: ${id}`, { id });
    if ('into' in target) {
      const container = target.into === null ? null : this.groups.get(target.into);
      if (container === undefined)
        fail('not-found', `group not found: ${target.into}`, { group: target.into });
      if (entry === container) fail('invalid-argument', 'cannot move a group into itself', { id });
      if (container && entry instanceof GroupImpl && entry.isAncestorOf(container)) {
        fail('invalid-argument', `cannot move group ${id} into its own descendant`, { id });
      }
      this.detach(entry);
      entry.parent = container;
      const children = container ? container.children : this.root;
      const index = target.index ?? children.length;
      children.splice(Math.max(0, Math.min(index, children.length)), 0, entry);
      this.notify();
      return;
    }
    const siblings = entry.parent ? entry.parent.children : this.root;
    if ('index' in target) {
      const parent = entry.parent;
      this.detach(entry);
      entry.parent = parent;
      const index = Math.max(0, Math.min(target.index, siblings.length));
      siblings.splice(index, 0, entry);
      this.notify();
      return;
    }
    const anchorId = 'before' in target ? target.before : target.after;
    const anchor = this.getEntry(anchorId);
    if (!anchor) fail('not-found', `anchor not found: ${anchorId}`, { id: anchorId });
    if (entry === anchor) return;
    if (entry instanceof GroupImpl && entry.isAncestorOf(anchor)) {
      fail('invalid-argument', `cannot move group ${id} inside its own subtree`, { id });
    }
    const anchorSiblings = anchor.parent ? anchor.parent.children : this.root;
    this.detach(entry);
    const anchorIndex = anchorSiblings.indexOf(anchor);
    const insertAt = 'before' in target ? anchorIndex : anchorIndex + 1;
    entry.parent = anchor.parent;
    anchorSiblings.splice(Math.max(0, insertAt), 0, entry);
    this.notify();
  }
}
