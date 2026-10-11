/**
 * Canonical geometry preparation.
 *
 * Public geometries are validated, normalized and projected to world coordinates
 * (scale 256 at zoom 0) exactly once at ingest. The renderer, spatial index and
 * queries all work on these canonical world coordinates; export reconstructs the
 * user's CRS positions from the world representation. GEOM-05, GEOM-10, GEOM-12,
 * IO-12 (canonical data is never replaced by clipped render fragments).
 *
 * Degenerate policy (closed in docs/decisions.md):
 * - consecutive duplicate positions are collapsed;
 * - lines need at least two distinct positions, polygons at least three;
 * - polygon rings are auto-closed;
 * - ring winding is normalized (outer rings positive area, holes negative);
 * - self-intersecting polygon rings are rejected up to 1024 vertices.
 */

import { fail } from '../api/errors.ts';
import type { GeoPosition, Position } from '../api/types.ts';
import type { Crs } from '../math/crs.ts';
import { EARTH_RADIUS_METERS } from '../math/crs.ts';
import { isGeoPosition, isPlanarPosition } from '../api/types.ts';

export const GEOMETRY_KIND = {
  point: 0,
  multiPoint: 1,
  lineString: 2,
  multiLineString: 3,
  polygon: 4,
  multiPolygon: 5,
  circle: 6,
  rectangle: 7,
} as const;

export type GeometryKindCode = (typeof GEOMETRY_KIND)[keyof typeof GEOMETRY_KIND];

export interface PointPayload {
  readonly kind: typeof GEOMETRY_KIND.point;
  readonly wx: number;
  readonly wy: number;
  /** Altitude in metres when the source position had one. */
  readonly alt?: number;
}

export interface MultiPointPayload {
  readonly kind: typeof GEOMETRY_KIND.multiPoint;
  readonly points: Float64Array;
  /** Altitude per point; NaN when a point has no altitude. */
  readonly altitudes?: Float64Array;
}

export interface LinePayload {
  readonly kind: typeof GEOMETRY_KIND.lineString | typeof GEOMETRY_KIND.multiLineString;
  /** World x, y interleaved. */
  readonly vertices: Float64Array;
  /** Pairs of [start, count] into vertices for each part. */
  readonly parts: Uint32Array;
  /** Altitude per vertex; NaN when missing. */
  readonly altitudes?: Float64Array;
}

export interface PolygonPayload {
  readonly kind: typeof GEOMETRY_KIND.polygon | typeof GEOMETRY_KIND.multiPolygon;
  /** World x, y interleaved for every ring, concatenated. */
  readonly ringVertices: Float64Array;
  /** Pairs of [start, count] into ringVertices for each ring. */
  readonly rings: Uint32Array;
  /** 1 when the ring is an exterior ring, 0 for a hole. */
  readonly ringOuter: Uint8Array;
  /** Altitude per ring vertex; NaN when missing. */
  readonly altitudes?: Float64Array;
}

export interface CirclePayload {
  readonly kind: typeof GEOMETRY_KIND.circle;
  readonly wx: number;
  readonly wy: number;
  readonly radius: number;
  readonly unit: 'meters' | 'planarUnits';
  /** World-space radii under the source CRS (may be elliptical for geographic CRS). */
  readonly worldRx: number;
  readonly worldRy: number;
  readonly alt?: number;
}

export interface RectanglePayload {
  readonly kind: typeof GEOMETRY_KIND.rectangle;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly altSouthwest?: number;
  readonly altNortheast?: number;
}

export type PreparedGeometry =
  | PointPayload
  | MultiPointPayload
  | LinePayload
  | PolygonPayload
  | CirclePayload
  | RectanglePayload;

export interface PreparedFeatureGeometry {
  readonly kind: GeometryKindCode;
  readonly payload: PreparedGeometry;
  /** World-space bounding box: [minX, minY, maxX, maxY]. */
  readonly bbox: Float64Array;
  /** Representative world point for point-sized indexing. */
  readonly anchorX: number;
  readonly anchorY: number;
}

const MAX_SELF_INTERSECTION_RING = 1024;

/** Validates a position and converts it to canonical world coordinates. */
export function positionToWorldChecked(
  crs: Crs,
  position: Position,
  context: string,
): { wx: number; wy: number; alt: number | undefined; position: Position } {
  if (crs.positionKind === 'geographic' && !isGeoPosition(position)) {
    fail('invalid-argument', `${context}: expected a { lat, lng } position`, { position });
  }
  if (crs.positionKind === 'planar' && !isPlanarPosition(position)) {
    fail('invalid-argument', `${context}: expected a { x, y } position`, { position });
  }
  const normalized = crs.normalize(position);
  const world = crs.toWorld(normalized);
  if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) {
    fail('invalid-argument', `${context}: position is outside the CRS domain`, { position });
  }
  const alt = isGeoPosition(normalized) ? normalized.altitude : undefined;
  return { wx: world.x, wy: world.y, alt, position: normalized };
}

function collapseConsecutive(points: Float64Array): Float64Array {
  let n = points.length / 2;
  const out = new Float64Array(points.length);
  let o = 0;
  let prevX = NaN;
  let prevY = NaN;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2]!;
    const y = points[i * 2 + 1]!;
    if (x === prevX && y === prevY) continue;
    out[o * 2] = x;
    out[o * 2 + 1] = y;
    o++;
    prevX = x;
    prevY = y;
  }
  return out.subarray(0, o * 2);
}

function ringSignedArea(points: Float64Array): number {
  let sum = 0;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += points[j * 2]! * points[i * 2 + 1]! - points[i * 2]! * points[j * 2 + 1]!;
  }
  return sum / 2;
}

function ringIsClosed(points: Float64Array): boolean {
  const n = points.length / 2;
  if (n < 2) return false;
  return points[0] === points[(n - 1) * 2] && points[1] === points[(n - 1) * 2 + 1];
}

function segmentsProperlyIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function ringSelfIntersects(points: Float64Array): boolean {
  const n = points.length / 2 - 1; // last vertex repeats the first after closing
  if (n > MAX_SELF_INTERSECTION_RING) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      const intersects = segmentsProperlyIntersect(
        points[i * 2]!, points[i * 2 + 1]!,
        points[(i + 1) * 2]!, points[(i + 1) * 2 + 1]!,
        points[j * 2]!, points[j * 2 + 1]!,
        points[(j + 1) * 2]!, points[(j + 1) * 2 + 1]!,
      );
      if (intersects) return true;
    }
  }
  return false;
}

function normalizeRing(points: Float64Array, outer: boolean, context: string): Float64Array {
  let ring = collapseConsecutive(points);
  if (!ringIsClosed(ring)) {
    const closed = new Float64Array(ring.length + 2);
    closed.set(ring);
    closed[ring.length] = ring[0]!;
    closed[ring.length + 1] = ring[1]!;
    ring = closed;
  }
  const distinct = ring.length / 2 - 1;
  if (distinct < 3) {
    fail('invalid-argument', `${context}: a polygon ring needs at least 3 distinct positions`, {
      distinct,
    });
  }
  if (ringSelfIntersects(ring)) {
    fail('invalid-argument', `${context}: self-intersecting polygon ring is not supported`, {});
  }
  const area = ringSignedArea(ring);
  if (area === 0) {
    fail('invalid-argument', `${context}: polygon ring has zero area`, {});
  }
  const wantPositive = outer;
  if (area > 0 !== wantPositive) {
    const reversed = new Float64Array(ring.length);
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      reversed[i * 2] = ring[(n - 1 - i) * 2]!;
      reversed[i * 2 + 1] = ring[(n - 1 - i) * 2 + 1]!;
    }
    ring = reversed;
  }
  return ring;
}

function circlesWorldRadii(
  crs: Crs,
  center: Position,
  radius: number,
  unit: 'meters' | 'planarUnits',
): { rx: number; ry: number } {
  if (crs.positionKind === 'planar' || unit === 'planarUnits') {
    if (unit === 'meters') {
      fail('invalid-argument', 'a metres circle requires a geographic CRS');
    }
    // One planar unit is WORLD_SCALE world units in every direction.
    return { rx: radius * 256, ry: radius * 256 };
  }
  const geo = center as GeoPosition;
  const metersPerDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;
  const cosLat = Math.max(Math.cos((geo.lat * Math.PI) / 180), 1e-6);
  const degLat = radius / metersPerDegree;
  const degLng = radius / (metersPerDegree * cosLat);
  const centerWorld = crs.toWorld(center);
  const latEdge = crs.toWorld({ lat: geo.lat + degLat, lng: geo.lng });
  const lngEdge = crs.toWorld({ lat: geo.lat, lng: geo.lng + degLng });
  return {
    rx: Math.abs(lngEdge.x - centerWorld.x),
    ry: Math.abs(latEdge.y - centerWorld.y),
  };
}

function bboxOf(vertices: Float64Array, from = 0, to = vertices.length): Float64Array {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = from; i < to; i += 2) {
    const x = vertices[i]!;
    const y = vertices[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Float64Array.of(minX, minY, maxX, maxY);
}

function preparePositions(crs: Crs): {
  read: (position: Position, context: string) => { wx: number; wy: number; alt: number | undefined };
  readList: (positions: readonly Position[], context: string) => Float64Array;
  readListWithAltitudes: (
    positions: readonly Position[],
    context: string,
  ) => { vertices: Float64Array; altitudes: Float64Array | null };
} {
  const read = (
    position: Position,
    context: string,
  ): { wx: number; wy: number; alt: number | undefined } => {
    const { wx, wy, alt } = positionToWorldChecked(crs, position, context);
    return { wx, wy, alt };
  };
  const readList = (positions: readonly Position[], context: string): Float64Array => {
    return readListWithAltitudes(positions, context).vertices;
  };
  const readListWithAltitudes = (
    positions: readonly Position[],
    context: string,
  ): { vertices: Float64Array; altitudes: Float64Array | null } => {
    if (!Array.isArray(positions) || positions.length === 0) {
      fail('invalid-argument', `${context}: expected a non-empty position array`, { positions });
    }
    const out = new Float64Array(positions.length * 2);
    const altitudes = new Float64Array(positions.length).fill(Number.NaN);
    let anyAltitude = false;
    for (let i = 0; i < positions.length; i++) {
      const { wx, wy, alt } = read(positions[i]!, `${context}[${i}]`);
      out[i * 2] = wx;
      out[i * 2 + 1] = wy;
      if (alt !== undefined) {
        altitudes[i] = alt;
        anyAltitude = true;
      }
    }
    return { vertices: out, altitudes: anyAltitude ? altitudes : null };
  };
  return { read, readList, readListWithAltitudes };
}

export function prepareGeometry(
  crs: Crs,
  geometry: unknown,
  context = 'geometry',
): PreparedFeatureGeometry {
  if (typeof geometry !== 'object' || geometry === null) {
    fail('invalid-argument', `${context}: expected a geometry object`, { geometry });
  }
  const type = (geometry as { type?: unknown }).type;
  const { read, readListWithAltitudes } = preparePositions(crs);

  switch (type) {
    case 'point': {
      const { wx, wy, alt } = read((geometry as { position: Position }).position, `${context}.position`);
      return {
        kind: GEOMETRY_KIND.point,
        payload: { kind: GEOMETRY_KIND.point, wx, wy, ...(alt === undefined ? {} : { alt }) },
        bbox: Float64Array.of(wx, wy, wx, wy),
        anchorX: wx,
        anchorY: wy,
      };
    }
    case 'multiPoint': {
      const { vertices: points, altitudes } = readListWithAltitudes(
        (geometry as { positions: readonly Position[] }).positions,
        context,
      );
      const bbox = bboxOf(points);
      return {
        kind: GEOMETRY_KIND.multiPoint,
        payload: {
          kind: GEOMETRY_KIND.multiPoint,
          points,
          ...(altitudes === null ? {} : { altitudes }),
        },
        bbox,
        anchorX: (bbox[0]! + bbox[2]!) / 2,
        anchorY: (bbox[1]! + bbox[3]!) / 2,
      };
    }
    case 'lineString': {
      const stored = prepareLineParts(crs, [
        (geometry as { positions: readonly Position[] }).positions,
      ], context);
      const bbox = bboxOf(stored.vertices);
      return {
        kind: GEOMETRY_KIND.lineString,
        payload: { kind: GEOMETRY_KIND.lineString, ...stored },
        bbox,
        anchorX: (bbox[0]! + bbox[2]!) / 2,
        anchorY: (bbox[1]! + bbox[3]!) / 2,
      };
    }
    case 'multiLineString': {
      const lines = (geometry as { lines: readonly (readonly Position[])[] }).lines;
      if (!Array.isArray(lines) || lines.length === 0) {
        fail('invalid-argument', `${context}: multiLineString needs at least one line`, { lines });
      }
      const stored = prepareLineParts(crs, lines, context);
      const bbox = bboxOf(stored.vertices);
      return {
        kind: GEOMETRY_KIND.multiLineString,
        payload: { kind: GEOMETRY_KIND.multiLineString, ...stored },
        bbox,
        anchorX: (bbox[0]! + bbox[2]!) / 2,
        anchorY: (bbox[1]! + bbox[3]!) / 2,
      };
    }
    case 'polygon': {
      const rings = (geometry as { rings: readonly (readonly Position[])[] }).rings;
      const stored = preparePolygonRings(crs, [rings], context);
      const bbox = bboxOf(stored.ringVertices);
      return {
        kind: GEOMETRY_KIND.polygon,
        payload: { kind: GEOMETRY_KIND.polygon, ...stored },
        bbox,
        anchorX: (bbox[0]! + bbox[2]!) / 2,
        anchorY: (bbox[1]! + bbox[3]!) / 2,
      };
    }
    case 'multiPolygon': {
      const polygons = (geometry as { polygons: readonly (readonly (readonly Position[])[])[] })
        .polygons;
      if (!Array.isArray(polygons) || polygons.length === 0) {
        fail('invalid-argument', `${context}: multiPolygon needs at least one polygon`, { polygons });
      }
      const stored = preparePolygonRings(crs, polygons, context);
      const bbox = bboxOf(stored.ringVertices);
      return {
        kind: GEOMETRY_KIND.multiPolygon,
        payload: { kind: GEOMETRY_KIND.multiPolygon, ...stored },
        bbox,
        anchorX: (bbox[0]! + bbox[2]!) / 2,
        anchorY: (bbox[1]! + bbox[3]!) / 2,
      };
    }
    case 'circle': {
      const circle = geometry as { center: Position; radius: number; unit: 'meters' | 'planarUnits' };
      if (!Number.isFinite(circle.radius) || circle.radius <= 0) {
        fail('invalid-argument', `${context}.radius must be a positive finite number`, {
          radius: circle.radius,
        });
      }
      if (circle.unit !== 'meters' && circle.unit !== 'planarUnits') {
        fail('invalid-argument', `${context}.unit must be 'meters' or 'planarUnits'`, {
          unit: circle.unit,
        });
      }
      const { wx, wy, alt } = read(circle.center, `${context}.center`);
      const { rx, ry } = circlesWorldRadii(crs, circle.center, circle.radius, circle.unit);
      return {
        kind: GEOMETRY_KIND.circle,
        payload: {
          kind: GEOMETRY_KIND.circle,
          wx,
          wy,
          radius: circle.radius,
          unit: circle.unit,
          worldRx: rx,
          worldRy: ry,
          ...(alt === undefined ? {} : { alt }),
        },
        bbox: Float64Array.of(wx - rx, wy - ry, wx + rx, wy + ry),
        anchorX: wx,
        anchorY: wy,
      };
    }
    case 'rectangle': {
      const rect = geometry as { southwest: Position; northeast: Position };
      const sw = read(rect.southwest, `${context}.southwest`);
      const ne = read(rect.northeast, `${context}.northeast`);
      if (sw.wx === ne.wx || sw.wy === ne.wy) {
        fail('invalid-argument', `${context}: rectangle has zero area`, {});
      }
      const minX = Math.min(sw.wx, ne.wx);
      const maxX = Math.max(sw.wx, ne.wx);
      const minY = Math.min(sw.wy, ne.wy);
      const maxY = Math.max(sw.wy, ne.wy);
      return {
        kind: GEOMETRY_KIND.rectangle,
        payload: {
          kind: GEOMETRY_KIND.rectangle,
          minX,
          minY,
          maxX,
          maxY,
          ...(sw.alt === undefined ? {} : { altSouthwest: sw.alt }),
          ...(ne.alt === undefined ? {} : { altNortheast: ne.alt }),
        },
        bbox: Float64Array.of(minX, minY, maxX, maxY),
        anchorX: (minX + maxX) / 2,
        anchorY: (minY + maxY) / 2,
      };
    }
    default:
      fail('invalid-argument', `${context}: unsupported geometry type ${String(type)}`, { type });
  }
}

function prepareLineParts(
  crs: Crs,
  lines: readonly (readonly Position[])[],
  context: string,
): { vertices: Float64Array; parts: Uint32Array } {
  const { readList } = preparePositions(crs);
  const chunks: Float64Array[] = [];
  const parts: number[] = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = readList(lines[i]!, `${context}.lines[${i}]`);
    const collapsed = collapseConsecutive(raw);
    const count = collapsed.length / 2;
    if (count < 2) continue;
    chunks.push(collapsed);
    parts.push(start, count);
    start += count;
  }
  if (chunks.length === 0) {
    fail('invalid-argument', `${context}: a line needs at least 2 distinct positions`, {});
  }
  const vertices = new Float64Array(start * 2);
  let offset = 0;
  for (const chunk of chunks) {
    vertices.set(chunk, offset);
    offset += chunk.length;
  }
  return { vertices, parts: Uint32Array.from(parts) };
}

function preparePolygonRings(
  crs: Crs,
  polygons: readonly (readonly (readonly Position[])[])[],
  context: string,
): { ringVertices: Float64Array; rings: Uint32Array; ringOuter: Uint8Array } {
  const { readList } = preparePositions(crs);
  const ringChunks: Float64Array[] = [];
  const ringOffsets: number[] = [];
  const outerFlags: number[] = [];
  let start = 0;
  for (let p = 0; p < polygons.length; p++) {
    const polygon = polygons[p]!;
    if (!Array.isArray(polygon) || polygon.length === 0) {
      fail('invalid-argument', `${context}: polygon ${p} needs at least one ring`, {});
    }
    for (let r = 0; r < polygon.length; r++) {
      const raw = readList(polygon[r]!, `${context}.polygons[${p}].rings[${r}]`);
      const outer = r === 0;
      const ring = normalizeRing(raw, outer, `${context}.polygons[${p}].rings[${r}]`);
      ringChunks.push(ring);
      ringOffsets.push(start, ring.length / 2);
      outerFlags.push(outer ? 1 : 0);
      start += ring.length / 2;
    }
  }
  const ringVertices = new Float64Array(start * 2);
  let offset = 0;
  for (const chunk of ringChunks) {
    ringVertices.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    ringVertices,
    rings: Uint32Array.from(ringOffsets),
    ringOuter: Uint8Array.from(outerFlags),
  };
}

/** Reconstructs the CRS positions of a prepared geometry; used by get/export. */
export function geometryPositions(crs: Crs, prepared: PreparedFeatureGeometry): unknown {
  const toPosition = (x: number, y: number, altitude?: number): Position => {
    const base = crs.fromWorld({ x, y });
    return altitude === undefined ? base : ({ ...base, altitude } as Position);
  };
  const payload = prepared.payload;
  switch (payload.kind) {
    case GEOMETRY_KIND.point:
      return { type: 'point', position: toPosition(payload.wx, payload.wy, payload.alt) };
    case GEOMETRY_KIND.multiPoint: {
      const positions: Position[] = [];
      for (let i = 0; i < payload.points.length; i += 2) {
        const altitude = payload.altitudes ? payload.altitudes[i / 2] : undefined;
        positions.push(
          toPosition(
            payload.points[i]!,
            payload.points[i + 1]!,
            altitude !== undefined && Number.isNaN(altitude) ? undefined : altitude,
          ),
        );
      }
      return { type: 'multiPoint', positions };
    }
    case GEOMETRY_KIND.lineString:
    case GEOMETRY_KIND.multiLineString: {
      const lines: Position[][] = [];
      for (let p = 0; p < payload.parts.length; p += 2) {
        const start = payload.parts[p]!;
        const count = payload.parts[p + 1]!;
        const line: Position[] = [];
        for (let i = 0; i < count; i++) {
          const at = (start + i) * 2;
          line.push(toPosition(payload.vertices[at]!, payload.vertices[at + 1]!));
        }
        lines.push(line);
      }
      return payload.kind === GEOMETRY_KIND.lineString
        ? { type: 'lineString', positions: lines[0]! }
        : { type: 'multiLineString', lines };
    }
    case GEOMETRY_KIND.polygon:
    case GEOMETRY_KIND.multiPolygon: {
      const readRing = (start: number, count: number): Position[] => {
        const ring: Position[] = [];
        for (let i = 0; i < count; i++) {
          const at = (start + i) * 2;
          ring.push(toPosition(payload.ringVertices[at]!, payload.ringVertices[at + 1]!));
        }
        return ring;
      };
      const polygons: Position[][][] = [];
      let current: Position[][] = [];
      for (let r = 0; r < payload.rings.length; r += 2) {
        const ring = readRing(payload.rings[r]!, payload.rings[r + 1]!);
        const outer = payload.ringOuter[r / 2] === 1;
        if (outer && current.length > 0) {
          polygons.push(current);
          current = [];
        }
        current.push(ring);
      }
      if (current.length > 0) polygons.push(current);
      return payload.kind === GEOMETRY_KIND.polygon
        ? { type: 'polygon', rings: polygons[0] ?? [] }
        : { type: 'multiPolygon', polygons };
    }
    case GEOMETRY_KIND.circle:
      return {
        type: 'circle',
        center: toPosition(payload.wx, payload.wy, payload.alt),
        radius: payload.radius,
        unit: payload.unit,
      };
    case GEOMETRY_KIND.rectangle:
      return {
        type: 'rectangle',
        southwest: toPosition(payload.minX, payload.maxY, payload.altSouthwest),
        northeast: toPosition(payload.maxX, payload.minY, payload.altNortheast),
      };
  }
}

export function geometryKindName(kind: GeometryKindCode): string {
  for (const [name, code] of Object.entries(GEOMETRY_KIND)) {
    if (code === kind) return name;
  }
  return `kind-${kind}`;
}
