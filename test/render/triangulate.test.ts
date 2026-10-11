import test from 'node:test';
import assert from 'node:assert/strict';

import { triangulatePolygonWithHoles } from '../../src/render/triangulate.ts';

/**
 * Geometry helpers for triangulation fixtures.
 * A polygon is a list of rings; a hole is any ring after the first. The builder
 * closes each ring and concatenates them into the canonical pools.
 */
type Point = readonly [number, number];
type Ring = readonly Point[];
type Polygon = readonly Ring[];

function build(polygons: readonly Polygon[]): {
  vertices: Float64Array;
  rings: Uint32Array;
  ringOuter: Uint8Array;
} {
  const vertices: number[] = [];
  const rings: number[] = [];
  const outer: number[] = [];
  let start = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      const closed: Point[] = [...ring, ring[0]!];
      for (const [x, y] of closed) vertices.push(x, y);
      rings.push(start, closed.length);
      outer.push(index === 0 ? 1 : 0);
      start += closed.length;
    });
  }
  return {
    vertices: Float64Array.from(vertices),
    rings: Uint32Array.from(rings),
    ringOuter: Uint8Array.from(outer),
  };
}

function area(triangles: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < triangles.length; i += 6) {
    sum +=
      Math.abs(
        (triangles[i + 2]! - triangles[i]!) * (triangles[i + 5]! - triangles[i + 1]!) -
          (triangles[i + 4]! - triangles[i]!) * (triangles[i + 3]! - triangles[i + 1]!),
      ) / 2;
  }
  return sum;
}

function covered(triangles: readonly number[], x: number, y: number): boolean {
  for (let i = 0; i < triangles.length; i += 6) {
    const ax = triangles[i]!;
    const ay = triangles[i + 1]!;
    const bx = triangles[i + 2]!;
    const by = triangles[i + 3]!;
    const cx = triangles[i + 4]!;
    const cy = triangles[i + 5]!;
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    const hasNeg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12;
    const hasPos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12;
    if (!(hasNeg && hasPos)) return true;
  }
  return false;
}

const square: Ring = [[0, 0], [4, 0], [4, 4], [0, 4]];

test('triangulation preserves the area of a simple square', () => {
  const geometry = build([[square]]);
  const triangles = triangulatePolygonWithHoles(geometry.vertices, geometry.rings, geometry.ringOuter);
  assert.ok(Math.abs(area(triangles) - 16) < 1e-9);
  assert.equal(covered(triangles, 2, 2), true);
  assert.equal(covered(triangles, 5, 2), false);
});

test('GEOM-09: a hole stays empty while the fill surrounds it', () => {
  const geometry = build([
    [
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[3, 3], [3, 7], [7, 7], [7, 3]],
    ],
  ]);
  const triangles = triangulatePolygonWithHoles(geometry.vertices, geometry.rings, geometry.ringOuter);
  assert.ok(Math.abs(area(triangles) - (100 - 16)) < 1e-9, `area ${area(triangles)}`);
  assert.equal(covered(triangles, 5, 5), false, 'hole center is not covered');
  assert.equal(covered(triangles, 1, 5), true, 'fill left of the hole is covered');
  assert.equal(covered(triangles, 9, 9), true);
});

test('GEOM-10: reversed ring orientation keeps the same fill and hole', () => {
  const geometry = build([
    [
      [[10, 0], [0, 0], [0, 10], [10, 10]],
      [[3, 7], [3, 3], [7, 3], [7, 7]],
    ],
  ]);
  const triangles = triangulatePolygonWithHoles(geometry.vertices, geometry.rings, geometry.ringOuter);
  assert.ok(Math.abs(area(triangles) - 84) < 1e-9, `area ${area(triangles)}`);
  assert.equal(covered(triangles, 5, 5), false);
  assert.equal(covered(triangles, 5, 1), true);
});

test('GEOM-11: multiple outer rings and holes stay separate', () => {
  const geometry = build([
    [
      [[0, 0], [4, 0], [4, 4], [0, 4]],
      [[1, 1], [1, 2], [2, 2], [2, 1]],
    ],
    [[[10, 10], [14, 10], [14, 14], [10, 14]]],
  ]);
  const triangles = triangulatePolygonWithHoles(geometry.vertices, geometry.rings, geometry.ringOuter);
  assert.ok(Math.abs(area(triangles) - (16 - 1 + 16)) < 1e-9, `area ${area(triangles)}`);
  assert.equal(covered(triangles, 1.5, 1.5), false, 'hole of the first polygon');
  assert.equal(covered(triangles, 12, 12), true, 'second polygon is filled');
});

test('concave polygons keep their exact area', () => {
  const geometry = build([[[[0, 0], [2, 0], [2, 1], [1, 0.4], [0, 1]]]]);
  const triangles = triangulatePolygonWithHoles(geometry.vertices, geometry.rings, geometry.ringOuter);
  assert.ok(Math.abs(area(triangles) - 1.4) < 1e-6, `area ${area(triangles)}`);
});

test('degenerate rings produce no triangles instead of NaN', () => {
  const geometry = build([[[[0, 0], [0, 0], [0, 0]]]]);
  const triangles = triangulatePolygonWithHoles(geometry.vertices, geometry.rings, geometry.ringOuter);
  assert.equal(triangles.length, 0);
});
