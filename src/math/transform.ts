/**
 * View transform math: position <-> world <-> screen.
 *
 * World coordinates have scale 256 at zoom 0 (see crs.ts). The screen origin is the
 * view center minus half the container size; the y axis grows south/downward.
 * All math here is double precision; the renderer subtracts chunk origins before
 * converting to float32. VIEW-05, VIEW-08, MATH-08, SPACE-05.
 */

import type { Position, ScreenPoint, WorldPoint } from '../api/types.ts';
import { EARTH_RADIUS_METERS, WORLD_SCALE, type Crs } from './crs.ts';

export function worldScaleAt(zoom: number): number {
  return Math.pow(2, zoom);
}

export interface ViewTransform {
  readonly crs: Crs;
  /** CSS pixel size of the container. */
  readonly width: number;
  readonly height: number;
  readonly centerWorld: WorldPoint;
  readonly zoom: number;
}

export function transformOrigin(transform: ViewTransform): WorldPoint {
  const scale = worldScaleAt(transform.zoom);
  return {
    x: transform.centerWorld.x - transform.width / (2 * scale),
    y: transform.centerWorld.y - transform.height / (2 * scale),
  };
}

export function worldToScreenAtOrigin(
  world: WorldPoint,
  origin: WorldPoint,
  zoom: number,
): ScreenPoint {
  const scale = worldScaleAt(zoom);
  return {
    x: (world.x - origin.x) * scale,
    y: (world.y - origin.y) * scale,
  };
}

export function screenToWorldAtOrigin(
  screen: ScreenPoint,
  origin: WorldPoint,
  zoom: number,
): WorldPoint {
  const scale = worldScaleAt(zoom);
  return {
    x: origin.x + screen.x / scale,
    y: origin.y + screen.y / scale,
  };
}

export function positionToWorld(crs: Crs, position: Position): WorldPoint {
  return crs.toWorld(position);
}

export function worldToPosition(crs: Crs, world: WorldPoint): Position {
  return crs.fromWorld(world);
}

export function positionToScreen(transform: ViewTransform, position: Position): ScreenPoint {
  const origin = transformOrigin(transform);
  return worldToScreenAtOrigin(transform.crs.toWorld(position), origin, transform.zoom);
}

export function screenToPosition(transform: ViewTransform, screen: ScreenPoint): Position {
  const origin = transformOrigin(transform);
  return transform.crs.fromWorld(screenToWorldAtOrigin(screen, origin, transform.zoom));
}

/**
 * CSS pixel size (width, height) of one CRS unit at the given zoom, used for
 * circle-in-meters conversion and scale display. Geographic CRS use the local
 * latitude scale; Simple keeps its planar units.
 */
export function worldUnitScreenSize(transform: ViewTransform): number {
  return worldScaleAt(transform.zoom) / WORLD_SCALE;
}

/** Screen-space radii of a metric circle at a position, in CSS px. */
export function metricCircleScreenRadius(
  crs: Crs,
  center: Position,
  radiusMeters: number,
  zoom: number,
): { readonly rx: number; readonly ry: number } {
  if (crs.positionKind !== 'geographic') {
    // Planar radius in CRS units; one unit is WORLD_SCALE world units.
    const size = WORLD_SCALE * worldScaleAt(zoom);
    return { rx: radiusMeters * size, ry: radiusMeters * size };
  }
  const geo = center as { lat: number; lng: number };
  // Local metric scale of a sphere: metres per degree.
  const metersPerDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;
  const latRad = (geo.lat * Math.PI) / 180;
  const cosLat = Math.max(Math.cos(latRad), 1e-6);
  const degLat = radiusMeters / metersPerDegree;
  const degLng = radiusMeters / (metersPerDegree * cosLat);
  // Convert degrees to world-space offsets through the CRS itself.
  const scale = Math.pow(2, zoom);
  const centerWorld = crs.toWorld(center);
  const latEdgeWorld = crs.toWorld({ lat: geo.lat + degLat, lng: geo.lng });
  const lngEdgeWorld = crs.toWorld({ lat: geo.lat, lng: geo.lng + degLng });
  return {
    rx: Math.abs(lngEdgeWorld.x - centerWorld.x) * scale,
    ry: Math.abs(latEdgeWorld.y - centerWorld.y) * scale,
  };
}
