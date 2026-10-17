/**
 * Data-side spatial queries over canonical world coordinates.
 *
 * Data queries never go through the GPU readback path: they use the source's
 * incremental spatial index and real geometry tests (point in polygon with holes,
 * distance to segments, circle radius, rectangle), so a line with both endpoints
 * outside the viewport is still found (QUERY-02, SPACE-01/SPACE-02).
 */

import { GEOMETRY_KIND, type PreparedGeometry } from '../geometry/geometry.ts';
import type { Crs } from '../math/crs.ts';
import type { WorldPoint } from '../api/types.ts';
import type { SlotRecord } from './store.ts';
import type { SourceImpl } from './source.ts';

export type AreaRelation = 'intersects' | 'contains';

export interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function pointInRing(
  x: number,
  y: number,
  vertices: Float64Array,
  start: number,
  count: number,
): boolean {
  let inside = false;
  const end = start + count;
  for (let i = start, j = end - 1; i < end; j = i++) {
    const xi = vertices[i * 2]!;
    const yi = vertices[i * 2 + 1]!;
    const xj = vertices[j * 2]!;
    const yj = vertices[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonPayload(
  x: number,
  y: number,
  payload: Extract<PreparedGeometry, { rings: Uint32Array }>,
): boolean {
  let inside = false;
  for (let r = 0; r < payload.rings.length; r += 2) {
    if (pointInRing(x, y, payload.ringVertices, payload.rings[r]!, payload.rings[r + 1]!)) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function pointWithinGeometry(x: number, y: number, record: SlotRecord, tolerance: number): boolean {
  if (!record.geometry) {
    return Math.hypot(x - record.wx, y - record.wy) <= tolerance;
  }
  const payload = record.geometry.payload;
  switch (payload.kind) {
    case GEOMETRY_KIND.point:
      return Math.hypot(x - payload.wx, y - payload.wy) <= tolerance;
    case GEOMETRY_KIND.multiPoint: {
      for (let i = 0; i < payload.points.length; i += 2) {
        if (Math.hypot(x - payload.points[i]!, y - payload.points[i + 1]!) <= tolerance) {
          return true;
        }
      }
      return false;
    }
    case GEOMETRY_KIND.lineString:
    case GEOMETRY_KIND.multiLineString: {
      for (let p = 0; p < payload.parts.length; p += 2) {
        const start = payload.parts[p]!;
        const count = payload.parts[p + 1]!;
        for (let i = 0; i < count - 1; i++) {
          const a = (start + i) * 2;
          const b = (start + i + 1) * 2;
          const distance = distanceToSegment(
            x,
            y,
            payload.vertices[a]!,
            payload.vertices[a + 1]!,
            payload.vertices[b]!,
            payload.vertices[b + 1]!,
          );
          if (distance <= tolerance) return true;
        }
      }
      return false;
    }
    case GEOMETRY_KIND.polygon:
    case GEOMETRY_KIND.multiPolygon: {
      if (pointInPolygonPayload(x, y, payload)) return true;
      // Near the outline counts as a hit within tolerance.
      for (let r = 0; r < payload.rings.length; r += 2) {
        const start = payload.rings[r]!;
        const count = payload.rings[r + 1]!;
        for (let i = 0; i < count; i++) {
          const a = (start + i) * 2;
          const b = (start + ((i + 1) % count)) * 2;
          const distance = distanceToSegment(
            x,
            y,
            payload.ringVertices[a]!,
            payload.ringVertices[a + 1]!,
            payload.ringVertices[b]!,
            payload.ringVertices[b + 1]!,
          );
          if (distance <= tolerance) return true;
        }
      }
      return false;
    }
    case GEOMETRY_KIND.circle: {
      const dx = (x - payload.wx) / Math.max(payload.worldRx, 1e-12);
      const dy = (y - payload.wy) / Math.max(payload.worldRy, 1e-12);
      return dx * dx + dy * dy <= 1 + tolerance;
    }
    case GEOMETRY_KIND.rectangle:
      return (
        x >= payload.minX - tolerance &&
        x <= payload.maxX + tolerance &&
        y >= payload.minY - tolerance &&
        y <= payload.maxY + tolerance
      );
  }
}

function rectIntersectsPayload(rect: WorldRect, record: SlotRecord): boolean {
  if (!record.geometry) {
    return (
      record.wx >= rect.minX &&
      record.wx <= rect.maxX &&
      record.wy >= rect.minY &&
      record.wy <= rect.maxY
    );
  }
  const payload = record.geometry.payload;
  switch (payload.kind) {
    case GEOMETRY_KIND.point:
      return (
        payload.wx >= rect.minX &&
        payload.wx <= rect.maxX &&
        payload.wy >= rect.minY &&
        payload.wy <= rect.maxY
      );
    case GEOMETRY_KIND.multiPoint:
      for (let i = 0; i < payload.points.length; i += 2) {
        if (
          payload.points[i]! >= rect.minX &&
          payload.points[i]! <= rect.maxX &&
          payload.points[i + 1]! >= rect.minY &&
          payload.points[i + 1]! <= rect.maxY
        ) {
          return true;
        }
      }
      return false;
    case GEOMETRY_KIND.lineString:
    case GEOMETRY_KIND.multiLineString: {
      for (let p = 0; p < payload.parts.length; p += 2) {
        const start = payload.parts[p]!;
        const count = payload.parts[p + 1]!;
        for (let i = 0; i < count; i++) {
          const at = (start + i) * 2;
          const x = payload.vertices[at]!;
          const y = payload.vertices[at + 1]!;
          if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) return true;
          if (i < count - 1) {
            const nx = payload.vertices[at + 2]!;
            const ny = payload.vertices[at + 3]!;
            if (segmentIntersectsRect(x, y, nx, ny, rect)) return true;
          }
        }
      }
      return false;
    }
    case GEOMETRY_KIND.polygon:
    case GEOMETRY_KIND.multiPolygon: {
      // Any ring vertex inside, any rect corner inside the polygon, or any ring
      // edge crossing the rect.
      for (let r = 0; r < payload.rings.length; r += 2) {
        const start = payload.rings[r]!;
        const count = payload.rings[r + 1]!;
        for (let i = 0; i < count; i++) {
          const at = (start + i) * 2;
          const x = payload.ringVertices[at]!;
          const y = payload.ringVertices[at + 1]!;
          if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) return true;
          const next = start + ((i + 1) % count);
          if (
            segmentIntersectsRect(
              x,
              y,
              payload.ringVertices[next * 2]!,
              payload.ringVertices[next * 2 + 1]!,
              rect,
            )
          ) {
            return true;
          }
        }
      }
      for (const [x, y] of [
        [rect.minX, rect.minY],
        [rect.maxX, rect.minY],
        [rect.minX, rect.maxY],
        [rect.maxX, rect.maxY],
      ] as const) {
        if (pointInPolygonPayload(x, y, payload)) return true;
      }
      return false;
    }
    case GEOMETRY_KIND.circle: {
      // Circle vs rect: nearest point on the rect to the centre.
      const nx = Math.max(rect.minX, Math.min(rect.maxX, payload.wx));
      const ny = Math.max(rect.minY, Math.min(rect.maxY, payload.wy));
      const dx = (payload.wx - nx) / Math.max(payload.worldRx, 1e-12);
      const dy = (payload.wy - ny) / Math.max(payload.worldRy, 1e-12);
      return dx * dx + dy * dy <= 1;
    }
    case GEOMETRY_KIND.rectangle:
      return !(
        payload.maxX < rect.minX ||
        payload.minX > rect.maxX ||
        payload.maxY < rect.minY ||
        payload.minY > rect.maxY
      );
  }
}

function rectContainsPayload(rect: WorldRect, record: SlotRecord): boolean {
  if (!record.geometry) {
    return (
      record.wx >= rect.minX &&
      record.wx <= rect.maxX &&
      record.wy >= rect.minY &&
      record.wy <= rect.maxY
    );
  }
  const payload = record.geometry.payload;
  switch (payload.kind) {
    case GEOMETRY_KIND.point:
      return (
        payload.wx >= rect.minX &&
        payload.wx <= rect.maxX &&
        payload.wy >= rect.minY &&
        payload.wy <= rect.maxY
      );
    case GEOMETRY_KIND.multiPoint:
      return (
        record.geometry.bbox[0]! >= rect.minX &&
        record.geometry.bbox[2]! <= rect.maxX &&
        record.geometry.bbox[1]! >= rect.minY &&
        record.geometry.bbox[3]! <= rect.maxY
      );
    case GEOMETRY_KIND.lineString:
    case GEOMETRY_KIND.multiLineString:
    case GEOMETRY_KIND.polygon:
    case GEOMETRY_KIND.multiPolygon:
    case GEOMETRY_KIND.circle:
    case GEOMETRY_KIND.rectangle: {
      const bbox = record.geometry.bbox;
      return (
        bbox[0]! >= rect.minX &&
        bbox[2]! <= rect.maxX &&
        bbox[1]! >= rect.minY &&
        bbox[3]! <= rect.maxY
      );
    }
  }
}

function segmentIntersectsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: WorldRect,
): boolean {
  if (
    Math.max(ax, bx) < rect.minX ||
    Math.min(ax, bx) > rect.maxX ||
    Math.max(ay, by) < rect.minY ||
    Math.min(ay, by) > rect.maxY
  ) {
    return false;
  }
  const inside = (x: number, y: number): boolean =>
    x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
  if (inside(ax, ay) || inside(bx, by)) return true;
  const corners: [number, number][] = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ];
  for (let i = 0; i < 4; i++) {
    const [cx, cy] = corners[i]!;
    const [dx, dy] = corners[(i + 1) % 4]!;
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return true;
  }
  return false;
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export interface DataHit {
  readonly record: SlotRecord;
  readonly source: SourceImpl;
}

/** Point query in world coordinates with a world-space tolerance. */
export function queryDataAt(
  sources: readonly SourceImpl[],
  world: WorldPoint,
  toleranceWorld: number,
): DataHit[] {
  const hits: DataHit[] = [];
  for (const source of sources) {
    let best: SlotRecord | null = null;
    source.store.queryRect(
      world.x - toleranceWorld,
      world.y - toleranceWorld,
      world.x + toleranceWorld,
      world.y + toleranceWorld,
      (record) => {
        if (!pointWithinGeometry(world.x, world.y, record, toleranceWorld)) return;
        if (!best || record.slot < best.slot) best = record;
      },
    );
    if (best) hits.push({ record: best, source });
  }
  return hits;
}

export function queryDataRect(
  sources: readonly SourceImpl[],
  rect: WorldRect,
  relation: AreaRelation,
): DataHit[] {
  const hits: DataHit[] = [];
  for (const source of sources) {
    source.store.queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY, (record) => {
      const bbox = record.geometry
        ? record.geometry.bbox
        : [record.wx, record.wy, record.wx, record.wy];
      if (
        bbox[2]! < rect.minX ||
        bbox[0]! > rect.maxX ||
        bbox[3]! < rect.minY ||
        bbox[1]! > rect.maxY
      ) {
        return;
      }
      const matched =
        relation === 'contains'
          ? rectContainsPayload(rect, record)
          : rectIntersectsPayload(rect, record);
      if (matched) hits.push({ record, source });
    });
  }
  return hits;
}

/** Geo bounds → world rect for query input. */
export function boundsToWorldRect(
  crs: Crs,
  bounds: {
    southwest: { lat: number; lng: number } | { x: number; y: number };
    northeast: { lat: number; lng: number } | { x: number; y: number };
  },
): WorldRect {
  const sw = crs.toWorld(bounds.southwest);
  const ne = crs.toWorld(bounds.northeast);
  return {
    minX: Math.min(sw.x, ne.x),
    minY: Math.min(sw.y, ne.y),
    maxX: Math.max(sw.x, ne.x),
    maxY: Math.max(sw.y, ne.y),
  };
}
