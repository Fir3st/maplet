import test from 'node:test';
import assert from 'node:assert/strict';
import { GEOMETRY_KIND, type LinePayload } from '../../src/geometry/geometry.ts';
import { lineMesh, visitLineSegments } from '../../src/render/line-mesh.ts';

test('adjacency and arc lengths are cached in Float64 and reset at part boundaries', () => {
  const payload: LinePayload = { kind: GEOMETRY_KIND.multiLineString, vertices: Float64Array.of(0, 0, 3, 4, 9, 4, 100, 0, 100, 10), parts: Uint32Array.of(0, 3, 3, 2) };
  const mesh = lineMesh(payload);
  assert.equal(lineMesh(payload), mesh);
  assert.deepEqual(mesh.starts, Uint32Array.of(0, 1, 3));
  assert.deepEqual(mesh.arcs, Float64Array.of(0, 5, 0));
  assert.deepEqual(mesh.lengths, Float64Array.of(5, 6, 10));
});

test('a 100k-segment geometry selects local segments in painter order without losing dash phase', () => {
  const vertices = new Float64Array(200002);
  for (let i = 0; i <= 100000; i++) { vertices[i * 2] = i; vertices[i * 2 + 1] = 0; }
  const mesh = lineMesh({ kind: GEOMETRY_KIND.lineString, vertices, parts: Uint32Array.of(0, 100001) });
  const result: number[][] = [];
  visitLineSegments(mesh, { minX: 50100.25, maxX: 50104.75, minY: -1, maxY: 1 }, (...segment) => result.push(segment));
  assert.equal(result.length, 5);
  assert.deepEqual(result[0], [50100.25, 0, 50101, 0, 50100.25, 0.75]);
  assert.deepEqual(result.at(-1), [50104, 0, 50104.75, 0, 50104, 0.75]);
});

test('a long segment crossing a tiny viewport is clipped before Float32 conversion', () => {
  const mesh = lineMesh({ kind: GEOMETRY_KIND.lineString, vertices: Float64Array.of(-1e8, 3, 1e8, 3), parts: Uint32Array.of(0, 2) });
  const result: number[][] = [];
  visitLineSegments(mesh, { minX: -2, maxX: 2, minY: -5, maxY: 5 }, (...segment) => result.push(segment));
  assert.ok(Math.abs(result[0]![0]! + 2) < 1e-7);
  assert.ok(Math.abs(result[0]![2]! - 2) < 1e-7);
  assert.ok(Math.abs(result[0]![4]! - (1e8 - 2)) < 1e-7);
});
