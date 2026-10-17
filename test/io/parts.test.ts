import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crs,
  columnarToFeatures,
  type Position,
  type PlanarPosition,
  type GeoPosition,
} from '../../src/index.ts';
import { prepareGeometry } from '../../src/geometry/geometry.ts';
import { nativeProjectionCode } from '../../src/math/crs.ts';
import { prepareParts, validPreparedParts } from '../../src/io/parts.ts';
import type { ColumnarPartsBatch } from '../../src/io/columnar.ts';
import { Scene } from '../../src/scene/scene.ts';
import { manualClock } from '../helpers/fixture.ts';

test('binary parts share normalization and exact canonical coordinates with public ingest', () => {
  for (const projection of [crs.simple(), crs.webMercator(), crs.epsg4326(), crs.epsg3395()]) {
    for (const kind of ['polygon', 'lineString'] as const) {
      const batch: ColumnarPartsBatch = {
        kind,
        positions: Float64Array.of(
          14,
          50,
          14.1,
          50,
          14.1,
          50,
          14.1,
          50.1,
          14,
          50.1,
          14.02,
          50.02,
          14.02,
          50.04,
          14.04,
          50.04,
          14.04,
          50.02,
        ),
        partOffsets: Uint32Array.of(0, 5, 9),
        featurePartOffsets: Uint32Array.of(0, 2),
      };
      const legacy = columnarToFeatures(batch, { positionKind: projection.positionKind }).map(
        (input) => prepareGeometry(projection, input.geometry),
      );
      const binary = prepareParts(batch, projection);
      assert.deepEqual(binary.geometries, legacy);
      assert.equal(validPreparedParts(binary), true);
      batch.positions.fill(99);
      assert.deepEqual(binary.geometries, legacy, 'canonical data never aliases the input');
    }
  }
});

test('binary worker schema rejects nonfinite, missing, overlapping and out-of-bounds pools', () => {
  const input = {
    kind: 'polygon' as const,
    positions: Float64Array.of(0, 0, 1, 0, 1, 1, 0, 1),
    partOffsets: Uint32Array.of(0, 4),
  };
  const good = prepareParts(input, crs.simple());
  assert.equal(validPreparedParts(good), true);
  const mutations = [
    (value: typeof good) => {
      value.geometries[0]!.bbox[0] = NaN;
    },
    (value: typeof good) => {
      (value.geometries[0]!.payload as { ringVertices: Float64Array }).ringVertices[0] = Infinity;
    },
    (value: typeof good) => {
      (value.geometries[0]!.payload as { rings: Uint32Array }).rings[0] = 1;
    },
    (value: typeof good) => {
      (value.geometries[0]!.payload as { rings: Uint32Array }).rings[1] = 0xffffffff;
    },
    (value: typeof good) => {
      delete (value.geometries[0]!.payload as unknown as { ringOuter?: unknown }).ringOuter;
    },
    (value: typeof good) => {
      (value.geometries[0]!.payload as { altitudes?: unknown }).altitudes = Float64Array.of(1);
    },
    (value: typeof good) => {
      (value.geometries[0]!.payload as { altitudes?: unknown }).altitudes = [1, 2, 3, 4];
    },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.equal(validPreparedParts(bad), false);
  }
});

test('binary worker schema accepts a matching altitude column and drops it when vertices change', () => {
  const batch: ColumnarPartsBatch = {
    kind: 'lineString',
    positions: Float64Array.of(14, 50, 14.1, 50.1, 14.2, 50),
    altitudes: Float64Array.of(100, Number.NaN, 300),
    partOffsets: Uint32Array.of(0, 3),
  };
  const prepared = prepareParts(batch, crs.webMercator());
  assert.equal(validPreparedParts(prepared), true);
  assert.deepEqual(
    (prepared.geometries[0]!.payload as { altitudes: Float64Array }).altitudes,
    Float64Array.of(100, Number.NaN, 300),
  );
  // A Float32 input column is widened once into the canonical Float64 payload.
  const narrow = prepareParts(
    { ...batch, altitudes: Float32Array.of(50, 60, 70) },
    crs.webMercator(),
  );
  const widened = (narrow.geometries[0]!.payload as { altitudes: Float64Array }).altitudes;
  assert.ok(widened instanceof Float64Array);
  assert.deepEqual(widened, Float64Array.of(50, 60, 70));
  const { altitudes: _altitudes, ...withoutAltitudesBatch } = batch;
  const withoutAltitudes = prepareParts(withoutAltitudesBatch, crs.webMercator());
  assert.equal(validPreparedParts(withoutAltitudes), true);
  assert.ok(
    !('altitudes' in withoutAltitudes.geometries[0]!.payload),
    'an altitude-free batch stores no column',
  );
});

test('custom CRS callbacks cannot be serialized just by using a built-in code', () => {
  const original = crs.simple();
  assert.equal(nativeProjectionCode(original), 'SIMPLE');
  assert.equal(nativeProjectionCode({ ...original }), undefined);
  const custom = {
    ...original,
    toWorld: (position: Position) => ({
      x: (position as PlanarPosition).x * 512,
      y: (position as PlanarPosition).y * 512,
    }),
  };
  const binary = prepareParts(
    {
      kind: 'lineString',
      positions: Float64Array.of(1, 2, 3, 4),
      partOffsets: Uint32Array.of(0, 2),
    },
    custom,
  );
  assert.deepEqual(
    (binary.geometries[0]!.payload as { vertices: Float64Array }).vertices,
    Float64Array.of(512, 1024, 1536, 2048),
  );
});

test('binary custom-CRS projection preserves altitude inputs in payloads', () => {
  const projection = {
    ...crs.webMercator(),
    toWorld: (position: Position) => {
      const geo = position as GeoPosition;
      return { x: geo.lng + (geo.altitude ?? 0), y: geo.lat };
    },
  };
  const batch: ColumnarPartsBatch = {
    kind: 'lineString',
    positions: Float64Array.of(14, 50, 15, 51),
    altitudes: Float64Array.of(5, NaN),
    partOffsets: Uint32Array.of(0, 2),
  };
  const legacy = columnarToFeatures(batch, { positionKind: 'geographic' }).map((input) =>
    prepareGeometry(projection, input.geometry),
  );
  const binary = prepareParts(batch, projection);
  assert.deepEqual(
    binary.geometries,
    legacy,
    'both paths keep identical canonical payloads and altitudes',
  );
  const payload = binary.geometries[0]!.payload as {
    vertices: Float64Array;
    altitudes: Float64Array;
  };
  assert.deepEqual(payload.vertices, Float64Array.of(19, 50, 15, 51));
  assert.deepEqual(payload.altitudes, Float64Array.of(5, Number.NaN));
});

test('binary initial publication and subsequent replace preserve refs, properties and rollback', async () => {
  const scene = new Scene(crs.simple(), manualClock()),
    source = scene.createVectorSource('s');
  const batch: ColumnarPartsBatch = {
    kind: 'lineString',
    positions: Float64Array.of(0, 0, 1, 1, 2, 2, 3, 3),
    partOffsets: Uint32Array.of(0, 2, 4),
    ids: ['a', 'b'],
    properties: [{ value: 1 }, { value: 2 }],
  };
  await source.importColumnar(batch);
  assert.deepEqual(source.features.ids(), ['a', 'b']);
  const a = source.features.ref('a'),
    b = source.features.ref('b');
  await source.importColumnar({ ...batch, properties: [{ value: 3 }, undefined] });
  assert.deepEqual(source.features.ref('a'), a);
  assert.deepEqual(source.features.get('a')!.properties, { value: 3 });
  assert.deepEqual(source.features.get('b')!.properties, {});
  const before = source.exportGeoJson();
  await assert.rejects(source.importColumnar({ ...batch, ids: ['a', 'a'] }));
  assert.deepEqual(source.exportGeoJson(), before);
  await assert.rejects(source.importColumnar(batch, { mode: 'append' }));
  assert.deepEqual(source.features.ref('b'), b);
  assert.deepEqual(source.exportGeoJson(), before);
  scene.destroy();
});
