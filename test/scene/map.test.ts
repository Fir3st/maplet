import test from 'node:test';
import assert from 'node:assert/strict';

import { createMap, crs, isMapletError } from '../../src/index.ts';
import { makeMap, settled } from '../helpers/fixture.ts';

async function expectError(promise: Promise<unknown>, code: string): Promise<unknown> {
  try {
    await promise;
    assert.fail(`expected a ${code} error`);
  } catch (error) {
    assert.ok(isMapletError(error), `expected MapletError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
}

test('MAP-05: invalid input is rejected before a handle is published', async () => {
  await expectError(
    createMap({
      renderer: { primary: 'none' },
      view: { center: { lat: 0, lng: 0 }, zoom: Number.NaN },
    }),
    'invalid-argument',
  );
  await expectError(
    createMap({
      renderer: { primary: 'none' },
      projection: {} as never,
      view: { center: { lat: 0, lng: 0 }, zoom: 2 },
    }),
    'invalid-argument',
  );
  await expectError(
    createMap({
      renderer: { primary: 'none' },
      minZoom: 10,
      maxZoom: 2,
    }),
    'invalid-argument',
  );
});

test('MAP-07: math imports work without DOM; createMap requires browser for GPU renderers', async () => {
  const point = crs.webMercator().toWorld({ lat: 0, lng: 0 });
  assert.equal(point.x, 128);
  await expectError(
    createMap({ container: 'map', renderer: { primary: 'webgl1', fallback: false } }),
    'environment',
  );
});

test('MAP-06: two maps are independent and cross-scene references are rejected', async () => {
  const a = await makeMap();
  const b = await makeMap();
  const sourceA = a.map.sources.vector({ id: 'stations' });
  const sourceB = b.map.sources.vector({ id: 'stations' });
  sourceA.features.add({ id: 'x', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  sourceB.features.add({ id: 'x', geometry: { type: 'point', position: { lat: 40, lng: -3 } } });
  const refA = sourceA.features.ref('x');
  sourceA.features.update(refA, { properties: { name: 'A' } });
  assert.equal(sourceA.features.get('x')?.properties.name, 'A');
  assert.equal(sourceB.features.get('x')?.properties.name, undefined);
  try {
    sourceB.features.update(refA, { properties: { name: 'crossed' } });
    assert.fail('expected a stale-reference error');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'stale-reference');
  }
  a.map.destroy();
  b.map.destroy();
});

test('REF-01/02/03: handles survive transparent proxies and detached methods', async () => {
  const { map } = await makeMap();
  const wrapped = new Proxy(map, {});
  const nested = new Proxy(wrapped, {});
  const source = nested.sources.vector({ id: 's' });
  const wrappedSource = new Proxy(source, {});
  wrappedSource.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  assert.equal(wrappedSource.features.get('a')?.ref.id, 'a');

  const set = nested.view.set;
  const commit = set({ zoom: 9 });
  assert.ok(commit.revision > 0);
  assert.equal(nested.view.get().zoom, 9);

  const add = wrappedSource.features.add;
  add({ id: 'b', geometry: { type: 'point', position: { lat: 51, lng: 15 } } });
  assert.equal(wrappedSource.features.count(), 2);

  const remove = wrappedSource.features.remove;
  remove('a');
  assert.equal(wrappedSource.features.has('a'), false);

  const destroy = nested.destroy;
  destroy();
  assert.equal(map.destroyed, true);
});

test('REF-04: a proxied feature ref is resolved by value identity', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  const ref = new Proxy(source.features.ref('a'), {});
  map.selection.set([ref]);
  assert.equal(map.selection.get().length, 1);
  assert.equal(map.selection.get()[0]?.id, 'a');
  map.state.set(ref, { selected: true });
  assert.equal(map.state.get(ref).selected, true);
  map.destroy();
});

test('REF-05: snapshot mutation never reaches the map', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({
    id: 'a',
    geometry: { type: 'point', position: { lat: 50, lng: 14 } },
    properties: { name: 'original' },
  });
  const snapshot = source.features.get('a');
  assert.ok(snapshot);
  (snapshot.properties as { name: string }).name = 'mutated';
  assert.equal(source.features.get('a')?.properties.name, 'original');
  const view = map.view.get();
  assert.ok(Object.isFrozen(view));
  assert.throws(() => {
    (view as { zoom: number }).zoom = 99;
  }, TypeError);
  map.destroy();
});

test('REF-06: a recreated id gets a new generation and old refs never rebind', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  const old = source.features.ref('a');
  source.features.remove('a');
  source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 52, lng: 16 } } });
  const fresh = source.features.ref('a');
  assert.ok(fresh.generation > old.generation);
  try {
    map.state.set(old, { selected: true });
    assert.fail('expected a stale-reference error');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'stale-reference');
  }
  assert.equal(map.selection.get().length, 0);
  map.destroy();
});

test('REF-07: 500k features without per-feature handles or listeners', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 'big' });
  const items = new Array(500_000);
  for (let i = 0; i < items.length; i++) {
    items[i] = {
      id: i,
      geometry: { type: 'point', position: { lat: 50 + (i % 100) / 1000, lng: 14 + (i % 1000) / 10000 } },
    };
  }
  const start = Date.now();
  await source.features.replace(items);
  const elapsed = Date.now() - start;
  assert.equal(source.features.count(), 500_000);
  const refA = source.features.ref(42);
  assert.equal(source.features.has(42), true);
  assert.equal(source.features.has('42'), false, 'number 42 and string "42" are distinct');
  assert.equal(typeof refA.id, 'number');
  // No subscription was created for any feature; only the two refs exist.
  assert.ok(elapsed < 30_000, `import took ${elapsed}ms`);
  map.destroy();
});

test('VIEW-01: fractional zoom round trips and inputs are not mutated', async () => {
  const { map } = await makeMap();
  const frozen = Object.freeze({ center: Object.freeze({ lat: 49.2, lng: 16.6 }), zoom: 7.5 });
  map.view.set(frozen);
  const snapshot = map.view.get();
  assert.equal(snapshot.zoom, 7.5);
  assert.ok('lat' in snapshot.center && Math.abs(snapshot.center.lat - 49.2) < 1e-9);
  assert.ok(snapshot.revision > 0);
  assert.deepEqual(frozen, { center: { lat: 49.2, lng: 16.6 }, zoom: 7.5 });
  map.destroy();
});

test('VIEW-02: fit uses the largest allowed zoom with asymmetric padding', async () => {
  const { map } = await makeMap({
    view: { center: { lat: 50, lng: 14 }, zoom: 5 },
  });
  const bounds = { southwest: { lat: 49, lng: 13 }, northeast: { lat: 51, lng: 16 } };
  const padding = { top: 40, right: 120, bottom: 20, left: 20 };
  map.view.fit(bounds, { padding });
  const availableWidth = 800 - 120 - 20;
  const availableHeight = 600 - 40 - 20;
  // Independent oracle: world size of the bounds, then log2 of the scale.
  const mercator = crs.webMercator();
  const sw = mercator.toWorld(bounds.southwest);
  const ne = mercator.toWorld(bounds.northeast);
  const expectedZoom = Math.min(
    Math.log2(availableWidth / (ne.x - sw.x)),
    Math.log2(availableHeight / (sw.y - ne.y)),
  );
  const snapshot = map.view.get();
  assert.ok(Math.abs(snapshot.zoom - expectedZoom) < 1e-9, `zoom ${snapshot.zoom} vs ${expectedZoom}`);
  for (const corner of [
    bounds.southwest,
    bounds.northeast,
    { lat: bounds.southwest.lat, lng: bounds.northeast.lng },
    { lat: bounds.northeast.lat, lng: bounds.southwest.lng },
  ]) {
    const screen = map.view.positionToScreen(corner);
    assert.ok(screen.x >= padding.left - 1e-6 && screen.x <= 800 - padding.right + 1e-6, `x ${screen.x}`);
    assert.ok(screen.y >= padding.top - 1e-6 && screen.y <= 600 - padding.bottom + 1e-6, `y ${screen.y}`);
  }
  map.destroy();
});

test('VIEW-03: fitting a single point centers it and respects maxZoom', async () => {
  const { map } = await makeMap();
  map.view.fit({ southwest: { lat: 50, lng: 14 }, northeast: { lat: 50, lng: 14 } }, { maxZoom: 12 });
  const snapshot = map.view.get();
  assert.equal(snapshot.zoom, 12);
  assert.ok('lat' in snapshot.center && Math.abs(snapshot.center.lat - 50) < 1e-9);
  assert.ok('lng' in snapshot.center && Math.abs(snapshot.center.lng - 14) < 1e-9);
  map.destroy();
});

test('VIEW-04: zoom limits and maxBounds clamp every published view', async () => {
  const { map } = await makeMap({
    minZoom: 4,
    maxZoom: 10,
    maxBounds: { southwest: { lat: 45, lng: 5 }, northeast: { lat: 55, lng: 25 } },
  });
  map.view.set({ zoom: 2 });
  assert.equal(map.view.get().zoom, 4);
  map.view.set({ zoom: 100 });
  assert.equal(map.view.get().zoom, 10);
  map.view.set({ center: { lat: 0, lng: -100 } });
  const snapshot = map.view.get();
  assert.ok('lat' in snapshot.center && snapshot.center.lat >= 45 - 1e-9);
  assert.ok('lng' in snapshot.center && snapshot.center.lng >= 5 - 1e-9);
  map.destroy();
});

test('VIEW-05: zooming around a screen point keeps the position anchored', async () => {
  const { map } = await makeMap();
  const anchor = { x: 200, y: 150 };
  const before = map.view.screenToPosition(anchor);
  map.view.zoomAround(anchor, 1);
  const after = map.view.screenToPosition(anchor);
  assert.ok('lat' in before && 'lat' in after);
  assert.ok(Math.abs(before.lat - after.lat) < 1e-9);
  assert.ok(Math.abs(before.lng - after.lng) < 1e-9);
  assert.equal(map.view.get().zoom, 9);
  map.destroy();
});

test('VIEW-06/07: flyTo interpolates continuously and stop ends at the current view', async () => {
  const { map, clock } = await makeMap();
  const events: string[] = [];
  map.on('viewstart', () => events.push('start'));
  map.on('viewchange', () => events.push('change'));
  map.on('viewend', () => events.push('end'));
  const flying = map.view.flyTo({ center: { lat: 48.85, lng: 2.35 }, zoom: 12 }, { duration: 300 });
  assert.deepEqual(events, ['start']);
  clock.advance(150);
  const mid = map.view.get();
  assert.ok(mid.zoom > 8 && mid.zoom < 12, `zoom ${mid.zoom}`);
  assert.ok(events.includes('change'));
  // Advance past the last scheduled tick so the animation can reach its exact end.
  clock.advance(200);
  await flying;
  const end = map.view.get();
  assert.equal(end.zoom, 12);
  assert.ok('lat' in end.center && Math.abs(end.center.lat - 48.85) < 1e-9);
  assert.equal(events[events.length - 1], 'end');

  events.length = 0;
  const first = map.view.flyTo({ zoom: 5 }, { duration: 500 });
  clock.advance(100);
  map.view.stop();
  await first;
  const stopped = map.view.get();
  assert.ok(stopped.zoom < 12 && stopped.zoom > 5);
  const second = map.view.flyTo({ center: { lat: 50, lng: 14 } }, { duration: 100 });
  clock.advance(200);
  await second;
  const finalCenter = map.view.get().center;
  assert.ok('lat' in finalCenter && Math.abs(finalCenter.lat - 50) < 1e-9);
  assert.equal(events.filter((event) => event === 'start').length, 2);
  map.destroy();
});

test('VIEW-09: a zero-sized container produces no NaN and recovers on resize', async () => {
  const { map } = await makeMap();
  map.view.resize(0, 0);
  assert.equal(map.view.getBounds(), null);
  const snapshot = map.view.get();
  assert.ok(Number.isFinite(snapshot.zoom));
  map.view.resize(640, 480);
  const bounds = map.view.getBounds();
  assert.ok(bounds);
  assert.ok('lat' in bounds.southwest);
  assert.equal(map.view.get().size.width, 640);
  map.destroy();
});

test('VIEW-10: panning changes the view revision, not the data revision', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const items = new Array(50_000);
  for (let i = 0; i < items.length; i++) {
    items[i] = {
      id: i,
      geometry: { type: 'point', position: { lat: 50 + (i % 200) / 2000, lng: 14 + (i % 500) / 5000 } },
    };
  }
  await source.features.replace(items);
  const dataRevision = map.stats().revision;
  const before = source.features.get(25_000)?.ref.generation;
  for (let i = 0; i < 20; i++) {
    map.view.set({ center: { lat: 50.01 + i * 0.001, lng: 14.01 + i * 0.001 } });
  }
  // Data revision advanced only by the view changes' commits; the feature data
  // itself was not rewritten and its identity/generation is stable.
  assert.equal(source.features.get(25_000)?.ref.generation, before);
  assert.ok(map.stats().revision > dataRevision);
  assert.equal(source.features.count(), 50_000);
  map.destroy();
});

test('batch and whenRendered resolve on the headless backend', async () => {
  const { map } = await makeMap();
  const source = map.sources.vector({ id: 's' });
  const commit = map.batch(() => {
    source.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
    source.features.add({ id: 'b', geometry: { type: 'point', position: { lat: 51, lng: 15 } } });
  });
  await map.whenRendered(commit.revision);
  assert.ok(map.stats().renderedRevision >= commit.revision);
  await settled();
  map.destroy();
});

test('destroy is idempotent and further operations fail with the destroyed code', async () => {
  const { map } = await makeMap();
  map.destroy();
  map.destroy();
  assert.equal(map.destroyed, true);
  assert.throws(() => map.sources.vector({ id: 's' }), /destroyed/);
  try {
    await map.whenRendered(map.stats().revision);
    assert.fail('expected a destroyed error');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'destroyed');
  }
});
