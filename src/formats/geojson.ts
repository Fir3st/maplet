/**
 * GeoJSON import/export.
 *
 * GeoJSON coordinates are `[lng, lat, altitude?]`; the public Maplet position is
 * `{ lat, lng, altitude? }` (IO-01). A feature's original id and properties are
 * preserved; a missing id follows the source's documented generation policy
 * (IO-04). Object IDs that cannot be represented exactly are rejected instead of
 * being rounded (MVT 64-bit rule applied to GeoJSON input too).
 */

import { fail } from '../api/errors.ts';
import type { FeatureId, FeatureProperties, FeatureSnapshot, Geometry, GeoPosition, PlanarPosition, Position } from '../api/types.ts';
import type { FeatureInput } from '../scene/source.ts';

export type GeoJsonCoordinates = readonly number[];

export interface GeoJsonGeometry {
  readonly type: string;
  readonly coordinates?: unknown;
  readonly geometries?: readonly GeoJsonGeometry[];
}

export interface GeoJsonFeature {
  readonly type: 'Feature';
  readonly id?: string | number;
  readonly geometry: GeoJsonGeometry | null;
  readonly properties?: Record<string, unknown> | null;
}

export interface GeoJsonFeatureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly GeoJsonFeature[];
}

export type GeoJsonInput = GeoJsonFeature | GeoJsonFeatureCollection | GeoJsonGeometry;

function toPosition(coordinates: GeoJsonCoordinates, context: string): GeoPosition {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    fail('import-invalid', `${context}: coordinates must be [lng, lat, altitude?]`, {
      coordinates,
    });
  }
  const lng = coordinates[0];
  const lat = coordinates[1];
  if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    fail('import-invalid', `${context}: coordinates must be finite numbers`, { coordinates });
  }
  const altitude = coordinates[2];
  return altitude === undefined
    ? { lat, lng }
    : { lat, lng, altitude: Number(altitude) };
}

function positionList(value: unknown, context: string): GeoPosition[] {
  if (!Array.isArray(value)) {
    fail('import-invalid', `${context}: expected an array of positions`, { value });
  }
  return value.map((coordinates, index) =>
    toPosition(coordinates as GeoJsonCoordinates, `${context}[${index}]`),
  );
}

function positionLists(value: unknown, context: string): GeoPosition[][] {
  if (!Array.isArray(value)) {
    fail('import-invalid', `${context}: expected an array of line strings`, { value });
  }
  return value.map((line, index) =>
    positionList(line, `${context}[${index}]`),
  );
}

function positionListLists(value: unknown, context: string): GeoPosition[][][] {
  if (!Array.isArray(value)) {
    fail('import-invalid', `${context}: expected an array of polygons`, { value });
  }
  return value.map((polygon, index) =>
    positionLists(polygon, `${context}[${index}]`),
  );
}

export function geoJsonGeometryToGeometry(geometry: GeoJsonGeometry, context = 'geometry'): Geometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'point', position: toPosition(geometry.coordinates as GeoJsonCoordinates, context) };
    case 'MultiPoint':
      return { type: 'multiPoint', positions: positionList(geometry.coordinates, context) };
    case 'LineString':
      return { type: 'lineString', positions: positionList(geometry.coordinates, context) };
    case 'MultiLineString':
      return { type: 'multiLineString', lines: positionLists(geometry.coordinates, context) };
    case 'Polygon':
      return { type: 'polygon', rings: positionLists(geometry.coordinates, context) };
    case 'MultiPolygon':
      return { type: 'multiPolygon', polygons: positionListLists(geometry.coordinates, context) };
    case 'GeometryCollection': {
      const geometries = geometry.geometries ?? [];
      if (geometries.length === 0) {
        fail('import-invalid', `${context}: empty GeometryCollection`, {});
      }
      if (geometries.length === 1) return geoJsonGeometryToGeometry(geometries[0]!, context);
      // Multiple parts: represent as a multi geometry when they agree, otherwise
      // reject with a clear message instead of inventing a feature type.
      const parts = geometries.map((part) => geoJsonGeometryToGeometry(part, context));
      const kinds = new Set(parts.map((part) => part.type));
      if (kinds.size === 1) {
        const kind = parts[0]!.type;
        if (kind === 'point') {
          return { type: 'multiPoint', positions: parts.map((part) => (part as { position: GeoPosition }).position) };
        }
        if (kind === 'lineString') {
          return {
            type: 'multiLineString',
            lines: parts.map((part) => (part as { positions: readonly GeoPosition[] }).positions),
          };
        }
        if (kind === 'polygon') {
          return {
            type: 'multiPolygon',
            polygons: parts.map((part) => (part as { rings: readonly (readonly GeoPosition[])[] }).rings),
          };
        }
      }
      fail('import-invalid', `${context}: mixed GeometryCollection parts are not supported`, {
        kinds: Array.from(kinds),
      });
    }
    default:
      fail('import-invalid', `${context}: unsupported geometry type ${String(geometry.type)}`, {
        type: geometry.type,
      });
  }
}

export interface ParseGeoJsonOptions {
  /** `sourceId` is only used in error context. */
  readonly sourceId?: string;
}

export interface ParsedGeoJsonFeature {
  readonly id?: FeatureId;
  readonly geometry: Geometry;
  readonly properties: FeatureProperties;
}

/**
 * Parses GeoJSON text or an object into feature inputs. Duplicate IDs are left to
 * the source transaction to reject; unsafe numeric IDs fail here (IO-03, IO-04).
 */
export function parseGeoJson(input: string | GeoJsonInput, options: ParseGeoJsonOptions = {}): ParsedGeoJsonFeature[] {
  let value: GeoJsonInput;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as GeoJsonInput;
    } catch (error) {
      fail('import-invalid', 'GeoJSON text is not valid JSON', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    value = input;
  }
  const context = options.sourceId ? `geojson(${options.sourceId})` : 'geojson';
  if (typeof value !== 'object' || value === null) {
    fail('import-invalid', `${context}: expected an object`, {});
  }
  if (value.type === 'FeatureCollection') {
    const features = (value as GeoJsonFeatureCollection).features;
    if (!Array.isArray(features)) {
      fail('import-invalid', `${context}: FeatureCollection.features must be an array`, {});
    }
    return features.map((feature, index) => parseFeature(feature, `${context}.features[${index}]`));
  }
  if (value.type === 'Feature') {
    return [parseFeature(value as GeoJsonFeature, context)];
  }
  return [
    {
      geometry: geoJsonGeometryToGeometry(value as GeoJsonGeometry, context),
      properties: {},
    },
  ];
}

function parseFeature(feature: GeoJsonFeature, context: string): ParsedGeoJsonFeature {
  if (feature.geometry === null || feature.geometry === undefined) {
    fail('import-invalid', `${context}: feature without geometry is not supported`, {});
  }
  const id = feature.id;
  let featureId: FeatureId | undefined;
  if (id !== undefined) {
    if (typeof id === 'string') {
      featureId = id;
    } else if (typeof id === 'number') {
      if (!Number.isSafeInteger(id)) {
        fail(
          'import-invalid',
          `${context}: numeric feature id is not exactly representable; pass it as a string`,
          { id },
        );
      }
      featureId = id;
    } else {
      fail('import-invalid', `${context}: feature id must be a string or an integer`, { id });
    }
  }
  const properties = feature.properties ?? {};
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    fail('import-invalid', `${context}: properties must be an object`, { properties });
  }
  return {
    ...(featureId === undefined ? {} : { id: featureId }),
    geometry: geoJsonGeometryToGeometry(feature.geometry, `${context}.geometry`),
    properties: properties as FeatureProperties,
  };
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

function positionToCoordinates(position: Position): number[] {
  if ('lat' in position) {
    return position.altitude === undefined
      ? [position.lng, position.lat]
      : [position.lng, position.lat, position.altitude];
  }
  return [(position as PlanarPosition).x, (position as PlanarPosition).y];
}

export function geometryToGeoJson(geometry: Geometry<GeoPosition | PlanarPosition>): GeoJsonGeometry {
  const positions = (list: readonly Position[]): number[][] => list.map(positionToCoordinates);
  switch (geometry.type) {
    case 'point':
      return { type: 'Point', coordinates: positionToCoordinates(geometry.position) };
    case 'multiPoint':
      return { type: 'MultiPoint', coordinates: positions(geometry.positions) };
    case 'lineString':
      return { type: 'LineString', coordinates: positions(geometry.positions) };
    case 'multiLineString':
      return { type: 'MultiLineString', coordinates: geometry.lines.map(positions) };
    case 'polygon':
      return { type: 'Polygon', coordinates: geometry.rings.map(positions) };
    case 'multiPolygon':
      return { type: 'MultiPolygon', coordinates: geometry.polygons.map((rings) => rings.map(positions)) };
    case 'circle':
      fail('unsupported', 'circles cannot be exported as GeoJSON geometry', {});
    case 'rectangle': {
      if ('lat' in geometry.southwest) {
        const sw = geometry.southwest;
        const ne = geometry.northeast as GeoPosition;
        const corners: Position[] = [
          sw,
          { lat: sw.lat, lng: ne.lng },
          ne,
          { lat: ne.lat, lng: sw.lng },
          sw,
        ];
        return { type: 'Polygon', coordinates: [corners.map(positionToCoordinates)] };
      }
      const sw = geometry.southwest as PlanarPosition;
      const ne = geometry.northeast as PlanarPosition;
      const corners: Position[] = [
        sw,
        { x: ne.x, y: sw.y },
        ne,
        { x: sw.x, y: ne.y },
        sw,
      ];
      return { type: 'Polygon', coordinates: [corners.map(positionToCoordinates)] };
    }
  }
}

/** Exports live feature snapshots as a FeatureCollection (IO-01, IO-12). */
export function featuresToGeoJson(
  snapshots: readonly FeatureSnapshot[],
): GeoJsonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: snapshots.map((snapshot) => ({
      type: 'Feature',
      id: snapshot.ref.id,
      geometry: geometryToGeoJson(snapshot.geometry),
      properties: { ...snapshot.properties },
    })),
  };
}

export function parsedToFeatureInput(parsed: ParsedGeoJsonFeature): FeatureInput {
  return {
    geometry: parsed.geometry,
    properties: parsed.properties,
    ...(parsed.id === undefined ? {} : { id: parsed.id }),
  } as FeatureInput;
}
