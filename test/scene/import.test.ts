import test from 'node:test';
import assert from 'node:assert/strict';

import { crs, isMapletError, type Position } from '../../src/index.ts';
import { Scene } from '../../src/scene/scene.ts';
import { ChangeJournal } from '../../src/scene/change-journal.ts';
import { makeMap, manualClock } from '../helpers/fixture.ts';

function pointBatch(count: number, startLng = 14): {
  kind: 'point';
  positions: Float64Array;
  ids: string[];
  properties: { index: number }[];
} {
  const positions = new Float64Array(count * 2);
  const ids: string[] = [];
  const properties: { index: number }[] = [];
  for (let i = 0; i < count; i++) {
    positions[i * 2] = startLng + (i % 100) * 0.001;
    positions[i * 2 + 1] = 50 + Math.floor(i / 100) * 0.001;
    ids.push(`p${i}`);
    properties.push({ index: i });
  }
  return { kind: 'point', positions, ids, properties };
}

test('IO-05/IO-06: a columnar import replaces the source and exports canonical data', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'old', geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  const commit = await source.importColumnar(pointBatch(2000));
  assert.equal(source.features.count(), 2000);
  assert.equal(source.features.has('old'), false, 'replace removes previous content');
  assert.ok(commit.revision > 0);

  const first = source.features.get('p0');
  assert.ok(first && first.geometry.type === 'point');
  assert.ok(
    Math.abs((first.geometry as { position: { lng: number } }).position.lng - 14) < 1e-9,
    'canonical world storage round-trips through double precision',
  );
  assert.deepEqual(first.properties, { index: 0 });
  const last = source.features.get('p1999');
  assert.ok(last && last.geometry.type === 'point');
  assert.deepEqual(last.properties, { index: 1999 });

  const exported = source.exportGeoJson();
  assert.equal(exported.features.length, 2000);
  const sample = exported.features.find((feature) => feature.id === 'p7');
  assert.ok(sample && sample.geometry);
  const coordinates = (sample.geometry as unknown as { coordinates: number[] }).coordinates;
  assert.ok(Math.abs(coordinates[0]! - 14.007) < 1e-9);
  assert.ok(Math.abs(coordinates[1]! - 50) < 1e-9);

  const bounds = source.getBounds() as unknown as {
    southwest: { lng: number; lat: number };
    northeast: { lng: number; lat: number };
  } | null;
  assert.ok(bounds, 'bounds follow the imported content');
  assert.ok(bounds.southwest.lng <= 14 + 1e-9 && bounds.northeast.lng >= 14.099 - 1e-9);
  assert.ok(bounds.southwest.lat <= 50 + 1e-9 && bounds.northeast.lat >= 50.019 - 1e-9);

  const imports = map.debug.imports();
  assert.equal(imports.backend, 'inline', 'Node has no Worker, the documented fallback runs');
  assert.equal(imports.pending, 0);
  assert.equal(imports.used.inline, 1);
  assert.equal(imports.used.worker, 0);
  map.destroy();
});

test('IO-05: append mode adds to the source and the input buffer stays usable', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'base', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  const batch = pointBatch(10, 15);
  await source.importColumnar(batch, { mode: 'append' });
  assert.equal(source.features.count(), 11);
  assert.equal(source.features.has('base'), true);
  // Copy semantics: mutating the caller's buffer after the import changes nothing (IO-06).
  batch.positions[0] = 99;
  const geometry = source.features.get('p0')?.geometry as { position: { lng: number } } | undefined;
  assert.ok(Math.abs((geometry?.position.lng ?? 0) - 15) < 1e-9);
  assert.equal(batch.positions.byteLength, 160, 'the caller still owns a usable buffer');
  map.destroy();
});

test('TX-09: a failed import keeps the previous content and revision intact', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'keep', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  const revisionBefore = map.stats().revision;
  await assert.rejects(
    source.importColumnar({
      kind: 'point',
      positions: Float64Array.of(14, 50, 14.1, 50.1),
      ids: ['dup', 'dup'],
    }),
    (error: unknown) => isMapletError(error) && error.code === 'duplicate-id',
  );
  assert.equal(source.features.count(), 1);
  assert.equal(source.features.has('keep'), true);
  assert.equal(source.features.has('dup'), false, 'nothing from the failed import was published');
  assert.equal(map.stats().revision, revisionBefore, 'the logical revision did not move');
  map.destroy();
});

test('IO-05: a malformed batch rejects before the source is touched', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'keep', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  await assert.rejects(
    source.importColumnar({ kind: 'point', positions: Float64Array.of(1, 2, 3) }),
    (error: unknown) =>
      isMapletError(error) &&
      error.code === 'import-invalid' &&
      typeof error.detail.revision === 'number',
  );
  assert.equal(source.features.count(), 1);
  map.destroy();
});

test('IO-09: an abort before the import starts rejects and publishes nothing', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'keep', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.importColumnar(pointBatch(10), { signal: controller.signal }),
    (error: unknown) => isMapletError(error) && error.code === 'aborted',
  );
  assert.equal(source.features.count(), 1);
  map.destroy();
});

test('IO-05: columnar lines and polygons import through the same store validation', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  await source.importColumnar({
    kind: 'polygon',
    positions: Float64Array.of(0, 0, 4, 0, 4, 4, 0, 4, 1, 1, 1, 2, 2, 2, 2, 1),
    partOffsets: Int32Array.of(0, 4, 8),
    featurePartOffsets: Int32Array.of(0, 2),
    ids: ['donut'],
    properties: [{ name: 'ring' }],
  });
  assert.equal(source.features.count(), 1);
  const geometry = source.features.get('donut')?.geometry;
  assert.equal(geometry?.type, 'polygon');
  const rings = (geometry as unknown as { rings: unknown[][] }).rings;
  assert.equal(rings.length, 2);
  assert.equal(rings[0]?.length, 5, 'the exterior ring is auto-closed by the store');
  assert.equal(rings[1]?.length, 5, 'the hole ring is auto-closed too');
  assert.equal(source.features.get('donut')?.properties.name, 'ring');

  // A degenerate ring is rejected by the store and rolls the whole import back.
  source.features.add({ id: 'base', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  await assert.rejects(
    source.importColumnar({
      kind: 'polygon',
      positions: Float64Array.of(0, 0, 1, 1),
      partOffsets: Int32Array.of(0, 2),
    }),
    (error: unknown) => isMapletError(error) && error.code === 'invalid-argument',
  );
  assert.equal(source.features.count(), 2, 'the whole import rolled back, including the base feature removal');
  assert.equal(source.features.has('donut'), true);
  map.destroy();
});

test('IO-05: a planar CRS imports { x, y } columns without geographic assumptions', async () => {
  const { map } = await makeMap({
    projection: crs.simple(),
    view: { center: { x: 0, y: 0 }, zoom: 5 },
  });
  const source = map.sources.vector({ id: 's' });
  await source.importColumnar({
    kind: 'point',
    positions: Float32Array.of(-40, 90, 60, -20),
    ids: ['m1', 'm2'],
  });
  assert.equal(source.features.count(), 2);
  const geometry = source.features.get('m1')?.geometry as
    | { position: { x: number; y: number } }
    | undefined;
  assert.equal(geometry?.position.x, -40);
  assert.equal(geometry?.position.y, 90);
  // Altitudes are a geographic concept; a planar batch must not carry them.
  await assert.rejects(
    source.importColumnar({
      kind: 'point',
      positions: Float64Array.of(1, 2),
      altitudes: Float64Array.of(5),
    }),
    (error: unknown) => isMapletError(error) && error.code === 'import-invalid',
  );
  map.destroy();
});

test('GeoJSON imports share the pipeline and its diagnostics', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  await source.importGeoJson({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'a', geometry: { type: 'Point', coordinates: [14, 50] }, properties: {} },
      { type: 'Feature', id: 'b', geometry: { type: 'Point', coordinates: [15, 51] }, properties: {} },
    ],
  });
  assert.equal(source.features.count(), 2);
  await assert.rejects(
    source.importGeoJson('{ not json'),
    (error: unknown) => isMapletError(error) && error.code === 'import-invalid',
  );
  assert.equal(source.features.count(), 2, 'the failed import published nothing');
  assert.equal(map.debug.imports().used.inline, 1, 'geojson goes through the same preparation pipeline');
  map.destroy();
});

test('compact point import preserves generations, metadata ownership and empty replacement', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const batch = { kind: 'point' as const, positions: Float64Array.of(14, 50, 15, 51),
    altitudes: Float64Array.of(123, Number.NaN), ids: [42, '42'], properties: [{ value: 1 }, { value: 2 }] };
  await source.importColumnar(batch);
  const ref = source.features.ref(42);
  batch.properties[0]!.value = 99;
  batch.positions[0] = 17;
  assert.equal(source.features.get(42)!.properties.value, 1, 'the caller cannot mutate imported properties');
  assert.equal((source.features.get(42)!.geometry as { position: { altitude: number } }).position.altitude, 123);
  await source.importColumnar(batch);
  assert.deepEqual(source.features.ref(42), ref, 'retained IDs keep their generation');
  assert.equal(source.features.get('42')!.properties.value, 2, 'numeric and string IDs stay separate');
  await source.importColumnar({ kind: 'point', positions: new Float64Array() });
  assert.equal(source.features.count(), 0);
  map.destroy();
});

test('compact point import validates all columns and append duplicates before publication', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  await source.importColumnar({ kind: 'point', positions: Float64Array.of(14, 50), ids: ['keep'] });
  const before = source.features.get('keep');
  const revision = map.stats().revision;
  for (const batch of [
    { kind: 'point' as const, positions: Float64Array.of(14, 50, Number.NaN, 0) },
    { kind: 'point' as const, positions: Float64Array.of(14, 50), altitudes: Float64Array.of(1, 2) },
    { kind: 'point' as const, positions: Float64Array.of(14, 50), ids: [] },
    { kind: 'point' as const, positions: Float64Array.of(14, 50), properties: [] },
  ]) await assert.rejects(source.importColumnar(batch));
  await assert.rejects(source.importColumnar({ kind: 'point', positions: Float64Array.of(15, 51, 16, 52), ids: ['new', 'keep'] }, { mode: 'append' }));
  assert.equal(source.features.count(), 1);
  assert.deepEqual(source.features.get('keep'), before);
  assert.equal(map.stats().revision, revision);
  map.destroy();
});

test('compact point imports retain the existing altitude semantics', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 'compact' });
  const direct = map.sources.vector({ id: 'direct' });
  // Altitude is metadata, not a projected coordinate; the existing store accepts Infinity.
  direct.features.add({ id: 'p', geometry: { type: 'point', position: { lng: 14, lat: 50, altitude: Infinity } } });
  await source.importColumnar({ kind: 'point', positions: Float64Array.of(14, 50), altitudes: Float64Array.of(Infinity), ids: ['p'] });
  assert.deepEqual(source.features.get('p')!.geometry, direct.features.get('p')!.geometry);
  map.destroy();
});

test('insertion returns the stored slot identity without a second ID lookup', () => {
  const scene = new Scene(crs.webMercator(), manualClock());
  const source = scene.createVectorSource('s');
  const store = scene.getSourceImpl('s')!.store;
  const originalGet = store.get;
  let lookups = 0;
  store.get = function (...args) { lookups++; return originalGet.apply(this, args); };
  const input = { id: 42, namespace: 'points', geometry: { type: 'point' as const, position: { lng: 14, lat: 50 } } };
  try {
    const first = source.features.add([input, { ...input, id: '42' }]);
    assert.equal(lookups, 0, 'the insert result already supplies the live slot');
    assert.deepEqual(first.refs.map(ref => [ref.id, ref.namespace, ref.generation]), [[42, 'points', 1], ['42', 'points', 1]]);
    assert.equal(store.getBySlot(0)!.id, 42);
    assert.equal(store.getBySlot(1)!.id, '42');
    const replacement = source.features.add(input, { upsert: true });
    assert.equal(lookups, 0, 'upsert also returns its resolved slot');
    assert.equal(replacement.refs[0]!.generation, 2);
    assert.equal(store.getBySlot(0)!.generation, 2);
    assert.equal(source.features.count(), 2);
  } finally {
    store.get = originalGet;
    scene.destroy();
  }
});

test('fresh point imports build the store in one batch without per-feature CRUD or undo', async () => {
  const scene = new Scene(crs.webMercator(), manualClock());
  const source = scene.createVectorSource('s');
  const impl = scene.getSourceImpl('s')!;
  const store = impl.store;
  const originalAdd = impl.addOne;
  const originalUndo = scene.recordUndo;
  let undoEntries = 0;
  let event: ReturnType<typeof source.snapshot> & { change?: { addedCount: number; added: readonly unknown[] } | null };
  source.on('change', value => { event = value; });
  impl.addOne = () => { throw new Error('bulk initialization must not run per-feature CRUD'); };
  scene.recordUndo = function (undo) { undoEntries++; originalUndo.call(this, undo); };
  try {
    await source.importColumnar(pointBatch(5000));
    assert.equal(impl.store, store, 'the renderer/query store identity stays stable');
    assert.equal(undoEntries, 1, 'one atomic store adoption, not 5000 undo closures');
    assert.equal(source.features.count(), 5000);
    assert.equal(event!.change!.addedCount, 5000);
    assert.equal(event!.change!.added.length, 4096, 'event samples remain bounded');
    assert.equal(store.indexStatistics().entries, 5000);
    assert.equal(source.features.ref('p4999').generation, 1);
    const found: string[] = [];
    store.queryRect(0, 0, 256, 256, record => found.push(record.id as string));
    assert.equal(new Set(found).size, 5000);
    store.forEachLive(record => {
      const i = record.slot;
      const expected = crs.webMercator().toWorld({ lng: 14 + (i % 100) * 0.001, lat: 50 + Math.floor(i / 100) * 0.001 });
      assert.equal(record.id, `p${i}`);
      assert.deepEqual(record.properties, { index: i });
      assert.ok(Math.abs(record.wx - expected.x) < 1e-9 && Math.abs(record.wy - expected.y) < 1e-9);
    });
  } finally {
    impl.addOne = originalAdd;
    scene.recordUndo = originalUndo;
    scene.destroy();
  }
});

test('bulk initialization rolls back as a unit and cannot revive a captured generation', async () => {
  const scene = new Scene(crs.webMercator(), manualClock());
  const source = scene.createVectorSource('s');
  const store = scene.getSourceImpl('s')!.store;
  const originalCommit = scene.finishImplicitCommit;
  const beforeEpoch = store.changes.epoch;
  let captured: ReturnType<typeof source.features.ref> | undefined;
  let events = 0;
  source.on('change', () => { events++; });
  scene.finishImplicitCommit = () => {
    captured = source.features.ref('p0');
    assert.equal(source.features.count(), 12, 'the transaction can read staged records');
    throw new Error('commit failure');
  };
  try {
    await assert.rejects(source.importColumnar(pointBatch(12)), /commit failure/);
    assert.equal(source.features.count(), 0);
    assert.equal(scene.revision, 0);
    assert.equal(events, 0);
    assert.deepEqual(store.indexStatistics(), { buckets: 0, entries: 0, oversized: 0 });
    assert.equal(store.boundsNow(), null);
    assert.equal(store.changes.since(beforeEpoch), null, 'rollback invalidates any staged plan');
    scene.finishImplicitCommit = originalCommit;
    await source.importColumnar(pointBatch(1));
    assert.ok(source.features.ref('p0').generation > captured!.generation);
    assert.throws(() => source.features.update(captured!, { properties: { leaked: true } }),
      (error: unknown) => isMapletError(error) && error.code === 'stale-reference');
  } finally {
    scene.finishImplicitCommit = originalCommit;
    scene.destroy();
  }
});

test('bulk initialization validates the complete CRS domain before adopting data', async () => {
  const projection = { ...crs.simple(), code: 'bulk-domain', toWorld(position: Position) {
    const point = position as { x: number; y: number };
    return point.x === 9 ? { x: Infinity, y: 0 } : crs.simple().toWorld(position);
  } };
  const { map } = await makeMap({ projection, view: { center: { x: 0, y: 0 }, zoom: 1 } });
  const source = map.sources.vector({ id: 's' });
  const revision = map.stats().revision;
  await assert.rejects(source.importColumnar({ kind: 'point', positions: Float64Array.of(1, 2, 9, 4), ids: ['a', 'b'] }),
    (error: unknown) => isMapletError(error) && error.code === 'invalid-argument' && error.message.includes('CRS domain'));
  assert.equal(source.features.count(), 0);
  assert.equal(map.stats().revision, revision);
  assert.equal(source.getBounds(), null);
  await source.importColumnar({ kind: 'point', positions: Float64Array.of(5, 6), ids: ['c'] });
  assert.deepEqual(source.features.get('c')!.geometry, { type: 'point', position: { x: 5, y: 6 } });
  map.destroy();
});

test('bulk journal invalidation rejects older plans and retains subsequent local changes', () => {
  const journal = new ChangeJournal<number>();
  journal.note(7);
  const prior = journal.epoch;
  journal.invalidate();
  const current = journal.epoch;
  assert.ok(current > prior);
  assert.equal(journal.since(prior), null);
  assert.deepEqual(journal.since(current), []);
  journal.note(9);
  assert.equal(journal.since(prior), null);
  assert.deepEqual(journal.since(current), [9]);
});

test('bulk columns match ordinary CRUD across CRS, wrapping, generated IDs and altitude', async () => {
  for (const projection of [crs.webMercator(), crs.epsg4326(), crs.epsg3395(), crs.simple()]) {
    const { map } = await makeMap({ projection, view: {
      center: projection.positionKind === 'geographic' ? { lat: 0, lng: 0 } : { x: 0, y: 0 }, zoom: 1,
    } });
    const bulk = map.sources.vector({ id: 'bulk' });
    const direct = map.sources.vector({ id: 'direct' });
    const coordinates = projection.positionKind === 'geographic' ? [540, 90, -721, -90, 14, 50, 0, 0] : [-500, 20, 0, 0, 256, -256, 800, 800];
    const ids = [42, '42', 'auto:1', 'last'];
    const properties = [{ nested: { value: 1 } }, {}, { nested: { value: 3 } }, {}];
    const altitudes = [Infinity, 0, NaN, -20];
    await bulk.importColumnar({ kind: 'point', positions: Float64Array.from(coordinates), ids: [42, '42', undefined, 'last'], properties,
      ...(projection.positionKind === 'geographic' ? { altitudes: Float64Array.from(altitudes) } : {}) });
    direct.features.add(ids.map((id, i) => ({ id, properties: structuredClone(properties[i]!), geometry: { type: 'point', position:
      projection.positionKind === 'planar' ? { x: coordinates[i * 2]!, y: coordinates[i * 2 + 1]! } : {
        lng: coordinates[i * 2]!, lat: coordinates[i * 2 + 1]!,
        ...(Number.isNaN(altitudes[i]) ? {} : { altitude: altitudes[i]! }),
      } } })) as never[]);
    assert.deepEqual(bulk.features.ids(), ids);
    for (const id of ids) {
      assert.deepEqual(bulk.features.get(id)!.geometry, direct.features.get(id)!.geometry);
      assert.deepEqual(bulk.features.get(id)!.properties, direct.features.get(id)!.properties);
      assert.equal(bulk.features.ref(id).generation, 1);
    }
    assert.deepEqual(bulk.getBounds(), direct.getBounds());
    properties[0]!.nested!.value = 99;
    assert.equal((bulk.features.get(42)!.properties.nested as { value: number }).value, 1);
    map.destroy();
  }
});

test('an abort during bulk CRS conversion never publishes even the final row', async () => {
  const controller = new AbortController();
  let conversions = 0;
  let importing = false;
  const base = crs.webMercator();
  const projection = { ...base, toWorld(position: Position) {
    if (importing && ++conversions === 2) controller.abort();
    return base.toWorld(position);
  } };
  const { map } = await makeMap({ projection });
  const source = map.sources.vector({ id: 's' });
  conversions = 0;
  importing = true;
  const revision = map.stats().revision;
  await assert.rejects(source.importColumnar(pointBatch(2), { signal: controller.signal }),
    (error: unknown) => isMapletError(error) && error.code === 'aborted');
  assert.equal(conversions, 2, 'the abort happens during the final CRS conversion');
  assert.equal(source.features.count(), 0);
  assert.equal(source.getBounds(), null);
  assert.equal(map.stats().revision, revision);
  map.destroy();
});

test('recycled stores keep generations and existing imports enforce binding ownership', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const target = map.sources.vector({ id: 'target' });
  source.features.add({ id: 42, geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  const stale = source.features.ref(42);
  source.features.remove(42);
  await source.importColumnar({ kind: 'point', positions: Float64Array.of(15, 51), ids: [42], properties: [{ value: 1 }] });
  const current = source.features.ref(42);
  assert.equal(current.generation, stale.generation + 1);
  target.features.add({ id: 't', geometry: { type: 'point', position: { lat: 0, lng: 0 } }, properties: { value: 2 } });
  map.bindings.add({ id: 'owner', target: current, properties: { kind: 'copyProperty', from: target.features.ref('t'), field: 'value' } });
  const before = source.features.get(42);
  const revision = map.stats().revision;
  await assert.rejects(source.importColumnar({ kind: 'point', positions: Float64Array.of(16, 52), ids: [42], properties: [{ value: 3 }] }),
    (error: unknown) => isMapletError(error) && error.code === 'ownership-conflict');
  assert.deepEqual(source.features.get(42), before);
  assert.equal(map.stats().revision, revision);
  assert.deepEqual(source.features.ref(42), current);
  map.destroy();
});

test('bulk adoption and subsequent staged edits roll back in reverse order', () => {
  const scene = new Scene(crs.webMercator(), manualClock());
  const source = scene.createVectorSource('s');
  const impl = scene.getSourceImpl('s')!;
  let captured: ReturnType<typeof source.features.ref> | undefined;
  try {
    assert.throws(() => scene.batch(() => {
      impl.mutate(change => { assert.equal(impl.initializePointImport(change, pointBatch(4)), true); });
      captured = source.features.ref('p0');
      source.features.update('p0', { geometry: { type: 'lineString', positions: [{ lng: 0, lat: 0 }, { lng: 1, lat: 1 }] } });
      source.features.remove('p1');
      source.features.add({ id: 'extra', geometry: { type: 'point', position: { lng: 14, lat: 50 } } });
      source.features.add({ id: 'overflow', geometry: { type: 'point', position: { lng: 15, lat: 51 } } });
      throw new Error('cancel staged batch');
    }), /cancel staged batch/);
    assert.equal(source.features.count(), 0);
    assert.equal(impl.store.slotCapacity, 0);
    assert.equal(impl.store.pointOnly, true);
    assert.deepEqual(impl.store.indexStatistics(), { buckets: 0, entries: 0, oversized: 0 });
    const added = source.features.add({ id: 'p0', geometry: { type: 'point', position: { lng: 14, lat: 50 } } });
    assert.ok(added.refs[0]!.generation > captured!.generation);
    assert.equal(impl.store.slotCapacity, 1, 'a stale free slot cannot leak from the discarded store');
    assert.equal(impl.store.getBySlot(0)!.id, 'p0');
  } finally {
    scene.destroy();
  }
});

test('writes during point preparation are retained by append, not replaced by initialization', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const pending = source.importColumnar(pointBatch(3), { mode: 'append' });
  source.features.add({ id: 'during', geometry: { type: 'point', position: { lng: 14, lat: 50 } } });
  const ref = source.features.ref('during');
  await pending;
  assert.equal(source.features.count(), 4);
  assert.deepEqual(source.features.ref('during'), ref);
  map.destroy();
});

test('bulk initialization preserves the binding touched-reference overflow contract', async () => {
  const scene = new Scene(crs.webMercator(), manualClock());
  const control = scene.createVectorSource('control');
  control.features.add(['a', 't'].map(id => ({ id, geometry: { type: 'point' as const, position: { lng: 14, lat: 50 } }, properties: { value: id === 'a' ? 1 : 0 } })));
  scene.bindings.add({ id: 'copy', target: control.features.ref('t'), properties: { kind: 'copyProperty', from: control.features.ref('a'), field: 'value' } });
  try {
    const before = scene.bindings.evaluatedCount;
    await scene.createVectorSource('small').importColumnar(pointBatch(2));
    assert.equal(scene.bindings.evaluatedCount, before, 'unrelated small imports do not reevaluate the binding');
    await scene.createVectorSource('large').importColumnar(pointBatch(5000));
    assert.equal(scene.bindings.evaluatedCount, before + 1, 'overflow safely reevaluates all bindings once');
    assert.equal(control.features.get('t')!.properties.value, 1);
  } finally {
    scene.destroy();
  }
});
