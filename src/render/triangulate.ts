/**
 * Polygon triangulation for fills with holes.
 *
 * Ear clipping for the exterior ring; each triangle of a hole is subtracted from
 * the resulting triangle set (Weiler-style subtraction by half-plane clipping).
 * This is a port of the proven approach from the earlier leaflet-gpu plugin
 * (`src/math/geometry.js`); ported algorithms are verified by the same fixtures
 * (GEOM-09, GEOM-10, GEOM-11) and do not inherit the plugin's private contracts.
 */

export interface Ring {
  readonly vertices: Float64Array;
  readonly start: number;
  readonly count: number;
}

function ringArea(vertices: Float64Array, start: number, count: number): number {
  let sum = 0;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = vertices[(start + i) * 2]!;
    const yi = vertices[(start + i) * 2 + 1]!;
    const xj = vertices[(start + j) * 2]!;
    const yj = vertices[(start + j) * 2 + 1]!;
    sum += xj * yi - xi * yj;
  }
  return sum / 2;
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function earClip(vertices: Float64Array, start: number, count: number, out: number[]): void {
  const xs: number[] = [];
  const ys: number[] = [];
  const ccw = ringArea(vertices, start, count) > 0;
  for (let i = 0; i < count; i++) {
    const at = ccw ? start + i : start + count - 1 - i;
    xs.push(vertices[at * 2]!);
    ys.push(vertices[at * 2 + 1]!);
  }
  let n = xs.length;
  if (n > 1 && xs[0] === xs[n - 1] && ys[0] === ys[n - 1]) n--;
  xs.length = n;
  ys.length = n;
  if (n < 3) return;
  let guard = n * n + 16;
  while (xs.length > 3 && guard-- > 0) {
    let clipped = false;
    const length = xs.length;
    for (let i = 0; i < length; i++) {
      const prev = (i - 1 + length) % length;
      const next = (i + 1) % length;
      const ax = xs[prev]!;
      const ay = ys[prev]!;
      const bx = xs[i]!;
      const by = ys[i]!;
      const cx = xs[next]!;
      const cy = ys[next]!;
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross <= 1e-18) continue;
      let contains = false;
      for (let j = 0; j < length; j++) {
        if (j === prev || j === i || j === next) continue;
        if (pointInTriangle(xs[j]!, ys[j]!, ax, ay, bx, by, cx, cy)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      out.push(ax, ay, bx, by, cx, cy);
      xs.splice(i, 1);
      ys.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (xs.length === 3) {
    const doubleArea = Math.abs(
      (xs[1]! - xs[0]!) * (ys[2]! - ys[0]!) - (ys[1]! - ys[0]!) * (xs[2]! - xs[0]!),
    );
    if (doubleArea > 1e-18) out.push(xs[0]!, ys[0]!, xs[1]!, ys[1]!, xs[2]!, ys[2]!);
  }
}

function clipHalfPlane(polygon: number[], side: (x: number, y: number) => number): number[] {
  if (polygon.length < 6) return [];
  const out: number[] = [];
  const n = polygon.length / 2;
  for (let i = 0; i < n; i++) {
    const cx = polygon[i * 2]!;
    const cy = polygon[i * 2 + 1]!;
    const nx = polygon[((i + 1) % n) * 2]!;
    const ny = polygon[((i + 1) % n) * 2 + 1]!;
    const c = side(cx, cy);
    const nSide = side(nx, ny);
    if (c >= 0) out.push(cx, cy);
    if (c >= 0 !== nSide >= 0) {
      const d = c - nSide;
      if (d !== 0) {
        const t = c / d;
        out.push(cx + (nx - cx) * t, cy + (ny - cy) * t);
      }
    }
  }
  return out;
}

function fanFromPolygon(polygon: number[], out: number[]): void {
  for (let i = 1; i < polygon.length / 2 - 1; i++) {
    const ax = polygon[0]!;
    const ay = polygon[1]!;
    const bx = polygon[i * 2]!;
    const by = polygon[i * 2 + 1]!;
    const cx = polygon[i * 2 + 2]!;
    const cy = polygon[i * 2 + 3]!;
    if (Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) > 1e-18) {
      out.push(ax, ay, bx, by, cx, cy);
    }
  }
}

function subtractTriangle(triangle: number[], hole: number[], out: number[]): void {
  let remaining = triangle;
  for (let i = 0; i < 3 && remaining.length >= 6; i++) {
    const ax = hole[i * 2]!;
    const ay = hole[i * 2 + 1]!;
    const bx = hole[((i + 1) % 3) * 2]!;
    const by = hole[((i + 1) % 3) * 2 + 1]!;
    const side = (x: number, y: number): number => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    // Match the proven leaflet-gpu subtraction: the piece on the negative side
    // of each hole edge is filled, the rest continues to the next edge.
    fanFromPolygon(
      clipHalfPlane(remaining, (x, y) => -side(x, y)),
      out,
    );
    remaining = clipHalfPlane(remaining, side);
  }
}

/**
 * Triangulates one polygon (exterior ring plus holes) expressed as vertex pools.
 * Returns world/plane coordinates as `[ax, ay, bx, by, cx, cy, ...]`.
 */
export function triangulatePolygonWithHoles(
  vertices: Float64Array,
  rings: Uint32Array,
  ringOuter: Uint8Array,
): number[] {
  const outerRings: Ring[] = [];
  const holeRings: Ring[] = [];
  for (let r = 0; r < rings.length; r += 2) {
    const ring: Ring = { vertices, start: rings[r]!, count: rings[r + 1]! };
    if (ringOuter[r / 2] === 1) outerRings.push(ring);
    else holeRings.push(ring);
  }
  const out: number[] = [];
  for (const outer of outerRings) {
    let triangles: number[] = [];
    earClip(vertices, outer.start, outer.count, triangles);
    for (const hole of holeRings) {
      const holeTriangles: number[] = [];
      earClip(vertices, hole.start, hole.count, holeTriangles);
      for (let h = 0; h < holeTriangles.length; h += 6) {
        const holeTriangle = holeTriangles.slice(h, h + 6);
        const minX = Math.min(holeTriangle[0]!, holeTriangle[2]!, holeTriangle[4]!);
        const maxX = Math.max(holeTriangle[0]!, holeTriangle[2]!, holeTriangle[4]!);
        const minY = Math.min(holeTriangle[1]!, holeTriangle[3]!, holeTriangle[5]!);
        const maxY = Math.max(holeTriangle[1]!, holeTriangle[3]!, holeTriangle[5]!);
        const next: number[] = [];
        for (let t = 0; t < triangles.length; t += 6) {
          const triangle = triangles.slice(t, t + 6);
          if (
            Math.max(triangle[0]!, triangle[2]!, triangle[4]!) < minX ||
            Math.min(triangle[0]!, triangle[2]!, triangle[4]!) > maxX ||
            Math.max(triangle[1]!, triangle[3]!, triangle[5]!) < minY ||
            Math.min(triangle[1]!, triangle[3]!, triangle[5]!) > maxY
          ) {
            next.push(...triangle);
          } else {
            subtractTriangle(triangle, holeTriangle, next);
          }
        }
        triangles = next;
      }
    }
    out.push(...triangles);
  }
  return out;
}
