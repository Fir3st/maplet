import test from 'node:test';
import assert from 'node:assert/strict';
import { crs, isMapletError } from '../../src/index.ts';
import { Scene } from '../../src/scene/scene.ts';
import { manualClock } from '../helpers/fixture.ts';
import { FeatureStore } from '../../src/scene/store.ts';
import { columnarToFeatures, type ColumnarPointBatch } from '../../src/io/columnar.ts';
import type { Crs } from '../../src/math/crs.ts';
import type { GeoPosition, Position } from '../../src/api/types.ts';

test('queued abort tasks can cancel prepared columns before atomic publication', async () => {
  for (const kind of ['point', 'lineString'] as const) {
    const scene = new Scene(crs.simple(), manualClock()), source = scene.createVectorSource('s');
    const controller = new AbortController();
    const positions = Float64Array.of(0, 0, 1, 1);
    const batch = kind === 'point' ? { kind, positions } : { kind, positions, partOffsets: Uint32Array.of(0, 2) };
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(source.importColumnar(batch, { signal: controller.signal }), (error: unknown) => isMapletError(error) && error.code === 'aborted');
    assert.equal(source.features.count(), 0);
    scene.destroy();
  }
});

test('destroy releases canonical pages and identity history with a retained source handle', async () => {
  const scene = new Scene(crs.simple(), manualClock()), source = scene.createVectorSource('s');
  await source.importColumnar({ kind: 'point', positions: new Float64Array(2048) });
  const store = scene.getSourceImpl('s')!.store;
  assert.equal(store.slotCapacity, 1024);
  scene.destroy();
  assert.equal(store.slotCapacity, 0);
  assert.equal(store.count, 0);
  assert.equal(store.pristine, true);
  assert.equal(source.features.count(), 0);
  assert.throws(() => source.features.add({ geometry: { type: 'point', position: { lat: 0, lng: 0 } } }), (error: unknown) => isMapletError(error) && error.code === 'destroyed');
});

test('initial point publication matches object ingest across native and custom CRS', () => {
  const custom: Crs = { ...crs.webMercator(), normalize(position: Position) {
    const geo = position as GeoPosition;
    return { lng: geo.lng / 2, lat: geo.lat / 2, altitude: (geo.altitude ?? 0) + 10 };
  }, toWorld(position: Position) {
    const geo = position as GeoPosition;
    return { x: geo.lng + (Number.isFinite(geo.altitude) ? geo.altitude! : 0), y: geo.lat };
  } };
  for (const projection of [crs.webMercator(), crs.epsg4326(), crs.epsg3395(), crs.simple(), custom]) {
    const batch: ColumnarPointBatch = { kind: 'point', positions: Float64Array.of(540, 90, -540, -90, 14, 50, -1e12, -1e12),
      ids: [42, '42', 'a', 'b'], properties: [{ value: 1 }, undefined, { value: 3 }, undefined],
      ...(projection.positionKind === 'geographic' ? { altitudes: Float64Array.of(100, NaN, Infinity, -Infinity) } : {}) };
    const actual = new FeatureStore(projection), expected = new FeatureStore(projection);
    actual.initializePoints(batch, () => { throw new Error('all IDs supplied'); });
    for (const input of columnarToFeatures(batch, { positionKind: projection.positionKind })) {
      expected.add({ id: input.id!, namespace: undefined, geometry: input.geometry, properties: input.properties });
    }
    for (let slot = 0; slot < 4; slot++) {
      const a = actual.getBySlot(slot)!, b = expected.getBySlot(slot)!;
      assert.deepEqual({ id: a.id, wx: a.wx, wy: a.wy, alt: a.alt, properties: a.properties },
        { id: b.id, wx: b.wx, wy: b.wy, alt: b.alt, properties: b.properties });
    }
    assert.deepEqual(actual.boundsNow(), expected.boundsNow());
    assert.deepEqual(actual.indexStatistics(), expected.indexStatistics());
  }
});

test('point initialization rejects duplicate IDs atomically and consumes adopted generations on undo', () => {
  const store = new FeatureStore(crs.simple());
  assert.throws(() => store.initializePoints({ kind: 'point', positions: new Float64Array(4), ids: ['a', 'a'] }, () => 'unused'),
    (error: unknown) => isMapletError(error) && error.code === 'duplicate-id');
  assert.equal(store.pristine, true);
  const initialized = store.initializePoints({ kind: 'point', positions: Float64Array.of(1, 2), ids: ['a'] }, () => 'unused');
  const generation = store.get('a')!.generation;
  initialized.undo();
  assert.equal(store.count, 0);
  assert.equal(store.pristine, false);
  store.add({ id: 'a', namespace: undefined, geometry: { type: 'point', position: { x: 3, y: 4 } }, properties: undefined });
  assert.equal(store.get('a')!.generation, generation + 1);
});
