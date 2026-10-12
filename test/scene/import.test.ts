import test from 'node:test';
import assert from 'node:assert/strict';

import { crs, isMapletError } from '../../src/index.ts';
import { makeMap } from '../helpers/fixture.ts';

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
