/** Geometry-owned indexed tessellation, independent of view, layers and styles. */
import type { PolygonPayload } from '../geometry/geometry.ts';
import { BoundsTree } from '../geometry/bounds-tree.ts';
import { earcut } from './earcut.ts';
import { triangulatePolygonWithHoles } from './triangulate.ts';

export interface PolygonMesh { readonly vertices: Float64Array; readonly indices: Uint32Array; readonly blocks: BoundsTree }
const BLOCK_TRIANGLES = 128;
const meshes = new WeakMap<PolygonPayload, PolygonMesh>();
let builds = 0;
export function polygonMeshBuildCount(): number { return builds; }

function inside(vertices: Float64Array, start: number, count: number, x: number, y: number): boolean {
  let result = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const ax = vertices[(start + j) * 2]!, ay = vertices[(start + j) * 2 + 1]!;
    const bx = vertices[(start + i) * 2]!, by = vertices[(start + i) * 2 + 1]!;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) result = !result;
  }
  return result;
}

function crosses(v: Float64Array, a: number, b: number): boolean {
  const ax = v[a * 2]!, ay = v[a * 2 + 1]!, bx = v[(a + 1) * 2]!, by = v[(a + 1) * 2 + 1]!;
  const cx = v[b * 2]!, cy = v[b * 2 + 1]!, dx = v[(b + 1) * 2]!, dy = v[(b + 1) * 2 + 1]!;
  const ac = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), ad = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const ca = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), cb = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  // Bounds already overlap. Collinear contact uses the compatibility path too.
  return ac * ad <= 0 && ca * cb <= 0;
}

/** Old imports accepted clipping holes (outside/touching/overlapping). Keep that behavior. */
function regularTopology(payload: PolygonPayload): boolean {
  const { ringVertices: v, rings, ringOuter } = payload;
  const ringCount = rings.length / 2, boxes = new Float64Array(ringCount * 4);
  const edgeStarts: number[] = [], edgeRings: number[] = [];
  let outer = -1;
  const parents = new Int32Array(ringCount);
  for (let ring = 0; ring < ringCount; ring++) {
    const start = rings[ring * 2]!, count = rings[ring * 2 + 1]! - 1;
    if (ringOuter[ring] === 1) outer = ring;
    if (outer < 0) return false;
    parents[ring] = outer;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = start; i < start + count; i++) {
      edgeStarts.push(i); edgeRings.push(ring);
      minX = Math.min(minX, v[i * 2]!); minY = Math.min(minY, v[i * 2 + 1]!);
      maxX = Math.max(maxX, v[i * 2]!); maxY = Math.max(maxY, v[i * 2 + 1]!);
    }
    boxes.set([minX, minY, maxX, maxY], ring * 4);
  }
  const edges = new Float64Array(edgeStarts.length * 4);
  edgeStarts.forEach((at, i) => edges.set([Math.min(v[at * 2]!, v[(at + 1) * 2]!), Math.min(v[at * 2 + 1]!, v[(at + 1) * 2 + 1]!),
    Math.max(v[at * 2]!, v[(at + 1) * 2]!), Math.max(v[at * 2 + 1]!, v[(at + 1) * 2 + 1]!)], i * 4));
  const edgeTree = new BoundsTree(edges);
  for (let i = 0; i < edgeStarts.length; i++) {
    const a = edgeStarts[i]!, ring = edgeRings[i]!;
    if (!edgeTree.query(edges[i * 4]!, edges[i * 4 + 1]!, edges[i * 4 + 2]!, edges[i * 4 + 3]!, (j) => {
      if (j <= i) return;
      const b = edgeStarts[j]!;
      if (edgeRings[j] === ring && (b === a + 1 || a === rings[ring * 2] && b === rings[ring * 2]! + rings[ring * 2 + 1]! - 2)) return;
      if (crosses(v, a, b)) return false;
    })) return false;
  }
  const ringTree = new BoundsTree(boxes);
  for (let ring = 0; ring < ringCount; ring++) {
    const at = rings[ring * 2]! * 2, x = v[at]!, y = v[at + 1]!;
    if (ringOuter[ring] !== 1 && !inside(v, rings[parents[ring]! * 2]!, rings[parents[ring]! * 2 + 1]!, x, y)) return false;
    if (!ringTree.query(x, y, x, y, (other) => {
      if (other === ring || other === parents[ring]) return;
      if (inside(v, rings[other * 2]!, rings[other * 2 + 1]!, x, y)) return false;
    })) return false;
  }
  return true;
}

export function polygonMesh(payload: PolygonPayload): PolygonMesh {
  const cached = meshes.get(payload);
  if (cached) return cached;
  builds++;
  let vertices: Float64Array, indices: Uint32Array;
  if (!regularTopology(payload)) {
    vertices = Float64Array.from(triangulatePolygonWithHoles(payload.ringVertices, payload.rings, payload.ringOuter));
    indices = Uint32Array.from({ length: vertices.length / 2 }, (_, i) => i);
  } else {
    const output: number[] = [];
    const { rings, ringOuter } = payload;
    vertices = payload.ringVertices;
    for (let ring = 0; ring < ringOuter.length;) {
      const data: number[] = [], mapping: number[] = [], holes: number[] = [];
      const originX = vertices[rings[ring * 2]! * 2]!, originY = vertices[rings[ring * 2]! * 2 + 1]!;
      do {
        if (data.length) holes.push(mapping.length);
        const start = rings[ring * 2]!, count = rings[ring * 2 + 1]! - 1;
        for (let i = start; i < start + count; i++) { data.push(vertices[i * 2]! - originX, vertices[i * 2 + 1]! - originY); mapping.push(i); }
        ring++;
      } while (ring < ringOuter.length && ringOuter[ring] === 0);
      for (const index of earcut(data, holes)) output.push(mapping[index]!);
    }
    indices = Uint32Array.from(output);
  }
  const boxes = new Float64Array(Math.ceil(indices.length / (3 * BLOCK_TRIANGLES)) * 4);
  for (let block = 0; block < boxes.length / 4; block++) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = block * 3 * BLOCK_TRIANGLES; i < Math.min(indices.length, (block + 1) * 3 * BLOCK_TRIANGLES); i++) {
      const at = indices[i]! * 2;
      minX = Math.min(minX, vertices[at]!); minY = Math.min(minY, vertices[at + 1]!);
      maxX = Math.max(maxX, vertices[at]!); maxY = Math.max(maxY, vertices[at + 1]!);
    }
    boxes.set([minX, minY, maxX, maxY], block * 4);
  }
  const mesh = { vertices, indices, blocks: new BoundsTree(boxes) };
  meshes.set(payload, mesh);
  return mesh;
}

/** Retain triangle order; remap only selected vertices, clip huge triangles before Float32. */
export function visiblePolygon(mesh: PolygonMesh, rect: { minX: number; minY: number; maxX: number; maxY: number }, scale: number): {
  vertices: Float64Array; indices: Uint32Array;
} {
  const selected: number[] = [];
  mesh.blocks.query(rect.minX, rect.minY, rect.maxX, rect.maxY, (block) => { selected.push(block); });
  selected.sort((a, b) => a - b);
  const vertices: number[] = [], indices: number[] = [], mapping = new Map<number, number>();
  for (const block of selected) for (let i = block * 3 * BLOCK_TRIANGLES; i < Math.min(mesh.indices.length, (block + 1) * 3 * BLOCK_TRIANGLES); i += 3) {
    const triangle = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const index of triangle) {
      minX = Math.min(minX, mesh.vertices[index * 2]!); minY = Math.min(minY, mesh.vertices[index * 2 + 1]!);
      maxX = Math.max(maxX, mesh.vertices[index * 2]!); maxY = Math.max(maxY, mesh.vertices[index * 2 + 1]!);
    }
    if (minX > rect.maxX || maxX < rect.minX || minY > rect.maxY || maxY < rect.minY) continue;
    if (Math.max(rect.maxX - minX, maxX - rect.minX, rect.maxY - minY, maxY - rect.minY) * scale <= 16384) {
      for (const index of triangle) {
        let output = mapping.get(index);
        if (output === undefined) { output = vertices.length / 2; mapping.set(index, output); vertices.push(mesh.vertices[index * 2]!, mesh.vertices[index * 2 + 1]!); }
        indices.push(output);
      }
      continue;
    }
    let polygon = triangle.map((index) => [mesh.vertices[index * 2]!, mesh.vertices[index * 2 + 1]!] as [number, number]);
    for (const [axis, limit, sign] of [[0, rect.minX, 1], [0, rect.maxX, -1], [1, rect.minY, 1], [1, rect.maxY, -1]] as const) {
      const output: [number, number][] = [];
      for (let j = 0; j < polygon.length; j++) {
        const a = polygon[j]!, b = polygon[(j + 1) % polygon.length]!;
        const da = (a[axis] - limit) * sign, db = (b[axis] - limit) * sign;
        if (da >= 0) output.push(a);
        if ((da < 0) !== (db < 0)) {
          const t = da / (da - db), point: [number, number] = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
          point[axis] = limit; output.push(point);
        }
      }
      polygon = output;
    }
    const first = vertices.length / 2;
    for (const point of polygon) vertices.push(...point);
    for (let j = 1; j < polygon.length - 1; j++) indices.push(first, first + j, first + j + 1);
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}
