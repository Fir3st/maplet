import test from 'node:test';
import assert from 'node:assert/strict';

import { crs, isMapletError, type Position } from '../../src/index.ts';
import { GEOMETRY_KIND, prepareGeometry } from '../../src/geometry/geometry.ts';
import { FeatureStore, SpatialIndex } from '../../src/scene/store.ts';

test('inline point ingest matches prepared geometry across CRS, wrapping and altitude', () => {
  for (const projection of [crs.webMercator(), crs.epsg4326(), crs.epsg3395(), crs.simple()]) {
    const store = new FeatureStore(projection);
    const positions: Position[] = projection.positionKind === 'geographic' ? [
      { lng: 14, lat: 50 }, { lng: 540, lat: 90, altitude: 0 },
      { lng: -721, lat: -90, altitude: Infinity }, { lng: 0, lat: 0, altitude: NaN },
    ] : [{ x: -500, y: 20 }, { x: 0, y: 0 }, { x: 256, y: -256 }, { x: 800, y: 800 }];
    store.prepareGeometry = () => { throw new Error('point ingest must not allocate prepared geometry'); };
    for (const [id, position] of positions.entries()) {
      const expected = prepareGeometry(projection, { type: 'point', position });
      assert.equal(expected.payload.kind, expected.kind);
      const properties = { id };
      const result = store.add({ id, namespace: 'points', geometry: { type: 'point', position }, properties });
      const record = store.getBySlot(result.slot)!;
      assert.equal(record.wx, expected.anchorX);
      assert.equal(record.wy, expected.anchorY);
      assert.equal(record.alt, expected.payload.kind === GEOMETRY_KIND.point ? expected.payload.alt : undefined);
      assert.equal(record.geometry, null);
      assert.equal(record.namespace, 'points');
      assert.equal(record.generation, 1);
      assert.equal(record.properties, properties);
    }
    assert.equal(store.pointOnly, true);
    assert.equal(store.count, positions.length);
    assert.equal(store.indexStatistics().entries, positions.length);
  }
});

test('inline point ingest preserves validation errors and publishes no invalid record', () => {
  for (const projection of [crs.webMercator(), crs.simple(), {
    ...crs.simple(), code: 'invalid-domain', toWorld: () => ({ x: Infinity, y: 0 }),
  }]) {
    const store = new FeatureStore(projection);
    for (const position of [null, {}, { lng: NaN, lat: 0 }, { x: 1, y: Infinity }, { x: 1, y: 2 }]) {
      const geometry = { type: 'point', position };
      let expected: unknown;
      try { prepareGeometry(projection, geometry); } catch (error) { expected = error; }
      if (!expected) continue;
      const failure = expected;
      assert.ok(isMapletError(failure));
      assert.throws(() => store.add({ id: 'invalid', namespace: undefined, geometry, properties: undefined }),
        (error: unknown) => isMapletError(error) && error.code === failure.code && error.message === failure.message);
      assert.equal(store.count, 0);
      assert.equal(store.changes.epoch, 0);
      assert.deepEqual(store.indexStatistics(), { buckets: 0, entries: 0, oversized: 0 });
    }
  }
});

test('native point indexing matches degenerate rectangles at cell and world boundaries', () => {
  const points = new SpatialIndex();
  const rectangles = new SpatialIndex();
  const coordinates = [-500, -0.001, 0, 0.062499, 0.0625, 127.999, 128, 255.999, 256, 800];
  let slot = 0;
  for (const x of coordinates) for (const y of coordinates) {
    points.addPoint(slot, x, y);
    rectangles.add(slot, Float64Array.of(x, y, x, y));
    slot++;
  }
  assert.deepEqual(points.statistics(), rectangles.statistics());
  for (const x of coordinates) for (const y of coordinates) {
    const actual: number[] = [];
    const expected: number[] = [];
    points.queryRect(x, y, x + 0.0625, y + 0.0625, value => actual.push(value));
    rectangles.queryRect(x, y, x + 0.0625, y + 0.0625, value => expected.push(value));
    assert.deepEqual(actual, expected);
  }
});
