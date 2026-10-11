import test from 'node:test';
import assert from 'node:assert/strict';

import { columnarToFeatures, isMapletError } from '../../src/index.ts';
import type { FeatureInput } from '../../src/index.ts';

function importInvalid(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => isMapletError(error) && error.code === 'import-invalid');
}

const geographic = { positionKind: 'geographic' } as const;

test('IO-05: a point batch maps vertices to features with ids, altitudes and properties', () => {
  const features = columnarToFeatures(
    {
      kind: 'point',
      positions: Float64Array.of(14, 50, 14.1, 50.1, 14.2, 50.2),
      altitudes: Float64Array.of(100, Number.NaN, 300),
      ids: ['a', undefined, 7],
      properties: [{ name: 'A' }, undefined, { name: 'C', rank: 3 }],
    },
    geographic,
  );
  assert.equal(features.length, 3);
  const first = features[0] as unknown as { id?: unknown; geometry: { position: Record<string, number> }; properties?: Record<string, unknown> };
  assert.equal(first.id, 'a');
  assert.deepEqual(first.geometry.position, { lng: 14, lat: 50, altitude: 100 });
  assert.deepEqual(first.properties, { name: 'A' });
  const second = features[1] as unknown as { id?: unknown; geometry: { position: Record<string, number> }; properties?: Record<string, unknown> };
  assert.equal(second.id, undefined, 'an undefined id entry keeps the generated-id policy');
  assert.deepEqual(second.geometry.position, { lng: 14.1, lat: 50.1 }, 'NaN altitude means no altitude');
  assert.equal(second.properties, undefined);
  const third = features[2] as unknown as { id?: unknown; geometry: { position: Record<string, number> } };
  assert.equal(third.id, 7);
  assert.equal(third.geometry.position.altitude, 300);
});

test('IO-05: a planar point batch uses { x, y } positions and Float32 input', () => {
  const features = columnarToFeatures(
    { kind: 'point', positions: Float32Array.of(-40, 90) },
    { positionKind: 'planar' },
  );
  assert.equal(features.length, 1);
  const geometry = (features[0] as unknown as { geometry: { position: { x: number; y: number } } }).geometry;
  assert.deepEqual(geometry.position, { x: -40, y: 90 });
});

test('IO-05: line string parts become lineString or multiLineString features', () => {
  const positions = Float64Array.of(0, 0, 1, 0, 2, 0, 10, 10, 11, 10);
  const parts = Int32Array.of(0, 3, 5);
  const perPart = columnarToFeatures(
    { kind: 'lineString', positions, partOffsets: parts },
    geographic,
  );
  assert.equal(perPart.length, 2, 'without featurePartOffsets every part is one feature');
  assert.equal((perPart[0] as unknown as { geometry: { type: string } }).geometry.type, 'lineString');
  assert.equal((perPart[1] as unknown as { geometry: { type: string } }).geometry.type, 'lineString');

  const oneFeature = columnarToFeatures(
    {
      kind: 'lineString',
      positions,
      partOffsets: parts,
      featurePartOffsets: Uint32Array.of(0, 2),
      ids: ['both'],
    },
    geographic,
  );
  assert.equal(oneFeature.length, 1);
  const geometry = (oneFeature[0] as unknown as { geometry: { type: string; lines: unknown[] } }).geometry;
  assert.equal(geometry.type, 'multiLineString');
  assert.equal(geometry.lines.length, 2);
});

test('IO-05: polygon parts are rings; the first ring is the exterior, the rest are holes', () => {
  const positions = Float64Array.of(
    0, 0, 10, 0, 10, 10, 0, 10,
    2, 2, 2, 4, 4, 4, 4, 2,
  );
  const rings = Int32Array.of(0, 4, 8);
  const features = columnarToFeatures(
    {
      kind: 'polygon',
      positions,
      partOffsets: rings,
      featurePartOffsets: Int32Array.of(0, 2),
      ids: ['donut'],
    },
    geographic,
  );
  assert.equal(features.length, 1);
  const geometry = (features[0] as unknown as { geometry: { type: string; rings: unknown[][] } }).geometry;
  assert.equal(geometry.type, 'polygon');
  assert.equal(geometry.rings.length, 2);
  assert.equal(geometry.rings[0]?.length, 4);
});

test('IO-05: malformed batches are rejected as import-invalid before anything is built', () => {
  // Never a typed array.
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: [1, 2] as never }, geographic));
  // Odd number of coordinates.
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2, 3) }, geographic));
  // Non-finite coordinates.
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, Number.NaN) }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, Number.POSITIVE_INFINITY) }, geographic));
  // Altitudes: wrong type, wrong length, planar CRS.
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2), altitudes: [1] as never }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2, 3, 4), altitudes: Float64Array.of(1) }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2), altitudes: Float64Array.of(1) }, { positionKind: 'planar' }));
  // A point batch must not carry offsets.
  importInvalid(() =>
    columnarToFeatures(
      { kind: 'point', positions: Float64Array.of(1, 2), partOffsets: Int32Array.of(0, 1) } as never,
      geographic,
    ),
  );
  // Offsets: wrong type, degenerate, not anchored at 0, not ending at the vertex count.
  importInvalid(() => columnarToFeatures({ kind: 'lineString', positions: Float64Array.of(0, 0, 1, 1), partOffsets: [0, 2] as never }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'lineString', positions: Float64Array.of(0, 0, 1, 1), partOffsets: Int32Array.of(0) }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'lineString', positions: Float64Array.of(0, 0, 1, 1), partOffsets: Int32Array.of(1, 2) }, geographic));
  // A last index beyond the buffer is rejected instead of being read (no OOB read).
  importInvalid(() => columnarToFeatures({ kind: 'lineString', positions: Float64Array.of(0, 0, 1, 1), partOffsets: Int32Array.of(0, 9) }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'lineString', positions: Float64Array.of(0, 0, 1, 1), partOffsets: Int32Array.of(0, 2, 1, 2) }, geographic));
  // featurePartOffsets must anchor to the part count.
  importInvalid(() =>
    columnarToFeatures(
      { kind: 'polygon', positions: Float64Array.of(0, 0, 1, 0, 1, 1), partOffsets: Int32Array.of(0, 3), featurePartOffsets: Int32Array.of(0, 5) },
      geographic,
    ),
  );
  // ids/properties must hold exactly one entry per feature.
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2, 3, 4), ids: ['only-one'] }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2), properties: [1] as never }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2), properties: [{}, {}] }, geographic));
  // Numeric ids must stay exactly representable (64-bit rule).
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2), ids: [2 ** 53] }, geographic));
  importInvalid(() => columnarToFeatures({ kind: 'point', positions: Float64Array.of(1, 2), ids: [1.5] }, geographic));
  // Unknown kinds.
  importInvalid(() => columnarToFeatures({ kind: 'circle', positions: Float64Array.of(1, 2) } as never, geographic));
});

test('IO-05: an empty point batch is a valid empty input; parts batches need one part', () => {
  const features = columnarToFeatures({ kind: 'point', positions: Float64Array.of() }, geographic);
  assert.equal(features.length, 0);
  importInvalid(() =>
    columnarToFeatures({ kind: 'polygon', positions: Float64Array.of(), partOffsets: Int32Array.of(0, 0) }, geographic),
  );
});

test('IO-06: the conversion reads the input without retaining it', () => {
  const positions = Float64Array.of(14, 50, 14.1, 50.1);
  const features = columnarToFeatures({ kind: 'point', positions }, geographic);
  positions[0] = 99;
  const geometry = (features[0] as unknown as { geometry: { position: { lng: number } } }).geometry;
  assert.equal(geometry.position.lng, 14, 'features keep the value read at conversion time');
  assert.equal((features[0] as FeatureInput).geometry.type, 'point');
});
