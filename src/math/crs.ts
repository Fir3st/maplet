/**
 * Coordinate reference systems.
 *
 * Each CRS maps its own position type to Maplet world coordinates at zoom 0 with
 * scale 256 (`WORLD_SCALE`). Screen position at a fractional zoom z is
 * `world * 2^z - viewOrigin`. This is the same scale convention as Leaflet:
 * "256 x 2^zoom". Web Mercator formulas follow Leaflet 1.9.4
 * (`L.Projection.SphericalMercator`); other CRS use their own documented math and
 * are not implied to be numerically identical to Leaflet's pixels.
 *
 * Provenance: see NOTICE. Derived formulas retain the BSD-2-Clause attribution of
 * Leaflet, Copyright (c) 2010-2023 Volodymyr Agafonkin.
 */

import { fail } from '../api/errors.ts';
import type { GeoPosition, PlanarPosition, Position, WorldPoint } from '../api/types.ts';

export const WORLD_SCALE = 256;
export const EARTH_RADIUS_METERS = 6371008.8;
/** Leaflet 1.9.4 SphericalMercator.MAX_LATITUDE. */
export const MAX_MERCATOR_LATITUDE = 85.0511287798;
/** Practical clamp for the ellipsoidal Mercator; the projection is singular at the poles. */
export const MAX_ELLIPSOIDAL_LATITUDE = 89.99;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export type DistanceUnit = 'meters' | 'planarUnits';

export interface Distance {
  readonly value: number;
  readonly unit: DistanceUnit;
}

export interface Crs {
  /** Stable identifier, e.g. `EPSG:3857`. */
  readonly code: string;
  /** Which public position type this CRS accepts. */
  readonly positionKind: 'geographic' | 'planar';
  /** Longitude wraps around the globe (geographic CRS). */
  readonly wraps: boolean;
  /** Supports the XYZ/WMS tile grid described by this CRS. */
  readonly supportsTiling: boolean;
  /** Position (degrees or planar units) to Maplet world coordinates at zoom 0. */
  toWorld(position: Position): WorldPoint;
  /** Maplet world coordinates to the CRS position type. */
  fromWorld(world: WorldPoint): Position;
  /** Validates/clamps/wraps external input into this CRS domain. Throws on non-finite input. */
  normalize(position: Position): Position;
  /** Distance between two positions, in this CRS's natural unit. */
  distance(a: Position, b: Position): Distance;
  /** Longitude wrap for geographic CRS; returns the canonical [-180, 180) value. */
  wrapLongitude(lng: number): number;
  /** Meters at the equator per world unit at zoom 0; only meaningful for geographic CRS. */
  readonly metersPerWorldUnit?: number;
}

/* -------------------------------------------------------------------------- */
/* Spherical Web Mercator (EPSG:3857)                                          */
/* -------------------------------------------------------------------------- */

export function lngToUnitX(lng: number): number {
  return lng / 360 + 0.5;
}

export function unitXToLng(x: number): number {
  return (x - 0.5) * 360;
}

export function latToUnitY(lat: number): number {
  const clamped = Math.max(Math.min(lat, MAX_MERCATOR_LATITUDE), -MAX_MERCATOR_LATITUDE);
  const sin = Math.sin(clamped * DEG2RAD);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

export function unitYToLat(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return RAD2DEG * Math.atan(Math.sinh(n));
}

/* -------------------------------------------------------------------------- */
/* Ellipsoidal Mercator (EPSG:3395, WGS 84)                                    */
/* -------------------------------------------------------------------------- */

const WGS84_A = 6378137;
const WGS84_B = 6356752.314245179;
const WGS84_E = Math.sqrt(1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A));

function ellipsoidalMercatorY(lat: number): number {
  const phi = lat * DEG2RAD;
  const sinPhi = Math.sin(phi);
  const tan = Math.tan(Math.PI / 4 + phi / 2);
  const ecc = Math.pow((1 - WGS84_E * sinPhi) / (1 + WGS84_E * sinPhi), WGS84_E / 2);
  return Math.log(tan * ecc);
}

function ellipsoidalMercatorInvY(y: number): number {
  // Newton iteration on the standard ellipsoidal Mercator inverse:
  // phi = 2*atan(exp(y) * ((1+e*sin(phi))/(1-e*sin(phi)))^(e/2)) - pi/2
  let phi = 2 * Math.atan(Math.exp(y)) - Math.PI / 2;
  for (let i = 0; i < 12; i++) {
    const sinPhi = Math.sin(phi);
    const invEcc = Math.pow((1 + WGS84_E * sinPhi) / (1 - WGS84_E * sinPhi), WGS84_E / 2);
    const next = 2 * Math.atan(Math.exp(y) * invEcc) - Math.PI / 2;
    if (Math.abs(next - phi) < 1e-14) {
      phi = next;
      break;
    }
    phi = next;
  }
  return phi * RAD2DEG;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    fail('invalid-argument', `${what} must be a finite number`, { value });
  }
}

function assertGeo(position: Position): asserts position is GeoPosition {
  if (
    typeof position !== 'object' ||
    position === null ||
    typeof (position as GeoPosition).lat !== 'number' ||
    typeof (position as GeoPosition).lng !== 'number'
  ) {
    fail('invalid-argument', 'expected a geographic position { lat, lng }', { position });
  }
}

function assertPlanar(position: Position): asserts position is PlanarPosition {
  if (
    typeof position !== 'object' ||
    position === null ||
    typeof (position as PlanarPosition).x !== 'number' ||
    typeof (position as PlanarPosition).y !== 'number'
  ) {
    fail('invalid-argument', 'expected a planar position { x, y }', { position });
  }
}

/** Longitude canonicalized into [-180, 180). MATH-05. */
export function wrapLongitude(lng: number): number {
  assertFinite(lng, 'longitude');
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

export function wrapLatitude(lat: number, limit = MAX_MERCATOR_LATITUDE): number {
  assertFinite(lat, 'latitude');
  return Math.max(Math.min(lat, limit), -limit);
}

export function haversineMeters(a: GeoPosition, b: GeoPosition): number {
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const dLat = lat2 - lat1;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function geoDistance(a: Position, b: Position): Distance {
  assertGeo(a);
  assertGeo(b);
  return { value: haversineMeters(a, b), unit: 'meters' };
}

function planarDistance(a: Position, b: Position): Distance {
  assertPlanar(a);
  assertPlanar(b);
  return { value: Math.hypot(b.x - a.x, b.y - a.y), unit: 'planarUnits' };
}

/* -------------------------------------------------------------------------- */
/* CRS instances                                                               */
/* -------------------------------------------------------------------------- */

function createSphericalMercator(): Crs {
  return {
    code: 'EPSG:3857',
    positionKind: 'geographic',
    wraps: true,
    supportsTiling: true,
    metersPerWorldUnit: (2 * Math.PI * 6378137) / WORLD_SCALE,
    toWorld(position) {
      assertGeo(position);
      assertFinite(position.lng, 'longitude');
      assertFinite(position.lat, 'latitude');
      return {
        x: lngToUnitX(position.lng) * WORLD_SCALE,
        y: latToUnitY(position.lat) * WORLD_SCALE,
      };
    },
    fromWorld(world) {
      return { lng: unitXToLng(world.x / WORLD_SCALE), lat: unitYToLat(world.y / WORLD_SCALE) };
    },
    normalize(position) {
      assertGeo(position);
      const base = { lat: wrapLatitude(position.lat), lng: wrapLongitude(position.lng) };
      return position.altitude === undefined ? base : { ...base, altitude: position.altitude };
    },
    distance: geoDistance,
    wrapLongitude,
  };
}

function createEpsg4326(): Crs {
  return {
    code: 'EPSG:4326',
    positionKind: 'geographic',
    wraps: true,
    supportsTiling: true,
    metersPerWorldUnit: (2 * Math.PI * EARTH_RADIUS_METERS) / WORLD_SCALE,
    toWorld(position) {
      assertGeo(position);
      assertFinite(position.lng, 'longitude');
      assertFinite(position.lat, 'latitude');
      return {
        x: lngToUnitX(position.lng) * WORLD_SCALE,
        // Linear latitude: normalized y in [0, 1] over [-90, 90].
        y: (0.5 - position.lat / 360) * WORLD_SCALE,
      };
    },
    fromWorld(world) {
      return {
        lng: unitXToLng(world.x / WORLD_SCALE),
        lat: (0.5 - world.y / WORLD_SCALE) * 360,
      };
    },
    normalize(position) {
      assertGeo(position);
      const base = { lat: wrapLatitude(position.lat, 90), lng: wrapLongitude(position.lng) };
      return position.altitude === undefined ? base : { ...base, altitude: position.altitude };
    },
    distance: geoDistance,
    wrapLongitude,
  };
}

function createEpsg3395(): Crs {
  return {
    code: 'EPSG:3395',
    positionKind: 'geographic',
    wraps: true,
    supportsTiling: true,
    metersPerWorldUnit: (2 * Math.PI * WGS84_A) / WORLD_SCALE,
    toWorld(position) {
      assertGeo(position);
      assertFinite(position.lng, 'longitude');
      assertFinite(position.lat, 'latitude');
      const lat = wrapLatitude(position.lat, MAX_ELLIPSOIDAL_LATITUDE);
      return {
        x: (position.lng / 360 + 0.5) * WORLD_SCALE,
        y: (0.5 - ellipsoidalMercatorY(lat) / (2 * Math.PI)) * WORLD_SCALE,
      };
    },
    fromWorld(world) {
      return {
        lng: unitXToLng(world.x / WORLD_SCALE),
        lat: ellipsoidalMercatorInvY((0.5 - world.y / WORLD_SCALE) * 2 * Math.PI),
      };
    },
    normalize(position) {
      assertGeo(position);
      const base = {
        lat: wrapLatitude(position.lat, MAX_ELLIPSOIDAL_LATITUDE),
        lng: wrapLongitude(position.lng),
      };
      return position.altitude === undefined ? base : { ...base, altitude: position.altitude };
    },
    distance: geoDistance,
    wrapLongitude,
  };
}

function createSimple(): Crs {
  return {
    code: 'SIMPLE',
    positionKind: 'planar',
    wraps: false,
    supportsTiling: false,
    toWorld(position) {
      assertPlanar(position);
      assertFinite(position.x, 'x');
      assertFinite(position.y, 'y');
      // y is negated so that +y points north while screen/world y grows south,
      // matching the Leaflet Simple transformation.
      return { x: position.x * WORLD_SCALE, y: -position.y * WORLD_SCALE };
    },
    fromWorld(world) {
      return { x: world.x / WORLD_SCALE, y: -world.y / WORLD_SCALE };
    },
    normalize(position) {
      assertPlanar(position);
      assertFinite(position.x, 'x');
      assertFinite(position.y, 'y');
      return { x: position.x, y: position.y };
    },
    distance: planarDistance,
    wrapLongitude(lng) {
      return lng;
    },
  };
}

export interface CustomCrsSpec {
  readonly code: string;
  readonly positionKind: 'geographic' | 'planar';
  readonly wraps?: boolean;
  readonly supportsTiling?: boolean;
  /** Position -> world at zoom 0 (scale 256). Must be deterministic and return finite values. */
  readonly toWorld: (position: Position) => WorldPoint;
  /** World -> position. */
  readonly fromWorld: (world: WorldPoint) => Position;
  readonly distance?: (a: Position, b: Position) => Distance;
  readonly metersPerWorldUnit?: number;
}

const registry = new Map<string, Crs>();

function register(crs: Crs): Crs {
  registry.set(crs.code.toLowerCase(), crs);
  return crs;
}

register(createSphericalMercator());
register(createEpsg4326());
register(createEpsg3395());
register(createSimple());

export const crs = {
  /** Spherical Web Mercator (EPSG:3857). */
  webMercator(): Crs {
    return registry.get('epsg:3857')!;
  },
  /** Equirectangular WGS 84 (EPSG:4326) with its own linear mapping. */
  epsg4326(): Crs {
    return registry.get('epsg:4326')!;
  },
  /** Ellipsoidal Mercator (EPSG:3395); not the spherical Web Mercator. */
  epsg3395(): Crs {
    return registry.get('epsg:3395')!;
  },
  /** Planar CRS with explicit units; positions are `{ x, y }`. */
  simple(): Crs {
    return registry.get('simple')!;
  },
  /** Looks up a registered CRS by code (case insensitive). EXT-01. */
  get(code: string): Crs | undefined {
    return registry.get(code.toLowerCase());
  },
  /**
   * Registers a custom projection. Its math is used by conversions, the view and the
   * renderer, not only by an export path. EXT-01.
   */
  define(spec: CustomCrsSpec): Crs {
    if (!spec.code) fail('invalid-argument', 'custom CRS requires a code');
    if (registry.has(spec.code.toLowerCase())) {
      fail('invalid-argument', `CRS code already registered: ${spec.code}`);
    }
    const custom: Crs = {
      code: spec.code,
      positionKind: spec.positionKind,
      wraps: spec.wraps ?? false,
      supportsTiling: spec.supportsTiling ?? false,
      toWorld: spec.toWorld,
      fromWorld: spec.fromWorld,
      normalize(position) {
        return position;
      },
      distance: spec.distance ?? planarDistance,
      wrapLongitude(lng) {
        return lng;
      },
      ...(spec.metersPerWorldUnit === undefined
        ? {}
        : { metersPerWorldUnit: spec.metersPerWorldUnit }),
    };
    return register(custom);
  },
  /** Removes a previously registered custom CRS. Returns whether it existed. */
  unregister(code: string): boolean {
    if (['epsg:3857', 'epsg:4326', 'epsg:3395', 'simple'].includes(code.toLowerCase())) {
      return false;
    }
    return registry.delete(code.toLowerCase());
  },
};

export type CrsFactory = typeof crs;
