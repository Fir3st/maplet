/**
 * Rotated quad geometry shared by the sprite and label passes (GEOM-04,
 * TEXT-06). The browser batteries verify the rendered result; these assertions
 * pin the vertex/UV order and the rotation convention the backends rely on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { QUAD_UVS, quadBounds, quadVertices } from '../../src/render/quad.ts';

test('quadVertices: unrotated quad follows the UV order', () => {
  assert.equal(QUAD_UVS.length, 6);
  const vertices = quadVertices(10, 20, 100, 40, 0);
  assert.deepEqual(Array.from(vertices), [
    10 - 50, 20 - 20,
    10 + 50, 20 - 20,
    10 - 50, 20 + 20,
    10 + 50, 20 - 20,
    10 + 50, 20 + 20,
    10 - 50, 20 + 20,
  ]);
});

test('quadVertices: 90 degrees clockwise swaps the box around the centre', () => {
  const vertices = quadVertices(10, 20, 100, 40, 90);
  // The UV (0,0) corner (-50,-20) turns clockwise to (20,-50): right of centre.
  assert.deepEqual(Array.from(vertices.slice(0, 2)), [30, -30]);
  const bounds = quadBounds(vertices);
  assert.deepEqual(bounds, { x0: -10, y0: -30, x1: 30, y1: 70 });
  // The quad centre stays at the anchor point.
  assert.equal((bounds.x0 + bounds.x1) / 2, 10);
  assert.equal((bounds.y0 + bounds.y1) / 2, 20);
});

test('quadVertices: a non-finite angle falls back to no rotation', () => {
  assert.deepEqual(Array.from(quadVertices(1, 2, 4, 6, Number.NaN)), Array.from(quadVertices(1, 2, 4, 6, 0)));
});

test('quadVertices: an offset quad orbits its declared pivot', () => {
  // The sprite centre sits 10 px above the pivot (a pin tip anchor); a quarter
  // turn puts the whole sprite to the right of the pivot (GEOM-04).
  const vertices = quadVertices(0, -10, 4, 4, 90, 0, 0);
  assert.deepEqual(quadBounds(vertices), { x0: 8, y0: -2, x1: 12, y1: 2 });
});

test('quadBounds: axis-aligned quad keeps its size', () => {
  assert.deepEqual(quadBounds(quadVertices(0, 0, 30, 20, 0)), { x0: -15, y0: -10, x1: 15, y1: 10 });
});
