/**
 * Frame plan: turns scene data, layers and the current view into packed instance
 * buffers, fill triangles and tile placements.
 *
 * The plan is backend-independent; the WebGL 1 and WebGPU backends only upload and
 * draw it. Everything is computed in CSS pixels (device scaling happens in the
 * shaders via the DPR uniform). The plan is rebuilt from `scene.revision` and
 * `scene.rasterEpoch` (data or raster descriptor changes); a static scene is not
 * re-traversed on every animation frame (LIFE-04).
 *
 * Instance layouts (Float32, all CSS px):
 * - points, stride 16: sx, sy, rx, ry | r, g, b, alpha | sr, sg, sb, sa |
 *   shape, strokeWidth, pickIndex, flags
 * - lines, stride 16: x0, y0, x1, y1 | width, cap, pickIndex, flags |
 *   r, g, b, alpha | arc0, len, dashPhase, 0
 * - fills, stride 12 per vertex: sx, sy, 0, 0 | r, g, b, alpha | pickIndex, flags, 0, 0
 */

import type { FeatureRef, ScreenPoint } from '../api/types.ts';
import { transformOrigin, worldScaleAt, type ViewTransform } from '../math/transform.ts';
import type { GeoBounds } from '../math/bounds.ts';
import type { Scene } from '../scene/scene.ts';
import type { LayerImpl } from '../scene/layers.ts';
import { compileFilter, evaluateStyleValue, type ExpressionContext } from '../scene/expression.ts';
import type { SourceImpl } from '../scene/source.ts';
import type { SlotRecord } from '../scene/store.ts';
import { GEOMETRY_KIND } from '../geometry/geometry.ts';
import { formatTileUrl, tileZoomForView, tilesForWorldRect, wmsGetMapUrl } from '../formats/raster.ts';
import { parseColor, type Rgba } from './color.ts';
import { triangulatePolygonWithHoles } from './triangulate.ts';
import type {
  FeatureOverride,
  FillsLayerStyle,
  LabelsLayerStyle,
  LinesLayerStyle,
  PointsLayerStyle,
  RasterLayerStyle,
} from '../scene/layers.ts';
import type { RasterTilesOptions, TileCoord, TileGridOptions, WmsOptions } from '../formats/raster.ts';

export const POINT_STRIDE = 16;
export const LINE_STRIDE = 16;
export const FILL_STRIDE = 12;

export const POINT_SHAPES = { circle: 0, square: 1, diamond: 2, triangle: 3 } as const;
export const FLAG_INTERACTIVE = 1;

export interface PlanBatch {
  readonly layerId: string;
  readonly kind: 'points' | 'lines' | 'fills';
  readonly data: Float32Array;
  /** Instances for points/lines; vertices for fills. */
  readonly count: number;
  /** Dash pattern for line batches (null = solid). GEOM-07. */
  readonly dash?: readonly number[] | null;
}

/** A coarser tile drawn scaled-up until the requested tile is decoded. */
export interface TileFallback {
  readonly url: string;
  /** UV sub-rectangle of the ancestor that the placement occupies. */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export interface TilePlacement {
  readonly sourceId: string;
  readonly layerId: string;
  /** Tile identity (`z/x/y`, or a geometry key for WMS) used for frame continuity. */
  readonly tileKey: string;
  readonly url: string;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly opacity: number;
  readonly sourceRevision: number;
  /**
   * Index into the pick table when the raster layer is interactive: the whole
   * displayed area of the source is one pick record, never one per tile or per
   * pixel (WMS-06). `undefined` keeps the layer out of the pick pass.
   */
  readonly pickIndex?: number;
  /**
   * Coarser tiles covering this placement, nearest level first; the backend
   * draws the first decoded one scaled up so the map never flashes blank while
   * a new zoom level loads.
   */
  readonly fallbacks: readonly TileFallback[];
  /** Four finer tiles (TL, TR, BL, BR) filling a zoom-out gap, or null. */
  readonly children: readonly [string, string, string, string] | null;
}

/**
 * A label anchored at a feature position (CSS px). Text is measured and
 * rasterized by the backend into a shared glyph atlas; the plan never reads
 * fonts or the DOM (TEXT-01, TEXT-08).
 */
export interface LabelPlacement {
  readonly sourceId: string;
  readonly layerId: string;
  readonly feature: FeatureRef;
  readonly text: string;
  readonly sizePx: number;
  readonly fontFamily: string;
  /** Base direction for bidi layout in the glyph atlas (TEXT-04). */
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly color: Rgba;
  /** Offset of the label centre from the anchor point. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Clockwise rotation in degrees around the label centre (TEXT-06). */
  readonly rotate: number;
  /** Suppress when the box intersects an earlier (higher-priority) label. */
  readonly collision: boolean;
  readonly pickIndex: number;
  readonly interactive: boolean;
  readonly sx: number;
  readonly sy: number;
}

/** A textured sprite (registered image asset) anchored at a feature position. */
export interface SpritePlacement {
  readonly sourceId: string;
  readonly layerId: string;
  readonly feature: FeatureRef;
  readonly assetId: string;
  readonly sx: number;
  readonly sy: number;
  /** Square size in CSS px; 0 = natural size / DPR (resolved by the backend). */
  readonly sizePx: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Clockwise rotation in degrees around the anchor (GEOM-04). */
  readonly rotate: number;
  readonly opacity: number;
  readonly pickIndex: number;
  readonly interactive: boolean;
}

/**
 * A media source (image/video) placed into explicit bounds (MEDIA-01..06).
 * The backend uploads the source's current pixels; the plan carries only the
 * screen quad, opacity and the pick identity of the media record.
 */
export interface MediaPlacement {
  readonly sourceId: string;
  readonly layerId: string;
  readonly kind: 'image' | 'video';
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly opacity: number;
  /** Present when the quad is drawn into the pick pass; index into the pick table. */
  readonly pickIndex?: number;
}

export type DrawItem =
  | { readonly type: 'batch'; readonly batch: PlanBatch }
  | { readonly type: 'tiles'; readonly tiles: readonly TilePlacement[] }
  | { readonly type: 'labels'; readonly labels: readonly LabelPlacement[] }
  | { readonly type: 'sprites'; readonly sprites: readonly SpritePlacement[] }
  | { readonly type: 'media'; readonly media: readonly MediaPlacement[] };

export interface PickEntry {
  readonly feature: FeatureRef;
  readonly layerId: string;
}

export interface FramePlan {
  readonly revision: number;
  readonly view: ViewTransform;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly dpr: number;
  readonly draws: readonly DrawItem[];
  readonly pickTable: readonly PickEntry[];
  readonly stats: { readonly instances: number; readonly drawCalls: number };
}

export interface FramePlanOptions {
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly dpr: number;
}

interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const DEFAULT_POINT_COLOR: Rgba = [0.23, 0.51, 0.96, 1];
const DEFAULT_LINE_COLOR: Rgba = [0.2, 0.25, 0.33, 1];
const DEFAULT_FILL_COLOR: Rgba = [0.23, 0.51, 0.96, 0.25];
const DEFAULT_STROKE_COLOR: Rgba = [0.2, 0.25, 0.33, 1];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

let planCounter = 0;
let planRevision = -1;
let planKey = '';
let cachedPlan: FramePlan | null = null;

/* -------------------------------------------------------------------------- */
/* Tile fallback chains                                                        */
/* -------------------------------------------------------------------------- */

const MAX_FALLBACK_LEVELS = 5;

/**
 * Coarser tiles covering the given tile, nearest level first. The UV rectangle
 * picks the quadrant (sub-quadrant, ...) of the ancestor, so a decoded ancestor
 * can stand in for the requested tile at the correct offset while it loads.
 */
function tileFallbacks(
  options: RasterTilesOptions,
  grid: TileGridOptions,
  coord: TileCoord,
): TileFallback[] {
  const levels = Math.min(MAX_FALLBACK_LEVELS, coord.z - grid.minZoom);
  const list: TileFallback[] = [];
  for (let level = 1; level <= levels; level++) {
    const span = 2 ** level;
    const dx = coord.x % span;
    const dy = coord.y % span;
    list.push({
      url: formatTileUrl(
        options,
        { z: coord.z - level, x: coord.x >> level, y: coord.y >> level },
        { tms: grid.tms },
      ),
      u0: dx / span,
      v0: dy / span,
      u1: (dx + 1) / span,
      v1: (dy + 1) / span,
    });
  }
  return list;
}

/** Four finer tiles (TL, TR, BL, BR) that together cover the given tile. */
function tileChildren(
  options: RasterTilesOptions,
  grid: TileGridOptions,
  coord: TileCoord,
): readonly [string, string, string, string] | null {
  const ceiling = Math.min(grid.maxZoom, grid.nativeZoom ?? grid.maxZoom);
  if (coord.z + 1 > ceiling) return null;
  const z = coord.z + 1;
  const x = coord.x * 2;
  const y = coord.y * 2;
  const at = (cx: number, cy: number): string =>
    formatTileUrl(options, { z, x: cx, y: cy }, { tms: grid.tms });
  return [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)];
}

/** Builds (and caches) the frame plan for the current scene revision and viewport. */
export function buildFramePlan(scene: Scene, options: FramePlanOptions): FramePlan {
  const view = scene.attachedView;
  const transform = view.transform();
  planCounter++;
  void planCounter;
  const key = `${scene.id}:${scene.revision}:${scene.rasterEpoch}:${transform.zoom}:${transform.width}x${transform.height}:${options.deviceWidth}x${options.deviceHeight}@${options.dpr}:${transform.centerWorld.x},${transform.centerWorld.y}`;
  if (cachedPlan && planKey === key && planRevision === scene.revision) {
    return cachedPlan;
  }
  const plan = computePlan(scene, options);
  cachedPlan = plan;
  planKey = key;
  planRevision = scene.revision;
  return plan;
}

export function invalidateFramePlanCache(): void {
  cachedPlan = null;
  planKey = '';
  planRevision = -1;
}

let planBuildCount = 0;

/** Diagnostics: how many times the plan was rebuilt since module load. */
export function framePlanBuildCount(): number {
  return planBuildCount;
}

function computePlan(scene: Scene, options: FramePlanOptions): FramePlan {
  planBuildCount++;
  const view = scene.attachedView;
  const transform = view.transform();
  const scale = worldScaleAt(transform.zoom);
  const origin = transformOrigin(transform);
  const margin = 32;
  const rect: WorldRect = {
    minX: origin.x - margin / scale,
    minY: origin.y - margin / scale,
    maxX: origin.x + (transform.width + margin) / scale,
    maxY: origin.y + (transform.height + margin) / scale,
  };
  const draws: DrawItem[] = [];
  const pickTable: PickEntry[] = [];
  let instances = 0;
  let drawCalls = 0;

  for (const layer of scene.layers.flatten()) {
    if (!scene.layers.isEffectivelyVisible(layer)) continue;
    if (layer.kind === 'raster') {
      if (scene.getMediaSource(layer.sourceId)) {
        const media = collectMedia(scene, layer, transform, pickTable);
        if (media.length > 0) {
          draws.push({ type: 'media', media });
          drawCalls += media.length;
        }
        continue;
      }
      const tiles = collectTiles(scene, layer, rect, transform, pickTable);
      if (tiles.length > 0) {
        draws.push({ type: 'tiles', tiles });
        drawCalls += tiles.length;
      }
      continue;
    }
    const source = scene.getSourceImpl(layer.sourceId);
    if (!source) continue;
    if (layer.kind === 'labels') {
      const labels = collectLabels(scene, layer, source, rect, origin, scale, pickTable);
      if (labels) {
        draws.push({ type: 'labels', labels });
        instances += labels.length;
        drawCalls += labels.length;
      }
      continue;
    }
    if (layer.kind === 'points') {
      const sprites: SpritePlacement[] = [];
      const batch = collectPoints(scene, layer, source, rect, origin, scale, pickTable, sprites);
      if (batch) {
        draws.push({ type: 'batch', batch });
        instances += batch.count;
        drawCalls++;
      }
      if (sprites.length > 0) {
        draws.push({ type: 'sprites', sprites });
        instances += sprites.length;
        drawCalls += sprites.length;
      }
    } else if (layer.kind === 'lines') {
      const batch = collectLines(scene, layer, source, rect, origin, scale, pickTable);
      if (batch) {
        draws.push({ type: 'batch', batch });
        instances += batch.count;
        drawCalls++;
      }
    } else if (layer.kind === 'fills') {
      const { fill, stroke } = collectFills(scene, layer, source, rect, origin, scale, pickTable);
      if (fill) {
        draws.push({ type: 'batch', batch: fill });
        instances += fill.count / 3;
        drawCalls++;
      }
      if (stroke) {
        draws.push({ type: 'batch', batch: stroke });
        instances += stroke.count;
        drawCalls++;
      }
    }
  }

  return {
    revision: scene.revision,
    view: transform,
    deviceWidth: options.deviceWidth,
    deviceHeight: options.deviceHeight,
    dpr: options.dpr,
    draws,
    pickTable,
    stats: { instances, drawCalls },
  };
}

/* -------------------------------------------------------------------------- */
/* Common per-record helpers                                                   */
/* -------------------------------------------------------------------------- */

interface LayerContext {
  readonly scene: Scene;
  readonly layer: LayerImpl;
  readonly source: SourceImpl;
  readonly zoom: number;
}

function recordRef(ctx: LayerContext, record: SlotRecord): FeatureRef {
  return ctx.source.refOf(record);
}

function overrideFor(ctx: LayerContext, ref: FeatureRef): FeatureOverride | undefined {
  return ctx.layer.overrides.get(ctx.layer.overrideKey(ref));
}

function cullRecord(record: SlotRecord, rect: WorldRect, padding = 0): boolean {
  if (!record.geometry) {
    return (
      record.wx + padding >= rect.minX &&
      record.wx - padding <= rect.maxX &&
      record.wy + padding >= rect.minY &&
      record.wy - padding <= rect.maxY
    );
  }
  const bbox = record.geometry.bbox;
  return (
    bbox[2]! + padding >= rect.minX &&
    bbox[0]! - padding <= rect.maxX &&
    bbox[3]! + padding >= rect.minY &&
    bbox[1]! - padding <= rect.maxY
  );
}

function passRecord(
  ctx: LayerContext,
  record: SlotRecord,
  filter: ReturnType<typeof compileFilter>,
  zoomRange: { min: number; max: number },
): { ref: FeatureRef; override: FeatureOverride | undefined; state: ExpressionContext['state'] } | null {
  if (ctx.zoom < zoomRange.min || ctx.zoom > zoomRange.max) return null;
  if (ctx.layer.namespace !== undefined && record.namespace !== ctx.layer.namespace) return null;
  const state = ctx.scene.state.stateOf(ctx.source, record);
  const ref = recordRef(ctx, record);
  if (!filter({ state, id: record.id }, record.properties)) return null;
  if (ctx.scene.bindings.isTargetHidden(ref)) return null;
  const override = overrideFor(ctx, ref);
  if (override?.visible === false) return null;
  return { ref, override, state };
}

/* -------------------------------------------------------------------------- */
/* Points                                                                      */
/* -------------------------------------------------------------------------- */

function collectPoints(
  scene: Scene,
  layer: LayerImpl,
  source: SourceImpl,
  rect: WorldRect,
  origin: { x: number; y: number },
  scale: number,
  pickTable: PickEntry[],
  sprites: SpritePlacement[],
): PlanBatch | null {
  const style = layer.style as PointsLayerStyle;
  const filter = compileFilter(layer.filter);
  const zoomRange = { min: style.minZoom ?? 0, max: style.maxZoom ?? 24 };
  const ctx: LayerContext = { scene, layer, source, zoom: scene.attachedView.zoom };
  const data: number[] = [];
  let interactiveRecords = 0;
  let needsSort = layer.overrides.size > 0;
  if (!needsSort) {
    // A constant zIndex expression means slots are already ordered.
    needsSort = !(style.zIndex === undefined || typeof style.zIndex === 'object' && style.zIndex.constant);
  }
  const candidates: { record: SlotRecord; z: number; passed: NonNullable<ReturnType<typeof passRecord>> }[] = [];
  source.store.queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY, (record) => {
    if (!cullRecord(record, rect)) return;
    const passed = passRecord(ctx, record, filter, zoomRange);
    if (!passed) return;
    const z = evaluateStyleValue(style.zIndex, 0, {
      properties: record.properties,
      state: passed.state,
      zoom: ctx.zoom,
    }) + (passed.override?.zIndex ?? 0);
    if (z !== 0) needsSort = true;
    candidates.push({ record, z, passed });
  });
  if (candidates.length === 0) return null;
  if (needsSort) candidates.sort((a, b) => a.z - b.z);

  for (const { record, passed } of candidates) {
    const expressionContext: ExpressionContext = {
      properties: record.properties,
      state: passed.state,
      zoom: ctx.zoom,
    };
    // A ready icon asset turns the point into a sprite; while loading or on
    // error the shape below is drawn instead (never a silently empty symbol).
    if (style.icon !== undefined) {
      const rawIcon = evaluateStyleValue(style.icon, '', expressionContext);
      const iconId = typeof rawIcon === 'string' ? rawIcon.trim() : '';
      if (iconId !== '') {
        const asset = ctx.scene.assets.get(iconId);
        if (asset && asset.state === 'ready') {
          const interactive = layer.interactionEnabled && (passed.override?.interactive ?? true);
          if (interactive) interactiveRecords++;
          const pickIndex = pickTable.length;
          pickTable.push({ feature: passed.ref, layerId: layer.id });
          sprites.push({
            sourceId: source.id,
            layerId: layer.id,
            feature: passed.ref,
            assetId: iconId,
            sx: (record.wx - origin.x) * scale,
            sy: (record.wy - origin.y) * scale,
            sizePx: passed.override?.radiusPx ?? evaluateStyleValue(style.iconSize, 0, expressionContext),
            offsetX: style.iconAnchor?.x ?? 0,
            offsetY: style.iconAnchor?.y ?? 0,
            rotate: evaluateStyleValue(style.iconRotate, 0, expressionContext),
            opacity: passed.override?.opacity ?? evaluateStyleValue(style.opacity, 1, expressionContext),
            pickIndex,
            interactive,
          });
          continue;
        }
      }
    }
    const radius = passed.override?.radiusPx ?? evaluateStyleValue(style.radiusPx, 5, expressionContext);
    const color = parseColor(
      passed.override?.color ?? (evaluateStyleValue(style.color, DEFAULT_POINT_COLOR as never, expressionContext) as never),
      DEFAULT_POINT_COLOR,
    );
    const opacity = passed.override?.opacity ?? evaluateStyleValue(style.opacity, 1, expressionContext);
    const shapeName = evaluateStyleValue(style.shape, 'circle' as const, expressionContext);
    const strokeWidth = evaluateStyleValue(style.strokeWidthPx, 0, expressionContext);
    const strokeColor = parseColor(
      evaluateStyleValue(style.strokeColor, undefined as never, expressionContext) as never,
      TRANSPARENT,
    );
    const interactive = layer.interactionEnabled && (passed.override?.interactive ?? true);
    if (interactive) interactiveRecords++;

    const push = (sx: number, sy: number, rx: number, ry: number): void => {
      const pickIndex = pickTable.length;
      pickTable.push({ feature: passed.ref, layerId: layer.id });
      data.push(
        sx, sy, rx, ry,
        color[0], color[1], color[2], color[3] * opacity,
        strokeColor[0], strokeColor[1], strokeColor[2], strokeWidth > 0 ? strokeColor[3] || 1 : 0,
        POINT_SHAPES[shapeName as keyof typeof POINT_SHAPES] ?? 0, strokeWidth, pickIndex,
        interactive ? FLAG_INTERACTIVE : 0,
      );
    };

    const payload = record.geometry?.payload;
    if (!payload || payload.kind === GEOMETRY_KIND.point) {
      push((record.wx - origin.x) * scale, (record.wy - origin.y) * scale, radius, radius);
    } else if (payload.kind === GEOMETRY_KIND.multiPoint) {
      for (let i = 0; i < payload.points.length; i += 2) {
        push(
          (payload.points[i]! - origin.x) * scale,
          (payload.points[i + 1]! - origin.y) * scale,
          radius,
          radius,
        );
      }
    } else if (payload.kind === GEOMETRY_KIND.circle) {
      push(
        (payload.wx - origin.x) * scale,
        (payload.wy - origin.y) * scale,
        payload.worldRx * scale,
        payload.worldRy * scale,
      );
    } else {
      push((record.wx - origin.x) * scale, (record.wy - origin.y) * scale, radius, radius);
    }
  }
  void interactiveRecords;
  if (data.length === 0) return null;
  return {
    layerId: layer.id,
    kind: 'points',
    data: Float32Array.from(data),
    count: data.length / POINT_STRIDE,
  };
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

const DEFAULT_LABEL_COLOR: Rgba = [0.12, 0.16, 0.22, 1];
const DEFAULT_LABEL_SIZE = 12;
const DEFAULT_LABEL_FONT = 'system-ui, sans-serif';

/**
 * Labels from the `text` expression (default: the `name` property) anchored at
 * the feature position. With collision enabled, higher priority wins and ties
 * keep the stable slot order, so suppression is deterministic (TEXT-07).
 * Measuring and rasterizing text is the backend's job, never the plan's
 * (TEXT-08: no DOM element per label).
 */
function collectLabels(
  scene: Scene,
  layer: LayerImpl,
  source: SourceImpl,
  rect: WorldRect,
  origin: { x: number; y: number },
  scale: number,
  pickTable: PickEntry[],
): LabelPlacement[] | null {
  const style = layer.style as LabelsLayerStyle;
  const filter = compileFilter(layer.filter);
  const zoomRange = { min: style.minZoom ?? 0, max: style.maxZoom ?? 24 };
  const ctx: LayerContext = { scene, layer, source, zoom: scene.attachedView.zoom };
  const candidates: {
    record: SlotRecord;
    priority: number;
    passed: NonNullable<ReturnType<typeof passRecord>>;
  }[] = [];
  source.store.queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY, (record) => {
    if (!cullRecord(record, rect, 64)) return;
    const passed = passRecord(ctx, record, filter, zoomRange);
    if (!passed) return;
    candidates.push({
      record,
      priority: evaluateStyleValue(style.priority, 0, {
        properties: record.properties,
        state: passed.state,
        zoom: ctx.zoom,
      }),
      passed,
    });
  });
  if (candidates.length === 0) return null;
  if (style.collision) {
    // Stable sort: equal priorities keep the slot order (STYLE-08/TEXT-07).
    candidates.sort((a, b) => b.priority - a.priority);
  }
  const placements: LabelPlacement[] = [];
  for (const { record, passed } of candidates) {
    const expressionContext: ExpressionContext = {
      properties: record.properties,
      state: passed.state,
      zoom: ctx.zoom,
    };
    const raw =
      style.text === undefined
        ? (record.properties as Record<string, unknown>)['name']
        : evaluateStyleValue(style.text, null, expressionContext);
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (text.length === 0) continue;
    const sizePx = Math.max(
      1,
      evaluateStyleValue(style.sizePx, DEFAULT_LABEL_SIZE, expressionContext),
    );
    const color = parseColor(
      passed.override?.color ??
        (evaluateStyleValue(style.color, DEFAULT_LABEL_COLOR as never, expressionContext) as never),
      DEFAULT_LABEL_COLOR,
    );
    const opacity = passed.override?.opacity ?? 1;
    const interactive = layer.interactionEnabled && (passed.override?.interactive ?? true);
    const pickIndex = pickTable.length;
    pickTable.push({ feature: passed.ref, layerId: layer.id });
    placements.push({
      sourceId: source.id,
      layerId: layer.id,
      feature: passed.ref,
      text,
      sizePx,
      fontFamily: style.fontFamily ?? DEFAULT_LABEL_FONT,
      direction: style.direction ?? 'ltr',
      color: [color[0], color[1], color[2], color[3] * opacity],
      offsetX: style.offsetPx?.x ?? 0,
      offsetY: style.offsetPx?.y ?? 0,
      rotate: evaluateStyleValue(style.rotate, 0, expressionContext),
      collision: style.collision === true,
      pickIndex,
      interactive,
      sx: (record.wx - origin.x) * scale,
      sy: (record.wy - origin.y) * scale,
    });
  }
  return placements.length > 0 ? placements : null;
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                       */
/* -------------------------------------------------------------------------- */

function collectLines(
  scene: Scene,
  layer: LayerImpl,
  source: SourceImpl,
  rect: WorldRect,
  origin: { x: number; y: number },
  scale: number,
  pickTable: PickEntry[],
): PlanBatch | null {
  const style = layer.style as LinesLayerStyle;
  const filter = compileFilter(layer.filter);
  const zoomRange = { min: style.minZoom ?? 0, max: style.maxZoom ?? 24 };
  const ctx: LayerContext = { scene, layer, source, zoom: scene.attachedView.zoom };
  const data: number[] = [];
  let needsSort = layer.overrides.size > 0;
  const candidates: { record: SlotRecord; z: number; passed: NonNullable<ReturnType<typeof passRecord>> }[] = [];
  source.store.queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY, (record) => {
    if (!cullRecord(record, rect, 64)) return;
    const passed = passRecord(ctx, record, filter, zoomRange);
    if (!passed) return;
    const z = evaluateStyleValue(style.zIndex, 0, {
      properties: record.properties,
      state: passed.state,
      zoom: ctx.zoom,
    }) + (passed.override?.zIndex ?? 0);
    if (z !== 0) needsSort = true;
    candidates.push({ record, z, passed });
  });
  if (candidates.length === 0) return null;
  if (needsSort) candidates.sort((a, b) => a.z - b.z);

  for (const { record, passed } of candidates) {
    const expressionContext: ExpressionContext = {
      properties: record.properties,
      state: passed.state,
      zoom: ctx.zoom,
    };
    const width = passed.override?.widthPx ?? evaluateStyleValue(style.widthPx, 2, expressionContext);
    const color = parseColor(
      passed.override?.color ?? (evaluateStyleValue(style.color, DEFAULT_LINE_COLOR as never, expressionContext) as never),
      DEFAULT_LINE_COLOR,
    );
    const opacity = passed.override?.opacity ?? evaluateStyleValue(style.opacity, 1, expressionContext);
    const cap = style.cap === 'butt' ? 0 : 1;
    const interactive = layer.interactionEnabled && (passed.override?.interactive ?? true);
    const pickIndex = pickTable.length;
    pickTable.push({ feature: passed.ref, layerId: layer.id });
    const flags = interactive ? FLAG_INTERACTIVE : 0;

    const pushSegment = (x0: number, y0: number, x1: number, y1: number, arc0: number, len: number): void => {
      data.push(
        x0, y0, x1, y1,
        width, cap, pickIndex, flags,
        color[0], color[1], color[2], color[3] * opacity,
        arc0, len, 0, 0,
      );
    };

    const payload = record.geometry?.payload;
    if (!payload) continue;
    const emitLine = (vertices: Float64Array, start: number, count: number, close: boolean): void => {
      let arc = 0;
      for (let i = 0; i < count - 1; i++) {
        const a = (start + i) * 2;
        const b = (start + i + 1) * 2;
        const x0 = (vertices[a]! - origin.x) * scale;
        const y0 = (vertices[a + 1]! - origin.y) * scale;
        const x1 = (vertices[b]! - origin.x) * scale;
        const y1 = (vertices[b + 1]! - origin.y) * scale;
        const len = Math.hypot(x1 - x0, y1 - y0);
        pushSegment(x0, y0, x1, y1, arc, len);
        arc += len;
      }
      if (close && count > 2) {
        const a = (start + count - 1) * 2;
        const b = start * 2;
        const x0 = (vertices[a]! - origin.x) * scale;
        const y0 = (vertices[a + 1]! - origin.y) * scale;
        const x1 = (vertices[b]! - origin.x) * scale;
        const y1 = (vertices[b + 1]! - origin.y) * scale;
        pushSegment(x0, y0, x1, y1, arc, Math.hypot(x1 - x0, y1 - y0));
      }
    };

    switch (payload.kind) {
      case GEOMETRY_KIND.lineString:
      case GEOMETRY_KIND.multiLineString:
        for (let p = 0; p < payload.parts.length; p += 2) {
          emitLine(payload.vertices, payload.parts[p]!, payload.parts[p + 1]!, false);
        }
        break;
      case GEOMETRY_KIND.polygon:
      case GEOMETRY_KIND.multiPolygon:
        for (let r = 0; r < payload.rings.length; r += 2) {
          emitLine(payload.ringVertices, payload.rings[r]!, payload.rings[r + 1]!, true);
        }
        break;
      case GEOMETRY_KIND.rectangle: {
        const x0 = (payload.minX - origin.x) * scale;
        const y0 = (payload.minY - origin.y) * scale;
        const x1 = (payload.maxX - origin.x) * scale;
        const y1 = (payload.maxY - origin.y) * scale;
        pushSegment(x0, y0, x1, y0, 0, Math.abs(x1 - x0));
        pushSegment(x1, y0, x1, y1, 0, Math.abs(y1 - y0));
        pushSegment(x1, y1, x0, y1, 0, Math.abs(x1 - x0));
        pushSegment(x0, y1, x0, y0, 0, Math.abs(y1 - y0));
        break;
      }
      case GEOMETRY_KIND.circle: {
        const rx = payload.worldRx * scale;
        const ry = payload.worldRy * scale;
        const cx = (payload.wx - origin.x) * scale;
        const cy = (payload.wy - origin.y) * scale;
        const steps = 32;
        for (let i = 0; i < steps; i++) {
          const a0 = (i / steps) * Math.PI * 2;
          const a1 = ((i + 1) / steps) * Math.PI * 2;
          const x0 = cx + Math.cos(a0) * rx;
          const y0 = cy + Math.sin(a0) * ry;
          const x1 = cx + Math.cos(a1) * rx;
          const y1 = cy + Math.sin(a1) * ry;
          pushSegment(x0, y0, x1, y1, 0, Math.hypot(x1 - x0, y1 - y0));
        }
        break;
      }
      default:
        break;
    }
  }
  if (data.length === 0) return null;
  return {
    layerId: layer.id,
    kind: 'lines',
    data: Float32Array.from(data),
    count: data.length / LINE_STRIDE,
    dash: style.dash && style.dash.length > 0 ? style.dash : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Fills                                                                       */
/* -------------------------------------------------------------------------- */

function collectFills(
  scene: Scene,
  layer: LayerImpl,
  source: SourceImpl,
  rect: WorldRect,
  origin: { x: number; y: number },
  scale: number,
  pickTable: PickEntry[],
): { fill: PlanBatch | null; stroke: PlanBatch | null } {
  const style = layer.style as FillsLayerStyle;
  if (style.visible === false) return { fill: null, stroke: null };
  const drawFill = style.fill !== false;
  const filter = compileFilter(layer.filter);
  const zoomRange = { min: style.minZoom ?? 0, max: style.maxZoom ?? 24 };
  const ctx: LayerContext = { scene, layer, source, zoom: scene.attachedView.zoom };
  const fillData: number[] = [];
  const strokeData: number[] = [];
  let needsSort = layer.overrides.size > 0;
  const candidates: { record: SlotRecord; z: number; passed: NonNullable<ReturnType<typeof passRecord>> }[] = [];
  source.store.queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY, (record) => {
    if (!cullRecord(record, rect, 128)) return;
    const passed = passRecord(ctx, record, filter, zoomRange);
    if (!passed) return;
    const z = evaluateStyleValue(style.zIndex, 0, {
      properties: record.properties,
      state: passed.state,
      zoom: ctx.zoom,
    }) + (passed.override?.zIndex ?? 0);
    if (z !== 0) needsSort = true;
    candidates.push({ record, z, passed });
  });
  if (candidates.length === 0) return { fill: null, stroke: null };
  if (needsSort) candidates.sort((a, b) => a.z - b.z);

  for (const { record, passed } of candidates) {
    const expressionContext: ExpressionContext = {
      properties: record.properties,
      state: passed.state,
      zoom: ctx.zoom,
    };
    const fillColor = parseColor(
      passed.override?.fillColor ?? (evaluateStyleValue(style.fillColor, DEFAULT_FILL_COLOR as never, expressionContext) as never),
      DEFAULT_FILL_COLOR,
    );
    const fillOpacity = passed.override?.fillOpacity ?? evaluateStyleValue(style.fillOpacity, 1, expressionContext);
    const strokeColor = parseColor(
      passed.override?.color ?? (evaluateStyleValue(style.strokeColor, DEFAULT_STROKE_COLOR as never, expressionContext) as never),
      DEFAULT_STROKE_COLOR,
    );
    const strokeWidth = passed.override?.widthPx ?? evaluateStyleValue(style.strokeWidthPx, 1, expressionContext);
    const interactive = layer.interactionEnabled && (passed.override?.interactive ?? true);
    const pickIndex = pickTable.length;
    pickTable.push({ feature: passed.ref, layerId: layer.id });
    const flags = interactive ? FLAG_INTERACTIVE : 0;
    const toScreen = (x: number, y: number): [number, number] => [
      (x - origin.x) * scale,
      (y - origin.y) * scale,
    ];
    const pushTriangle = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void => {
      fillData.push(
        ax, ay, 0, 0,
        fillColor[0], fillColor[1], fillColor[2], fillColor[3] * fillOpacity,
        pickIndex, flags, 0, 0,
        bx, by, 0, 0,
        fillColor[0], fillColor[1], fillColor[2], fillColor[3] * fillOpacity,
        pickIndex, flags, 0, 0,
        cx, cy, 0, 0,
        fillColor[0], fillColor[1], fillColor[2], fillColor[3] * fillOpacity,
        pickIndex, flags, 0, 0,
      );
    };
    const pushRingStroke = (vertices: Float64Array, start: number, count: number): void => {
      for (let i = 0; i < count; i++) {
        const a = (start + i) * 2;
        const b = (start + ((i + 1) % count)) * 2;
        const [x0, y0] = toScreen(vertices[a]!, vertices[a + 1]!);
        const [x1, y1] = toScreen(vertices[b]!, vertices[b + 1]!);
        strokeData.push(
          x0, y0, x1, y1,
          strokeWidth, 1, pickIndex, flags,
          strokeColor[0], strokeColor[1], strokeColor[2], strokeColor[3],
          0, Math.hypot(x1 - x0, y1 - y0), 0, 0,
        );
      }
    };

    const payload = record.geometry?.payload;
    if (!payload) continue;
    switch (payload.kind) {
      case GEOMETRY_KIND.polygon:
      case GEOMETRY_KIND.multiPolygon: {
        if (drawFill) {
          const triangles = triangulatePolygonWithHoles(payload.ringVertices, payload.rings, payload.ringOuter);
          for (let i = 0; i < triangles.length; i += 6) {
            const [ax, ay] = toScreen(triangles[i]!, triangles[i + 1]!);
            const [bx, by] = toScreen(triangles[i + 2]!, triangles[i + 3]!);
            const [cx, cy] = toScreen(triangles[i + 4]!, triangles[i + 5]!);
            pushTriangle(ax, ay, bx, by, cx, cy);
          }
        }
        if (strokeWidth > 0) {
          for (let r = 0; r < payload.rings.length; r += 2) {
            pushRingStroke(payload.ringVertices, payload.rings[r]!, payload.rings[r + 1]!);
          }
        }
        break;
      }
      case GEOMETRY_KIND.rectangle: {
        const [x0, y0] = toScreen(payload.minX, payload.minY);
        const [x1, y1] = toScreen(payload.maxX, payload.maxY);
        if (drawFill) {
          pushTriangle(x0, y0, x1, y0, x1, y1);
          pushTriangle(x0, y0, x1, y1, x0, y1);
        }
        if (strokeWidth > 0) {
          const ring = Float64Array.of(
            payload.minX, payload.minY,
            payload.maxX, payload.minY,
            payload.maxX, payload.maxY,
            payload.minX, payload.maxY,
          );
          pushRingStroke(ring, 0, 4);
        }
        break;
      }
      case GEOMETRY_KIND.circle: {
        const rx = payload.worldRx * scale;
        const ry = payload.worldRy * scale;
        const cx = (payload.wx - origin.x) * scale;
        const cy = (payload.wy - origin.y) * scale;
        const steps = 32;
        if (drawFill) {
          for (let i = 0; i < steps; i++) {
            const a0 = (i / steps) * Math.PI * 2;
            const a1 = ((i + 1) / steps) * Math.PI * 2;
            pushTriangle(
              cx, cy,
              cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry,
              cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry,
            );
          }
        }
        break;
      }
      default:
        // Fill layers ignore point and line geometry.
        break;
    }
  }
  return {
    fill:
      fillData.length > 0
        ? { layerId: layer.id, kind: 'fills', data: Float32Array.from(fillData), count: fillData.length / FILL_STRIDE }
        : null,
    stroke:
      strokeData.length > 0
        ? {
            layerId: layer.id,
            kind: 'lines',
            data: Float32Array.from(strokeData),
            count: strokeData.length / LINE_STRIDE,
            dash: style.dash && style.dash.length > 0 ? style.dash : null,
          }
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Media sources (images/video placed into bounds)                             */
/* -------------------------------------------------------------------------- */

function collectMedia(
  scene: Scene,
  layer: LayerImpl,
  transform: ViewTransform,
  pickTable: PickEntry[],
): MediaPlacement[] {
  const source = scene.getMediaSource(layer.sourceId);
  if (!source || !source.hasPixels()) return [];
  const style = layer.style as RasterLayerStyle;
  const opacity = style.opacity ?? 1;
  const scale = worldScaleAt(transform.zoom);
  const origin = transformOrigin(transform);
  const southWest = scene.crs.toWorld(source.bounds.southwest as never);
  const northEast = scene.crs.toWorld(source.bounds.northeast as never);
  const minX = Math.min(southWest.x, northEast.x);
  const maxX = Math.max(southWest.x, northEast.x);
  const minY = Math.min(southWest.y, northEast.y);
  const maxY = Math.max(southWest.y, northEast.y);
  const sx = (minX - origin.x) * scale;
  const sy = (minY - origin.y) * scale;
  const ex = (maxX - origin.x) * scale;
  const ey = (maxY - origin.y) * scale;
  const margin = 32;
  if (ex < -margin || ey < -margin || sx > transform.width + margin || sy > transform.height + margin) {
    return [];
  }
  const placement: MediaPlacement = {
    sourceId: source.id,
    layerId: layer.id,
    kind: source.kind,
    sx,
    sy,
    sw: ex - sx,
    sh: ey - sy,
    opacity,
  };
  if (!layer.interactionEnabled) return [placement];
  // One record per media source, never per pixel: the image/video keeps its own
  // identity and interactive area (the quad) in the pick table.
  const pickIndex = pickTable.length;
  pickTable.push({
    feature: { sceneId: scene.id, sourceId: source.id, id: source.id, generation: 0 },
    layerId: layer.id,
  });
  return [{ ...placement, pickIndex }];
}

/* -------------------------------------------------------------------------- */
/* Raster tiles                                                                */
/* -------------------------------------------------------------------------- */

function collectTiles(
  scene: Scene,
  layer: LayerImpl,
  rect: WorldRect,
  transform: ViewTransform,
  pickTable: PickEntry[],
): TilePlacement[] {
  const source = scene.getRasterSource(layer.sourceId);
  if (!source) return [];
  const style = layer.style as RasterLayerStyle;
  const opacity = style.opacity ?? 1;
  const scale = worldScaleAt(transform.zoom);
  const origin = transformOrigin(transform);
  const screenOf = (worldX: number, worldY: number): [number, number] => [
    (worldX - origin.x) * scale,
    (worldY - origin.y) * scale,
  ];
  const out: TilePlacement[] = [];
  // One pick record per raster source: the bitmap provides its displayed area
  // as a single interactive surface and its own identity; no feature id is
  // invented from pixels (WMS-06). Tile layers are opt-in — a basemap is
  // background unless `interaction: { enabled: true }` asks for it, while media
  // overlays keep the layer default.
  let pickIndex: number | undefined;
  if (layer.interactionEnabled && layer.interactionExplicit) {
    pickIndex = pickTable.length;
    pickTable.push({
      feature: { sceneId: scene.id, sourceId: source.id, id: source.id, generation: 0 },
      layerId: layer.id,
    });
  }

  if (source.kind === 'rasterTiles') {
    const options = source.options as RasterTilesOptions;
    const grid = source.tilesGrid();
    const tileZoom = tileZoomForView(transform.zoom, grid);
    const tileWorld = 256 / 2 ** tileZoom;
    const coords = tilesForWorldRect(rect.minX, rect.minY, rect.maxX, rect.maxY, tileZoom, grid.tileSize, {
      wrap: grid.wrap,
      minZoom: grid.minZoom,
      maxZoom: grid.maxZoom,
    });
    for (const coord of coords) {
      const baseX = coord.x * tileWorld;
      const candidateX = baseX + Math.round((rect.minX - baseX) / 256) * 256;
      const x = grid.wrap ? candidateX : baseX;
      const y = coord.y * tileWorld;
      const [sx, sy] = screenOf(x, y);
      const [sx1, sy1] = screenOf(x + tileWorld, y + tileWorld);
      out.push({
        sourceId: source.id,
        layerId: layer.id,
        tileKey: `${coord.z}/${coord.x}/${coord.y}`,
        url: formatTileUrl(options, coord, { tms: grid.tms }),
        sx,
        sy,
        sw: sx1 - sx,
        sh: sy1 - sy,
        opacity,
        sourceRevision: source.revision,
        ...(pickIndex === undefined ? {} : { pickIndex }),
        fallbacks: tileFallbacks(options, grid, coord),
        children: tileChildren(options, grid, coord),
      });
    }
    return out;
  }
  const options = source.options as WmsOptions;
  if (scene.crs.positionKind !== 'geographic') return out;
  const bounds = scene.attachedView.getBounds();
  if (!bounds) return out;
  const width = Math.max(256, Math.ceil(transform.width / 256) * 256);
  const height = Math.max(256, Math.ceil(transform.height / 256) * 256);
  const request = wmsGetMapUrl(options, bounds as GeoBounds, width, height);
  const southwest = scene.crs.toWorld(bounds.southwest);
  const northeast = scene.crs.toWorld(bounds.northeast);
  // World y grows southward: the placement rect starts at the north-west
  // corner so width/height stay positive like every other tile placement.
  const [sx, sy] = screenOf(
    Math.min(southwest.x, northeast.x),
    Math.min(southwest.y, northeast.y),
  );
  const [sx1, sy1] = screenOf(
    Math.max(southwest.x, northeast.x),
    Math.max(southwest.y, northeast.y),
  );
  out.push({
    sourceId: source.id,
    layerId: layer.id,
    tileKey: `wms:${sx.toFixed(1)},${sy.toFixed(1)},${(sx1 - sx).toFixed(1)},${(sy1 - sy).toFixed(1)}`,
    url: request.url,
    sx,
    sy,
    sw: sx1 - sx,
    sh: sy1 - sy,
    opacity,
    sourceRevision: source.revision,
    ...(pickIndex === undefined ? {} : { pickIndex }),
    fallbacks: [],
    children: null,
  });
  return out;
}

export function screenPointFromWorld(
  transform: ViewTransform,
  worldX: number,
  worldY: number,
): ScreenPoint {
  const scale = worldScaleAt(transform.zoom);
  const origin = transformOrigin(transform);
  return { x: (worldX - origin.x) * scale, y: (worldY - origin.y) * scale };
}
