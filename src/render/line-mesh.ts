/** Geometry-owned adjacency and double-precision arc lengths, indexed in spatial blocks. */
import type { LinePayload, PolygonPayload } from '../geometry/geometry.ts';
import { BoundsTree } from '../geometry/bounds-tree.ts';

export interface LineMesh {
  readonly vertices: Float64Array;
  readonly starts: Uint32Array;
  readonly arcs: Float64Array;
  readonly lengths: Float64Array;
  readonly blocks: BoundsTree;
}
const meshes = new WeakMap<LinePayload | PolygonPayload, LineMesh>();
const BLOCK_SIZE = 128;

export function lineMesh(payload: LinePayload | PolygonPayload): LineMesh {
  const cached = meshes.get(payload);
  if (cached) return cached;
  const vertices = 'vertices' in payload ? payload.vertices : payload.ringVertices;
  const parts = 'parts' in payload ? payload.parts : payload.rings;
  const starts: number[] = [], arcs: number[] = [], lengths: number[] = [];
  for (let part = 0; part < parts.length; part += 2) {
    const start = parts[part]!, count = parts[part + 1]!;
    let arc = 0;
    for (let i = start; i < start + count - 1; i++) {
      const length = Math.hypot(vertices[(i + 1) * 2]! - vertices[i * 2]!, vertices[(i + 1) * 2 + 1]! - vertices[i * 2 + 1]!);
      if (length > 0) { starts.push(i); arcs.push(arc); lengths.push(length); }
      arc += length;
    }
  }
  const boxes = new Float64Array(Math.ceil(starts.length / BLOCK_SIZE) * 4);
  for (let block = 0; block < boxes.length / 4; block++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let row = block * BLOCK_SIZE; row < Math.min(starts.length, (block + 1) * BLOCK_SIZE); row++) {
      const at = starts[row]! * 2;
      x0 = Math.min(x0, vertices[at]!, vertices[at + 2]!); y0 = Math.min(y0, vertices[at + 1]!, vertices[at + 3]!);
      x1 = Math.max(x1, vertices[at]!, vertices[at + 2]!); y1 = Math.max(y1, vertices[at + 1]!, vertices[at + 3]!);
    }
    boxes.set([x0, y0, x1, y1], block * 4);
  }
  const mesh = { vertices, starts: Uint32Array.from(starts), arcs: Float64Array.from(arcs), lengths: Float64Array.from(lengths), blocks: new BoundsTree(boxes) };
  meshes.set(payload, mesh);
  return mesh;
}

/** Clip in Float64 before GPU conversion. Clipped endpoints stay beyond the view gutter. */
export function visitLineSegments(mesh: LineMesh, rect: { minX: number; minY: number; maxX: number; maxY: number },
  visit: (x0: number, y0: number, x1: number, y1: number, arc: number, length: number) => void): void {
  const blocks: number[] = [];
  const small = mesh.starts.length <= BLOCK_SIZE;
  // Small geometries retain complete submission/debug counts. Very long visible
  // segments still need precision clipping; spatial pruning pays off on larger pools.
  if (small && mesh.starts.length) blocks.push(0);
  else mesh.blocks.query(rect.minX, rect.minY, rect.maxX, rect.maxY, (block) => { blocks.push(block); });
  blocks.sort((a, b) => a - b);
  for (const block of blocks) for (let row = block * BLOCK_SIZE; row < Math.min(mesh.starts.length, (block + 1) * BLOCK_SIZE); row++) {
    const at = mesh.starts[row]! * 2, v = mesh.vertices;
    const x = v[at]!, y = v[at + 1]!, dx = v[at + 2]! - x, dy = v[at + 3]! - y;
    if (small && (Math.max(Math.abs(dx), Math.abs(dy)) <= 64 * Math.max(rect.maxX - rect.minX, rect.maxY - rect.minY) ||
      Math.min(x, x + dx) > rect.maxX || Math.max(x, x + dx) < rect.minX || Math.min(y, y + dy) > rect.maxY || Math.max(y, y + dy) < rect.minY)) {
      visit(x, y, x + dx, y + dy, mesh.arcs[row]!, mesh.lengths[row]!);
      continue;
    }
    let first = 0, last = 1;
    const boundary = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) { if (t > last) return false; first = Math.max(first, t); }
      else { if (t < first) return false; last = Math.min(last, t); }
      return true;
    };
    if (!boundary(-dx, x - rect.minX) || !boundary(dx, rect.maxX - x) || !boundary(-dy, y - rect.minY) || !boundary(dy, rect.maxY - y)) continue;
    if (last <= first) continue;
    visit(x + first * dx, y + first * dy, x + last * dx, y + last * dy, mesh.arcs[row]! + first * mesh.lengths[row]!, (last - first) * mesh.lengths[row]!);
  }
}
