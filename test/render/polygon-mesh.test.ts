import test from 'node:test';
import assert from 'node:assert/strict';
import { crs } from '../../src/index.ts';
import { prepareGeometry, type PolygonPayload } from '../../src/geometry/geometry.ts';
import { polygonMesh, polygonMeshBuildCount, visiblePolygon } from '../../src/render/polygon-mesh.ts';
import { earcut } from '../../src/render/earcut.ts';

type XY = readonly [number, number];
const cross = (a: XY, b: XY, p: XY) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function ringContains(ring: readonly XY[], p: XY): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function verify(rings: readonly (readonly XY[])[]): void {
  const geometry = prepareGeometry(crs.simple(), { type: 'polygon', rings: rings.map((ring) => ring.map(([x, y]) => ({ x, y }))) });
  const mesh = polygonMesh(geometry.payload as PolygonPayload);
  assert.equal(mesh.indices.length % 3, 0);
  const at = (index: number): XY => [mesh.vertices[index * 2]! / 256, -mesh.vertices[index * 2 + 1]! / 256];
  let sum = 0;
  const triangles: [XY, XY, XY][] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const triangle: [XY, XY, XY] = [at(mesh.indices[i]!), at(mesh.indices[i + 1]!), at(mesh.indices[i + 2]!)];
    triangles.push(triangle);
    const area = Math.abs(cross(triangle[0], triangle[1], triangle[2])) / 2;
    assert.ok(area > 0);
    sum += area;
    for (const weights of [[1 / 3, 1 / 3, 1 / 3], [0.1, 0.2, 0.7], [0.2, 0.7, 0.1]]) {
      const p: XY = [triangle.reduce((value, vertex, j) => value + vertex[0] * weights[j]!, 0), triangle.reduce((value, vertex, j) => value + vertex[1] * weights[j]!, 0)];
      assert.ok(ringContains(rings[0]!, p), 'triangle must stay inside exterior');
      assert.ok(rings.slice(1).every((ring) => !ringContains(ring, p)), 'triangle must not cover a hole');
    }
  }
  const area = (ring: readonly XY[]) => Math.abs(ring.reduce((sum, p, i) => sum + p[0] * ring[(i + 1) % ring.length]![1] - p[1] * ring[(i + 1) % ring.length]![0], 0)) / 2;
  assert.ok(Math.abs(sum - area(rings[0]!) + rings.slice(1).reduce((sum, ring) => sum + area(ring), 0)) < 1e-7);
  // Coverage and non-overlap are independent of the tessellator's area sum.
  // Noncommensurate offsets avoid ambiguous samples exactly on shared diagonals.
  for (let y = -9.89317; y < 10; y += 0.73121) for (let x = -9.77651; x < 10; x += 0.61837) {
    const p: XY = [x, y];
    const covered = triangles.filter(([a, b, c]) => {
      const signs = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
      return signs.every((s) => s > 1e-10) || signs.every((s) => s < -1e-10);
    }).length;
    const inside = ringContains(rings[0]!, p) && rings.slice(1).every((ring) => !ringContains(ring, p));
    assert.equal(covered, inside ? 1 : 0, `coverage at ${p}`);
  }
}

test('indexed concave polygons and multiple holes preserve coverage without overlap', () => {
  verify([[[-10, -10], [10, -10], [10, 10], [2, 10], [2, 3], [-2, 3], [-2, 10], [-10, 10]],
    [[-8, -8], [-4, -8], [-4, -4], [-8, -4]], [[4, -8], [8, -8], [8, -4], [4, -4]]]);
  for (let seed = 0; seed < 10; seed++) {
    const ring = Array.from({ length: 96 }, (_, i): XY => {
      const a = i * Math.PI * 2 / 96, radius = 7 + 2 * Math.sin(i * 1.3 + seed);
      return [Math.cos(a) * radius, Math.sin(a) * radius];
    });
    verify([ring, [[-1, -1], [1, -1], [1, 1], [-1, 1]]]);
  }
});

test('large geometry is fully validated and keeps one cached indexed mesh', () => {
  const positions = Array.from({ length: 20000 }, (_, i) => ({ x: Math.cos(i * Math.PI / 10000), y: Math.sin(i * Math.PI / 10000) }));
  const payload = prepareGeometry(crs.simple(), { type: 'polygon', rings: [positions] }).payload as PolygonPayload;
  const before = polygonMeshBuildCount(), mesh = polygonMesh(payload);
  assert.equal(mesh.indices.length, (20000 - 2) * 3);
  assert.equal(mesh.vertices, payload.ringVertices);
  assert.equal(polygonMesh(payload), mesh);
  assert.equal(polygonMeshBuildCount(), before + 1);
  const crossed = positions.slice();
  [crossed[5000], crossed[15000]] = [crossed[15000]!, crossed[5000]!];
  assert.throws(() => prepareGeometry(crs.simple(), { type: 'polygon', rings: [crossed] }), /self-intersecting/);
});

test('XY Earcut handles collinear vertices and preserves original indexed vertices', () => {
  const data = [0, 0, 1, 0, 2, 0, 2, 2, 0, 2];
  const indices = earcut(data);
  assert.equal(indices.length, 9);
  assert.ok(indices.every((index) => Number.isInteger(index) && index >= 0 && index < 5));
});

test('compatibility holes outside, touching, overlapping or nested subtract their union', () => {
  const outer: readonly XY[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  const fixtures: (readonly (readonly XY[])[])[] = [
    [outer, [[8, -3], [12, -3], [12, 3], [8, 3]]],
    [outer, [[8, -3], [10, -3], [10, 3], [8, 3]]],
    [outer, [[-4, -4], [2, -4], [2, 2], [-4, 2]], [[-2, -2], [4, -2], [4, 4], [-2, 4]]],
    [outer, [[-4, -4], [4, -4], [4, 4], [-4, 4]], [[-2, -2], [2, -2], [2, 2], [-2, 2]]],
  ];
  for (const rings of fixtures) {
    const payload = prepareGeometry(crs.simple(), { type: 'polygon', rings: rings.map(ring => ring.map(([x, y]) => ({ x, y }))) }).payload as PolygonPayload;
    const mesh = polygonMesh(payload);
    const at = (index: number): XY => [mesh.vertices[index * 2]! / 256, -mesh.vertices[index * 2 + 1]! / 256];
    for (let y = -9.89317; y < 10; y += 0.73121) for (let x = -9.77651; x < 10; x += 0.61837) {
      const p: XY = [x, y];
      let covered = 0;
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = at(mesh.indices[i]!), b = at(mesh.indices[i + 1]!), c = at(mesh.indices[i + 2]!);
        const signs = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
        if (signs.every(s => s > 1e-10) || signs.every(s => s < -1e-10)) covered++;
      }
      const expected = ringContains(outer, p) && rings.slice(1).every(ring => !ringContains(ring, p));
      assert.equal(covered, expected ? 1 : 0, `compatibility coverage at ${p}`);
    }
    assert.equal(polygonMesh(payload), mesh, 'compatibility meshes are retained too');
  }
});

test('large triangles are clipped in Float64 while canonical geometry remains complete', () => {
  const payload = prepareGeometry(crs.simple(), { type: 'polygon', rings: [[{ x: -1e6, y: -1e6 }, { x: 1e6, y: -1e6 }, { x: 0, y: 1e6 }]] }).payload as PolygonPayload;
  const mesh = polygonMesh(payload), original = mesh.vertices.slice();
  const visible = visiblePolygon(mesh, { minX: -10, minY: -10, maxX: 10, maxY: 10 }, 2 ** 24);
  assert.deepEqual(mesh.vertices, original);
  assert.ok(visible.vertices.every((value) => value >= -10 && value <= 10));
  let area = 0;
  for (let i = 0; i < visible.indices.length; i += 3) {
    const a = visible.indices[i]! * 2, b = visible.indices[i + 1]! * 2, c = visible.indices[i + 2]! * 2;
    area += Math.abs((visible.vertices[b]! - visible.vertices[a]!) * (visible.vertices[c + 1]! - visible.vertices[a + 1]!) -
      (visible.vertices[c]! - visible.vertices[a]!) * (visible.vertices[b + 1]! - visible.vertices[a + 1]!)) / 2;
  }
  assert.ok(Math.abs(area - 400) < 1e-8);
});
