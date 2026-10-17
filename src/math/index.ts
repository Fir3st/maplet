/**
 * DOM-free math entry point (`maplet/math`).
 *
 * Importing this module never touches `document`, `navigator` or the GPU. It is
 * usable in Node, workers and server-side code. DIST-05.
 */

export {
  crs,
  wrapLongitude,
  wrapLatitude,
  haversineMeters,
  lngToUnitX,
  unitXToLng,
  latToUnitY,
  unitYToLat,
  WORLD_SCALE,
  EARTH_RADIUS_METERS,
  MAX_MERCATOR_LATITUDE,
  MAX_ELLIPSOIDAL_LATITUDE,
} from './crs.ts';
export type { Crs, CustomCrsSpec, Distance, DistanceUnit } from './crs.ts';
export {
  boundsFromPositions,
  boundsCenter,
  boundsSize,
  boundsContains,
  boundsIntersect,
  boundsLongitudeSpan,
  mergeBounds,
  extendBounds,
  tightestLongitudeInterval,
  isGeoBounds,
} from './bounds.ts';
export type { Bounds, GeoBounds, PlanarBounds, ExtendBoundsOptions } from './bounds.ts';
export { distanceBetween, metersPerPixel, scaleBar } from './measure.ts';
export type { ScaleBar } from './measure.ts';
export {
  worldScaleAt,
  transformOrigin,
  worldToScreenAtOrigin,
  screenToWorldAtOrigin,
  positionToWorld,
  worldToPosition,
  positionToScreen,
  screenToPosition,
  worldUnitScreenSize,
  metricCircleScreenRadius,
} from './transform.ts';
export type { ViewTransform } from './transform.ts';
export type {
  GeoPosition,
  PlanarPosition,
  Position,
  ScreenPoint,
  WorldPoint,
  FeatureId,
} from '../api/types.ts';
