/**
 * CPU instance expansion (the no-`ANGLE_instanced_arrays` path of the WebGL 1
 * backend). The third GPU profile found that the points path expanded four
 * strip corners and then drew `count * 6` vertices as TRIANGLES, mixing
 * corners of neighbouring instances; the browser battery
 * (`demo/parity.html --basic`) is the end-to-end proof, these assertions pin
 * the vertex layout the shaders depend on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { expandInstances } from '../../src/render/webgl1/backend.ts';

// The quad in TRIANGLES order used for points (six vertices, [-1, 1] corners).
const QUAD_TRIANGLES = [-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1];

test('expandInstances: corner then instance data per vertex, six vertices per instance', () => {
  const corners = new Float32Array(QUAD_TRIANGLES);
  const data = new Float32Array([1, 2, 3, 4, 5, 6]);
  const expanded = expandInstances(data, 3, 2, corners, 2);
  const perVertex = 2 + 3;
  assert.equal(expanded.length, 2 * 6 * perVertex, 'six TRIANGLES vertices per instance');
  assert.deepEqual(Array.from(expanded.slice(0, perVertex)), [-1, -1, 1, 2, 3], 'first vertex');
  const secondInstance = 6 * perVertex;
  assert.deepEqual(
    Array.from(expanded.slice(secondInstance, secondInstance + perVertex)),
    [-1, -1, 4, 5, 6],
    'second instance restarts the corners',
  );
  assert.deepEqual(
    Array.from(expanded.slice(expanded.length - perVertex)),
    [-1, 1, 4, 5, 6],
    'last corner of the last instance',
  );
});

test('expandInstances: zero instances produce an empty buffer', () => {
  const expanded = expandInstances(new Float32Array([]), 3, 0, new Float32Array(QUAD_TRIANGLES), 2);
  assert.equal(expanded.length, 0);
});
