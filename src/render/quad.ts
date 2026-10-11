/**
 * Screen-space quads shared by the textured sprite and label passes of both
 * backends (GEOM-04, TEXT-06). A quad is emitted as six triangle-list
 * vertices; the vertex order matches `QUAD_UVS`, so a rotated quad keeps its
 * texture orientation.
 */

/** Texture coordinates for the six vertices, in triangle-list order. */
export const QUAD_UVS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * Six vertices (x, y pairs) of a quad centred at `(cx, cy)` with the given CSS
 * size, rotated by `degrees` clockwise around `(pivotX, pivotY)` — the sprite's
 * declared anchor (the feature position), so an `iconAnchor` offset makes the
 * sprite orbit the anchor instead of the offset centre. Screen y grows
 * downwards, so the standard rotation matrix reads as a clockwise turn;
 * non-finite angles fall back to no rotation instead of a broken quad.
 */
export function quadVertices(
  cx: number,
  cy: number,
  width: number,
  height: number,
  degrees: number,
  pivotX: number = cx,
  pivotY: number = cy,
): Float32Array {
  const angle = Number.isFinite(degrees) ? degrees : 0;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const out = new Float32Array(12);
  for (let index = 0; index < 6; index++) {
    const [u, v] = QUAD_UVS[index]!;
    const lx = (u * 2 - 1) * (width / 2);
    const ly = (v * 2 - 1) * (height / 2);
    out[index * 2] = pivotX + (cx - pivotX + lx) * cos - (cy - pivotY + ly) * sin;
    out[index * 2 + 1] = pivotY + (cx - pivotX + lx) * sin + (cy - pivotY + ly) * cos;
  }
  return out;
}

/** Axis-aligned bounds of a quad from `quadVertices` (collision, culling). */
export function quadBounds(vertices: Float32Array): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let index = 0; index < 6; index++) {
    const x = vertices[index * 2]!;
    const y = vertices[index * 2 + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}
