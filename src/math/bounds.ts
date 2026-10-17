/**
 * Bounds over `GeoPosition` (geographic CRS) or `PlanarPosition` (Simple).
 *
 * Empty bounds are represented explicitly as `null`, never as +/-Infinity corners.
 * Geographic bounds can cross the antimeridian; `crossesAntimeridian` decides how
 * `west`/`east` and containment are interpreted. MATH-11, MATH-12.
 */

import { fail } from '../api/errors.ts';
import type { GeoPosition, PlanarPosition, Position } from '../api/types.ts';
import { isGeoPosition, isPlanarPosition } from '../api/types.ts';
import { wrapLongitude } from './crs.ts';

export interface Bounds<P extends Position = GeoPosition> {
  readonly southwest: P;
  readonly northeast: P;
  /** Geographic bounds only: the interval runs from west (east of 180) to east (west of -180). */
  readonly crossesAntimeridian?: boolean;
}

export type GeoBounds = Bounds<GeoPosition>;
export type PlanarBounds = Bounds<PlanarPosition>;

export interface ExtendBoundsOptions {
  /** Allow the tightest wrap-around longitude interval. Defaults to `false`. MATH-12. */
  readonly wrapAntimeridian?: boolean;
}

export function isGeoBounds(bounds: Bounds<Position>): bounds is GeoBounds {
  return isGeoPosition(bounds.southwest);
}

export function isPlanarBounds(bounds: Bounds<Position>): bounds is PlanarBounds {
  return isPlanarPosition(bounds.southwest);
}

export function boundsFromPositions(
  positions: readonly Position[],
  options?: ExtendBoundsOptions,
): Bounds<Position> | null {
  if (positions.length === 0) return null;
  const first = positions[0]!;
  if (isGeoPosition(first)) {
    return geoBoundsFromPositions(positions, options);
  }
  if (isPlanarPosition(first)) {
    return planarBoundsFromPositions(positions);
  }
  fail('invalid-argument', 'positions must be geographic or planar, not mixed');
}

function geoBoundsFromPositions(
  positions: readonly Position[],
  options?: ExtendBoundsOptions,
): GeoBounds {
  let minLat = Infinity;
  let maxLat = -Infinity;
  const lngs: number[] = [];
  for (const position of positions) {
    if (!isGeoPosition(position)) {
      fail('invalid-argument', 'positions must not mix geographic and planar values');
    }
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
      fail('invalid-argument', 'position coordinates must be finite', { position });
    }
    const lat = position.lat;
    const lng = position.lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    lngs.push(lng);
  }
  if (!options?.wrapAntimeridian) {
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const lng of lngs) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    return {
      southwest: { lat: minLat, lng: minLng },
      northeast: { lat: maxLat, lng: maxLng },
    };
  }
  const [west, east, crosses] = tightestLongitudeInterval(lngs);
  const base: GeoBounds = {
    southwest: { lat: minLat, lng: west },
    northeast: { lat: maxLat, lng: east },
  };
  return crosses ? { ...base, crossesAntimeridian: true } : base;
}

function planarBoundsFromPositions(positions: readonly Position[]): PlanarBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const position of positions) {
    if (!isPlanarPosition(position)) {
      fail('invalid-argument', 'positions must not mix geographic and planar values');
    }
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      fail('invalid-argument', 'position coordinates must be finite', { position });
    }
    const x = position.x;
    const y = position.y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    southwest: { x: minX, y: minY },
    northeast: { x: maxX, y: maxY },
  };
}

/**
 * Tightest longitude interval covering all values: largest circular gap is excluded.
 * Returns `[west, east, crossesAntimeridian]`.
 */
export function tightestLongitudeInterval(lngs: readonly number[]): [number, number, boolean] {
  if (lngs.length === 0) {
    fail('invalid-argument', 'cannot compute a longitude interval of an empty set');
  }
  if (lngs.length === 1) {
    const lng = wrapLongitude(lngs[0]!);
    return [lng, lng, false];
  }
  const sorted = lngs.map((lng) => wrapLongitude(lng)).sort((a, b) => a - b);
  // The largest circular gap is excluded; the interval runs from the end of that
  // gap eastwards to its start.
  let gapEnd = sorted[0]!;
  let gap = sorted[0]! + 360 - sorted[sorted.length - 1]!;
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i]! - sorted[i - 1]!;
    if (delta > gap) {
      gap = delta;
      gapEnd = sorted[i]!;
    }
  }
  const west = wrapLongitude(gapEnd);
  const east = wrapLongitude(gapEnd + (360 - gap));
  const span = 360 - gap;
  const crosses = span > 0 && east < west;
  return [west, east, crosses];
}

/** Longitude span in degrees, 0..360. */
export function boundsLongitudeSpan(bounds: GeoBounds): number {
  const { southwest, northeast } = bounds;
  if (bounds.crossesAntimeridian) {
    return (((northeast.lng - southwest.lng) % 360) + 360) % 360;
  }
  return northeast.lng - southwest.lng;
}

export function boundsCenter<P extends Position>(bounds: Bounds<P>): P {
  const { southwest, northeast } = bounds;
  if (isGeoPosition(southwest) && isGeoPosition(northeast)) {
    const span = boundsLongitudeSpan(bounds as GeoBounds);
    return {
      lat: (southwest.lat + northeast.lat) / 2,
      lng: wrapLongitude(southwest.lng + span / 2),
    } as P;
  }
  const sw = southwest as PlanarPosition;
  const ne = northeast as PlanarPosition;
  return { x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2 } as P;
}

export function boundsSize<P extends Position>(
  bounds: Bounds<P>,
): { readonly width: number; readonly height: number } {
  const { southwest, northeast } = bounds;
  if (isGeoPosition(southwest) && isGeoPosition(northeast)) {
    return {
      width: boundsLongitudeSpan(bounds as GeoBounds),
      height: northeast.lat - southwest.lat,
    };
  }
  const sw = southwest as PlanarPosition;
  const ne = northeast as PlanarPosition;
  return { width: ne.x - sw.x, height: ne.y - sw.y };
}

export function boundsContains(bounds: Bounds<Position>, position: Position): boolean {
  if (isGeoBounds(bounds) && isGeoPosition(position)) {
    if (position.lat < bounds.southwest.lat || position.lat > bounds.northeast.lat) {
      return false;
    }
    const lng = position.lng;
    if (bounds.crossesAntimeridian) {
      return lng >= bounds.southwest.lng || lng <= bounds.northeast.lng;
    }
    return lng >= bounds.southwest.lng && lng <= bounds.northeast.lng;
  }
  if (isPlanarBounds(bounds) && isPlanarPosition(position)) {
    return (
      position.x >= bounds.southwest.x &&
      position.x <= bounds.northeast.x &&
      position.y >= bounds.southwest.y &&
      position.y <= bounds.northeast.y
    );
  }
  fail('invalid-argument', 'bounds and position types must match');
}

export function boundsIntersect(a: Bounds<Position>, b: Bounds<Position>): boolean {
  if (isGeoBounds(a) && isGeoBounds(b)) {
    if (a.southwest.lat > b.northeast.lat || b.southwest.lat > a.northeast.lat) return false;
    return longitudeIntervalsIntersect(a, b);
  }
  if (isPlanarBounds(a) && isPlanarBounds(b)) {
    return !(
      a.southwest.x > b.northeast.x ||
      b.southwest.x > a.northeast.x ||
      a.southwest.y > b.northeast.y ||
      b.southwest.y > a.northeast.y
    );
  }
  fail('invalid-argument', 'bounds must be of the same kind');
}

function longitudeIntervalsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  const intervals = (bounds: GeoBounds): [number, number][] => {
    if (bounds.crossesAntimeridian) {
      return [
        [bounds.southwest.lng, 180],
        [-180, bounds.northeast.lng],
      ];
    }
    return [[bounds.southwest.lng, bounds.northeast.lng]];
  };
  for (const [a0, a1] of intervals(a)) {
    for (const [b0, b1] of intervals(b)) {
      if (a0 <= b1 && b0 <= a1) return true;
    }
  }
  return false;
}

export function mergeBounds(
  a: Bounds<Position> | null,
  b: Bounds<Position> | null,
  options?: ExtendBoundsOptions,
): Bounds<Position> | null {
  if (!a) return b;
  if (!b) return a;
  const positions: Position[] = [];
  for (const bounds of [a, b]) {
    if (isGeoBounds(bounds)) {
      const { southwest, northeast } = bounds;
      positions.push(southwest, northeast);
      if (bounds.crossesAntimeridian) {
        positions.push({ lat: southwest.lat, lng: 180 }, { lat: northeast.lat, lng: -180 });
      }
    } else {
      positions.push(bounds.southwest, bounds.northeast);
    }
  }
  return boundsFromPositions(positions, options);
}

export function extendBounds(
  bounds: Bounds<Position> | null,
  position: Position,
  options?: ExtendBoundsOptions,
): Bounds<Position> {
  return mergeBounds(bounds, boundsFromPositions([position], options), options)!;
}
