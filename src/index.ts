/**
 * Maplet public facade.
 *
 * Importing this module never touches `document`, `navigator` or the GPU; only
 * `createMap` with a GPU renderer requires a browser environment (DIST-05,
 * MAP-07). Pure math lives in the `maplet/math` subpath.
 */

export { createMap } from './map.ts';
export { gestureGuard, type GestureGuardApi, type GestureGuardOptions, type GestureModifier } from './plugins/gesture-guard.ts';
export { fullscreenMode, type FullscreenApi, type FullscreenControlOptions, type FullscreenOptions } from './plugins/display-mode.ts';
export { heatmap, type HeatPoint, type HeatmapApi, type HeatmapOptions, type HeatmapUpdate } from './plugins/heatmap.ts';
export type { GestureGate, GestureKind, GestureRequest } from './interaction/interaction.ts';
export type { Plugin, PluginContext, PluginHandle } from './plugins.ts';
export type { CustomRenderer, RenderFrame, RenderHandle } from './render/extensions.ts';
export {
  POINT_STRIDE,
  LINE_STRIDE,
  FILL_STRIDE,
  POINT_SHAPES,
  FLAG_INTERACTIVE,
  FLAG_HIDDEN,
  PlanPickTable,
} from './render/frame-plan.ts';
export type {
  FramePlan,
  PlanBatch,
  DrawItem,
  PickEntry,
  PickEntries,
  BufferUpload,
  TilePlacement,
  TileFallback,
  LabelPlacement,
  SpritePlacement,
  MediaPlacement,
  SymbolTransform,
  SymbolAppearance,
} from './render/frame-plan.ts';
export type {
  MarkerContent,
  MarkerHandle,
  MarkerOptions,
  MarkerPopupInit,
  MarkerPopupOptions,
  MarkerTooltipInit,
  MarkerTooltipOptions,
} from './ui/markers.ts';
export type {
  AreaQueryOptions,
  AreaQueryResult,
  AssetsHandle,
  BindingsHandle,
  ControlHandle,
  ControlKind,
  ControlLayerEntry,
  ControlPosition,
  ControlSpec,
  DetailContent,
  DetailContentFactory,
  DetailHandle,
  DetailOptions,
  DetailServiceHandle,
  LayerHandle,
  LayerContent,
  LayerEntry,
  LayersHandle,
  SourceLayerSpec,
  RenderLayerHandle,
  ListControlOptions,
  LocateErrorCode,
  LocateHandle,
  LocateOptions,
  LocateResult,
  LocateWatch,
  LocateWatchOptions,
  LocatedPosition,
  MapHandle,
  MapOptions,
  QueryCursor,
  QueryHandle,
  RelationsHandle,
  RendererOptions,
  SelectionHandle,
  SourcesHandle,
  StateHandle,
  FeatureHandle,
  PointHandle,
  LineHandle,
  PolygonHandle,
  LayerOptions,
  ObjectOptions,
  PointInput,
  LineInput,
  PolygonInput,
  PointsLayerHandle,
  LinesLayerHandle,
  PolygonsLayerHandle,
  VectorLayerHandle,
  RasterLayerHandle,
  TilesOptions,
  WmsLayerOptions,
  PositionInput,
  FeatureEvent,
  FeatureEvents,
  MapClickEvent,
  MapEventTypes,
} from './map.ts';

export { crs, wrapLongitude, wrapLatitude, haversineMeters } from './math/crs.ts';
export type { Crs, CustomCrsSpec, Distance, DistanceUnit } from './math/crs.ts';
export type {
  Bounds,
  GeoBounds,
  PlanarBounds,
} from './math/bounds.ts';
export { style } from './api/style.ts';
export type { Expression, ExpressionInput, ColorValue, Filter, FilterExpression, TypedField } from './scene/expression.ts';

export { MapletError, isMapletError } from './api/errors.ts';
export type { MapletErrorCode } from './api/errors.ts';

export type {
  BackendKind,
  Capabilities,
  CircleGeometry,
  Commit,
  FeatureId,
  FeatureProperties,
  FeatureRef,
  FeatureSnapshot,
  GeoPosition,
  Geometry,
  LineStringGeometry,
  MapStats,
  MapFeatureEvent,
  MapPointerEvent,
  FeatureEventType,
  MultiLineStringGeometry,
  MultiPointGeometry,
  MultiPolygonGeometry,
  PickStallStats,
  PlanarPosition,
  PointGeometry,
  PolygonGeometry,
  Position,
  RectangleGeometry,
  ScreenPoint,
  SubscribeOptions,
  Unsubscribe,
  WorldPoint,
} from './api/types.ts';

export type {
  FeatureInput,
  FeaturePatch,
  FeatureQueryOptions,
  ColumnarImportOptions,
  SourceChange,
  SourceSnapshot,
  VectorSourceHandle,
  FeaturesHandle,
} from './scene/source.ts';
export type {
  ColumnarBatch,
  ColumnarIndexArray,
  ColumnarKind,
  ColumnarPartsBatch,
  ColumnarPointBatch,
  ColumnarPositionArray,
  ColumnarPositionKind,
  ColumnarToFeaturesOptions,
} from './io/columnar.ts';
export { columnarToFeatures } from './io/columnar.ts';
export type { ImportPipelineDebug, ImportWorkerLike } from './io/import-pipeline.ts';
export type { RasterSourceHandle, RasterSourceSnapshot } from './scene/raster-source.ts';
export type { ImageAssetHandle, ImageAssetSnapshot, ImageAssetState } from './scene/assets.ts';
export type {
  FontAssetHandle,
  FontAssetSnapshot,
  FontAssetState,
} from './scene/assets.ts';
export type {
  ImageSourceOptions,
  MediaBounds,
  MediaPixelData,
  MediaRegion,
  MediaSourceHandle,
  MediaSourceKind,
  MediaSourceSnapshot,
  MediaState,
  VideoSourceOptions,
} from './scene/media-source.ts';
export type { RasterTilesOptions, TileCoord, WmsOptions } from './formats/raster.ts';
export type {
  TileFetch,
  TileFetchResponse,
  VectorTilesFeaturesHandle,
  VectorTilesOptions,
  VectorTilesSourceHandle,
  VectorTilesSourceSnapshot,
  VectorTilesStats,
} from './scene/vector-tile-source.ts';
export type {
  MvtDecodeOptions,
  MvtDecodeResult,
  MvtFeature,
  MvtGeometry,
  MvtLayer,
  MvtLineGeometry,
  MvtPointGeometry,
  MvtPolygonGeometry,
  MvtTile,
} from './formats/mvt.ts';
export { decodeMvtTile } from './formats/mvt.ts';
export type { GeoJsonFeatureCollection } from './formats/geojson.ts';
export { parseGeoJson, featuresToGeoJson } from './formats/geojson.ts';
export type { EndpointPolicy, RelationInput, RelationSnapshot, NeighborOptions, TraverseOptions } from './scene/relations.ts';
export type { BindingInput, BindingSnapshot, GeometryBindingDescriptor, CopyPropertyDescriptor, OnMissingPolicy } from './scene/bindings.ts';
export type { FeatureState, FeatureStatePatch } from './scene/state.ts';
export type {
  LayerKind,
  LayerSpec,
  PointsLayerStyle,
  LinesLayerStyle,
  FillsLayerStyle,
  LabelsLayerStyle,
  RasterLayerStyle,
  FeatureOverride,
  MoveTarget,
  PointShape,
} from './scene/layers.ts';
export type { PickResult } from './render/picking.ts';
export { defaultClock } from './view/view.ts';
export type { Clock, FitOptions, FlyOptions, FitPadding, ViewSnapshot, ViewUpdate } from './view/view.ts';

export const version = '0.1.0-alpha.8';
