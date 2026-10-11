import test from 'node:test';
import assert from 'node:assert/strict';

import { isMapletError, parseGeoJson } from '../../src/index.ts';
import { makeMap } from '../helpers/fixture.ts';

test('DATA-01: sources are unique, typed and listed', async () => {
  const { map } = await makeMap();
  map.sources.vector({ id: 'a' });
  map.sources.vector({ id: 'b' });
  assert.deepEqual([...map.sources.list()].sort(), ['a', 'b']);
  assert.equal(map.sources.get('a')?.type, 'vector');
  assert.equal(map.sources.get('missing'), undefined);
  assert.throws(() => map.sources.vector({ id: 'a' }), /already exists/);
  map.destroy();
});

test('DATA-02: get of unknown ids returns undefined; ref throws a defined error', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  const snapshot = source.features.get('a');
  assert.ok(snapshot);
  assert.equal(snapshot.ref.id, 'a');
  assert.equal(snapshot.ref.generation, 1);
  assert.equal(source.features.get('missing'), undefined);
  try {
    source.features.ref('missing');
    assert.fail('expected not-found');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'not-found');
  }
  map.destroy();
});

test('DATA-03: number 42 and string "42" are independent features', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add([
    { id: 42, geometry: { type: 'point', position: { lat: 1, lng: 1 } } },
    { id: '42', geometry: { type: 'point', position: { lat: 2, lng: 2 } } },
  ]);
  assert.equal(source.features.count(), 2);
  assert.equal(source.features.get(42)?.ref.id, 42);
  assert.equal(source.features.get('42')?.ref.id, '42');
  source.features.remove(42);
  assert.equal(source.features.has(42), false);
  assert.equal(source.features.has('42'), true);
  map.destroy();
});

test('DATA-04: duplicate ids reject the ordinary write; upsert replaces atomically', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } }, properties: { v: 1 } });
  try {
    source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 51, lng: 15 } } });
    assert.fail('expected duplicate-id');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'duplicate-id');
  }
  assert.equal(source.features.get('a')?.properties.v, 1);
  const kept = source.features.get('a')?.geometry;
  assert.ok(kept && kept.type === 'point');
  assert.ok(Math.abs(kept.position.lat - 50) < 1e-9);
  source.features.add(
    { id: 'a', geometry: { type: 'point', position: { lat: 51, lng: 15 } }, properties: { v: 2 } },
    { upsert: true },
  );
  const replaced = source.features.get('a');
  assert.equal(replaced?.properties.v, 2);
  assert.equal(replaced?.ref.generation, 2);
  map.destroy();
});

test('DATA-05/06: update replaces geometry wholesale and patches properties per key', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({
    id: 'a',
    geometry: { type: 'point', position: { lat: 50, lng: 14 } },
    properties: { name: 'A', status: 'online', address: { city: 'Praha', zip: '11000' } },
  });
  source.features.update('a', {
    geometry: { type: 'point', position: { lat: 50.1, lng: 14.1 } },
    properties: { status: 'offline' },
  });
  const snapshot = source.features.get('a');
  assert.ok(snapshot);
  assert.equal(snapshot.properties.name, 'A');
  assert.equal(snapshot.properties.status, 'offline');
  const position = (snapshot.geometry as { position: { lat: number } }).position;
  assert.ok(Math.abs(position.lat - 50.1) < 1e-9, 'geometry was replaced, not merged');
  // Nested value replacement: the whole `address` value is replaced as given.
  source.features.update('a', { properties: { address: { city: 'Brno' } } });
  assert.deepEqual(source.features.get('a')?.properties.address, { city: 'Brno' });
  // Setting a key to undefined removes it; other keys stay.
  source.features.update('a', { properties: { name: undefined } });
  assert.equal('name' in (source.features.get('a')?.properties ?? {}), false);
  assert.equal(source.features.get('a')?.properties.status, 'offline');
  map.destroy();
});

test('DATA-07: replace keeps retained identities, drops the rest, adds new ones', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add([
    { id: 'a', geometry: { type: 'point', position: { lat: 1, lng: 1 } }, properties: { tag: 'old' } },
    { id: 'b', geometry: { type: 'point', position: { lat: 2, lng: 2 } } },
  ]);
  const generationA = source.features.ref('a').generation;
  await source.features.replace([
    { id: 'a', geometry: { type: 'point', position: { lat: 3, lng: 3 } }, properties: { tag: 'new' } },
    { id: 'c', geometry: { type: 'point', position: { lat: 4, lng: 4 } } },
  ]);
  assert.equal(source.features.count(), 2);
  assert.equal(source.features.ref('a').generation, generationA, 'retained identity keeps its generation');
  assert.equal(source.features.get('a')?.properties.tag, 'new');
  assert.equal(source.features.has('b'), false);
  assert.equal(source.features.has('c'), true);
  map.destroy();
});

test('DATA-08: remove + re-add + slot reuse never restores an old reference', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'keep', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  source.features.add({ id: 'gone', geometry: { type: 'point', position: { lat: 2, lng: 2 } } });
  const old = source.features.ref('gone');
  source.features.remove('gone');
  source.features.add({ id: 'gone', geometry: { type: 'point', position: { lat: 3, lng: 3 } } });
  const fresh = source.features.ref('gone');
  assert.ok(fresh.generation > old.generation);
  // The untouched feature keeps its identity.
  assert.equal(source.features.ref('keep').generation, 1);
  try {
    source.features.update(old, { properties: { x: 1 } });
    assert.fail('expected stale-reference');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'stale-reference');
  }
  assert.equal(source.features.get('gone')?.properties.x, undefined);
  map.destroy();
});

test('DATA-09: a bulk add with one invalid record changes nothing', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'base', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  try {
    source.features.add([
      { id: 'ok', geometry: { type: 'point', position: { lat: 2, lng: 2 } } },
      { id: 'bad', geometry: { type: 'point', position: { lat: Number.NaN, lng: 2 } } },
    ]);
    assert.fail('expected invalid-argument');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-argument');
  }
  assert.equal(source.features.count(), 1);
  assert.equal(source.features.has('ok'), false);
  map.destroy();
});

test('DATA-10/11: source removal requires cascade when used; cascade cleans dependents', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add([
    { id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } } },
    { id: 'b', geometry: { type: 'point', position: { lat: 51, lng: 15 } } },
  ]);
  map.layers.add({ id: 'points', type: 'points', source });
  map.layers.add({ id: 'fills', type: 'fills', source });
  map.relations.add({
    id: 'r',
    type: 'connects',
    from: source.features.ref('a'),
    to: source.features.ref('b'),
  });
  try {
    map.sources.remove('s');
    assert.fail('expected dependency-conflict');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'dependency-conflict');
  }
  assert.equal(map.sources.get('s') !== undefined, true);
  assert.equal(map.layers.list().length, 2);
  map.sources.remove('s', { cascade: true });
  assert.equal(map.sources.get('s'), undefined);
  assert.equal(map.layers.list().length, 0);
  assert.equal(map.relations.list().length, 0);
  map.destroy();
});

test('DATA-12: references from another scene, namespace or generation are rejected', async () => {
  const { map } = await makeMap();
  const other = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const otherSource = other.map.sources.vector({ id: 's' });
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  otherSource.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 2, lng: 2 } } });
  const foreign = otherSource.features.ref('a');
  try {
    source.features.update(foreign, { properties: { touched: true } });
    assert.fail('expected stale-reference');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'stale-reference');
  }
  assert.equal(source.features.get('a')?.properties.touched, undefined);
  // Namespaced features are separate identities in the same source.
  source.features.add({ id: 'a', namespace: 'layer-2', geometry: { type: 'point', position: { lat: 3, lng: 3 } } });
  assert.equal(source.features.count(), 2);
  assert.equal(source.features.get('a')?.ref.namespace, undefined);
  assert.equal(source.features.get('a', { namespace: 'layer-2' })?.ref.namespace, 'layer-2');
  map.destroy();
  other.map.destroy();
});

test('DATA-13: unknown JSON property fields survive get and export unchanged', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const properties = {
    unknown: { nested: [1, 'two', { three: true }] },
    nul: null,
    empty: {},
    repeated: 'same-string-value',
    tags: ['same-string-value', 'same-string-value'],
  };
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 1, lng: 1 } }, properties });
  assert.deepEqual(source.features.get('a')?.properties, properties);
  const exported = source.exportGeoJson();
  assert.deepEqual(exported.features[0]?.properties, properties);
  map.destroy();
});

test('DATA-14: one point changed in 500k stays a local, O(1) operation', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 'big' });
  const items = new Array(500_000);
  for (let i = 0; i < items.length; i++) {
    items[i] = { id: i, geometry: { type: 'point', position: { lat: 50 + (i % 100) / 1000, lng: 14 + (i % 1000) / 10000 } } };
  }
  await source.features.replace(items);
  const start = performance.now();
  source.features.update(250_000, { geometry: { type: 'point', position: { lat: -33.86, lng: 151.2 } } });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 50, `update took ${elapsed}ms`);
  const moved = source.features.get(250_000);
  assert.ok(moved && moved.geometry.type === 'point');
  assert.ok(Math.abs(moved.geometry.position.lat - -33.86) < 1e-9);
  // The move is visible through a spatial query at the new place only.
  const hitNow = map.query.at({ lat: -33.86, lng: 151.2 }, { tolerancePx: 1 });
  const hitBefore = map.query.at({ lat: 50.25, lng: 14.025 }, { tolerancePx: 0.01 });
  assert.equal(hitNow.length, 1);
  assert.equal(hitNow[0]?.ref.id, 250_000);
  assert.ok(!hitBefore.some((item) => item.ref.id === 250_000));
  map.destroy();
});

test('IO-01: GeoJSON point import/export keeps [lng, lat, alt] and metadata', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  await source.importGeoJson({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'station',
        geometry: { type: 'Point', coordinates: [14, 50, 100] },
        properties: { name: 'Stanice', rank: 3 },
      },
    ],
  });
  const snapshot = source.features.get('station');
  assert.ok(snapshot && snapshot.geometry.type === 'point');
  const position = snapshot.geometry.position;
  // Canonical world storage round-trips through double precision, not bit-exactly.
  assert.ok(Math.abs(position.lng - 14) < 1e-9);
  assert.ok(Math.abs(position.lat - 50) < 1e-9);
  assert.equal(position.altitude, 100);
  const exported = source.exportGeoJson();
  assert.equal(exported.features[0]?.id, 'station');
  const coordinates = (exported.features[0]?.geometry as { coordinates: number[] }).coordinates;
  assert.ok(Math.abs(coordinates[0]! - 14) < 1e-9);
  assert.ok(Math.abs(coordinates[1]! - 50) < 1e-9);
  assert.equal(coordinates[2], 100);
  assert.deepEqual(exported.features[0]?.properties, { name: 'Stanice', rank: 3 });
  map.destroy();
});

test('IO-02: multi geometries keep their parts and rings under one identity', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const features = parseGeoJson({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'mp', geometry: { type: 'MultiPoint', coordinates: [[1, 1], [2, 2], [3, 3]] }, properties: {} },
      { type: 'Feature', id: 'ml', geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, properties: {} },
      {
        type: 'Feature',
        id: 'poly',
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] },
        properties: {},
      },
      {
        type: 'Feature',
        id: 'multi',
        geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]]] },
        properties: {},
      },
    ],
  });
  await source.features.replace(features as never[]);
  assert.equal(source.features.count(), 4);
  const exported = source.exportGeoJson();
  const byId = new Map(exported.features.map((feature) => [feature.id, feature]));
  assert.equal((byId.get('mp')?.geometry as { coordinates: unknown[] }).coordinates.length, 3);
  assert.equal((byId.get('ml')?.geometry as { coordinates: unknown[] }).coordinates.length, 2);
  assert.equal((byId.get('poly')?.geometry as { coordinates: unknown[][] }).coordinates.length, 2, 'polygon keeps its hole ring');
  assert.equal((byId.get('multi')?.geometry as { coordinates: unknown[] }).coordinates.length, 2);
  map.destroy();
});

test('IO-03: a failed import leaves the previous source content complete', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  await source.importGeoJson({
    type: 'Feature', id: 'old', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { keep: true },
  });
  await assert.rejects(
    source.importGeoJson('{ not json'),
    (error: unknown) => isMapletError(error) && error.code === 'import-invalid',
  );
  await assert.rejects(
    source.importGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'new', geometry: { type: 'Point', coordinates: [2, 2] }, properties: {} },
        { type: 'Feature', id: 'new', geometry: { type: 'Point', coordinates: [3, 3] }, properties: {} },
      ],
    }),
    (error: unknown) => isMapletError(error) && error.code === 'duplicate-id',
  );
  assert.equal(source.features.count(), 1);
  assert.equal(source.features.get('old')?.properties.keep, true);
  assert.equal(source.features.has('new'), false);
  map.destroy();
});

test('IO-04: features without ids receive deterministic unique generated ids', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  await source.importGeoJson({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: {} },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 2] }, properties: {} },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as never);
  const ids = source.features.ids();
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => typeof id === 'string' && id.startsWith('auto:')));
  assert.notEqual(ids[0], ids[1]);
  await source.importGeoJson({
    type: 'Feature', geometry: { type: 'Point', coordinates: [3, 3] }, properties: {},
  }, { mode: 'append' });
  assert.equal(new Set(source.features.ids()).size, 3, 'generated ids stay unique across imports');
  map.destroy();
});

test('IO-06/12: imports copy their input and export returns canonical coordinates', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const coordinates: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const geojson = {
    type: 'Feature' as const,
    id: 'area',
    geometry: { type: 'Polygon' as const, coordinates: [coordinates] },
    properties: {},
  };
  await source.importGeoJson(geojson);
  // Mutating the caller's array must not change the map (copy semantics).
  coordinates[0]![0] = 99;
  const exported = source.exportGeoJson();
  const exportedCoordinates = (exported.features[0]?.geometry as { coordinates: number[][][] }).coordinates[0]!;
  assert.equal(exportedCoordinates[0]![0], 0, 'export contains original coordinates, not the mutated input');
  // Canonical data is not clipped by the viewport or by render fragments.
  const polygon = source.features.get('area')?.geometry;
  assert.ok(polygon && polygon.type === 'polygon');
  assert.equal(polygon.rings[0]?.length, 5);
  map.destroy();
});

test('IO-09: an aborted import rejects and publishes nothing', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'base', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.features.replace(
      [{ id: 'late', geometry: { type: 'point', position: { lat: 2, lng: 2 } } }],
      { signal: controller.signal },
    ),
    (error: unknown) => isMapletError(error) && error.code === 'aborted',
  );
  assert.equal(source.features.count(), 1);
  assert.equal(source.features.has('late'), false);
  map.destroy();
});

test('TX-01/02/03: batches publish once, read staged state and roll back atomically', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } }, properties: { name: 'A' } });
  source.features.add({ id: 'b', geometry: { type: 'point', position: { lat: 51, lng: 15 } }, properties: { name: 'B' } });
  const events: number[] = [];
  const off = source.subscribe((snapshot) => {
    if (!snapshot.initial) events.push(snapshot.revision);
  });
  events.length = 0;
  map.batch(() => {
    source.features.update('a', { properties: { name: 'A2' } });
    map.state.set(source.features.ref('a'), { selected: true });
    source.features.update('b', { properties: { name: 'B2' } });
    // Reads inside the batch see the staged change.
    assert.equal(source.features.get('a')?.properties.name, 'A2');
  });
  assert.equal(events.length, 1, 'exactly one event for the one touched source, after commit');
  assert.equal(source.features.get('a')?.properties.name, 'A2');
  assert.equal(map.selection.get().length, 1);

  const before = source.features.get('a');
  events.length = 0;
  assert.throws(() =>
    map.batch(() => {
      source.features.update('a', { properties: { name: 'rolled-back' } });
      source.features.update('missing', { properties: { name: 'x' } });
    }),
  );
  assert.deepEqual(source.features.get('a'), before);
  assert.equal(events.length, 0);
  off();
  map.destroy();
});

test('TX-04: async callbacks are rejected; later writes commit separately', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  let leaked: Promise<unknown> | null = null;
  assert.throws(() => {
    map.batch(() => {
      source.features.add({ id: 'async', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
      leaked = Promise.resolve();
      return leaked;
    });
  }, /async/);
  // The async write never belongs to the failed transaction.
  assert.equal(source.features.has('async'), false);
  source.features.add({ id: 'after', geometry: { type: 'point', position: { lat: 2, lng: 2 } } });
  assert.equal(source.features.has('after'), true);
  map.destroy();
});

test('TX-05/07: logical and rendered revisions stay distinct and waiters resolve by threshold', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const first = source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  const second = source.features.add({ id: 'b', geometry: { type: 'point', position: { lat: 2, lng: 2 } } });
  const stats = map.stats();
  assert.ok(stats.revision >= second.revision);
  assert.ok(stats.renderedRevision <= stats.revision);
  await map.whenRendered(first.revision);
  assert.ok(map.stats().renderedRevision >= first.revision);
  map.destroy();
});

test('EVENT-04/05: unsubscribe is idempotent, AbortSignal works, emission is snapshot-based', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const seen: string[] = [];
  const off = source.on('change', (event) => seen.push(`first:${event.revision}`));
  off();
  off();
  const controller = new AbortController();
  let aborted = 0;
  source.on('change', () => aborted++, { signal: controller.signal });
  controller.abort();
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  assert.equal(seen.length, 0);
  assert.equal(aborted, 0);
  map.destroy();
});
