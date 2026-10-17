import test from 'node:test';
import assert from 'node:assert/strict';

import { crs as crsRegistry } from '../../src/index.ts';
import type { TileFetch, TileFetchResponse } from '../../src/scene/vector-tile-source.ts';
import type { VectorTilesSourceHandle } from '../../src/index.ts';
import { makeMap, type MapFixture } from '../helpers/fixture.ts';
import {
  encodeLayer,
  encodeTile,
  geomLine,
  geomPoint,
  geomPolygon,
} from '../helpers/mvt-encoder.ts';

/* ------------------------------- fixtures -------------------------------- */

const URL_MAIN = '/tiles/{z}/{x}/{y}.mvt';

// z1 tile world size is 128 world units; local extent 4096 -> world = local / 32.
const EMPTY = (): Uint8Array => encodeTile([]);

function mainRoutes(): Map<string, Uint8Array> {
  const routes = new Map<string, Uint8Array>();
  // roads id 5 spans tiles (1,0,0) and (1,1,0): one logical feature, two fragments.
  routes.set(
    '/tiles/1/0/0.mvt',
    encodeTile([
      encodeLayer({
        name: 'roads',
        features: [
          {
            id: 5,
            type: 2,
            geometry: geomLine([
              [
                [0, 2048],
                [4096, 2048],
              ],
            ]),
          },
        ],
      }),
      encodeLayer({
        name: 'buildings',
        features: [
          {
            id: 5,
            type: 3,
            geometry: geomPolygon([
              [
                [1024, 1024],
                [3072, 1024],
                [3072, 3072],
                [1024, 3072],
              ],
            ]),
          },
        ],
      }),
      encodeLayer({ name: 'pois', features: [{ type: 1, geometry: geomPoint([[2048, 1024]]) }] }),
      encodeLayer({
        name: 'big',
        features: [{ id: 9007199254740993n, type: 1, geometry: geomPoint([[512, 512]]) }],
      }),
    ]),
  );
  routes.set(
    '/tiles/1/1/0.mvt',
    encodeTile([
      encodeLayer({
        name: 'roads',
        features: [
          {
            id: 5,
            type: 2,
            geometry: geomLine([
              [
                [0, 2048],
                [4096, 2048],
              ],
            ]),
          },
        ],
      }),
    ]),
  );
  routes.set('/tiles/1/0/1.mvt', EMPTY());
  routes.set('/tiles/1/1/1.mvt', EMPTY());
  return routes;
}

class FakeTiles {
  calls: string[] = [];
  manual = false;
  private readonly routes = new Map<string, Uint8Array>();
  private readonly waiters = new Map<
    string,
    { resolve: (response: TileFetchResponse) => void; reject: (error: unknown) => void }[]
  >();

  constructor(routes?: Map<string, Uint8Array>) {
    if (routes) this.routes = routes;
  }

  readonly fetchFn: TileFetch = (url) => {
    this.calls.push(url);
    if (!this.manual) {
      return Promise.resolve(responseFor(this.routes.get(url) ?? EMPTY(), true, 200));
    }
    return new Promise<TileFetchResponse>((resolve, reject) => {
      const list = this.waiters.get(url) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(url, list);
    });
  };

  pending(url: string): number {
    return this.waiters.get(url)?.length ?? 0;
  }

  respond(url: string, bytes: Uint8Array): void {
    const waiter = this.waiters.get(url)?.shift();
    if (!waiter) throw new Error(`no pending request for ${url}; calls: ${this.calls.join(', ')}`);
    waiter.resolve(responseFor(bytes, true, 200));
  }

  fail(url: string, status = 404): void {
    const waiter = this.waiters.get(url)?.shift();
    if (!waiter) throw new Error(`no pending request for ${url}; calls: ${this.calls.join(', ')}`);
    waiter.resolve(responseFor(EMPTY(), false, status));
  }
}

function responseFor(bytes: Uint8Array, ok: boolean, status: number): TileFetchResponse {
  return {
    ok,
    status,
    arrayBuffer() {
      return Promise.resolve(bytes.slice().buffer);
    },
  };
}

const toGeo = (x: number, y: number) => crsRegistry.webMercator().fromWorld({ x, y });

async function until(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function setup(): Promise<{
  fixture: MapFixture;
  fake: FakeTiles;
  source: VectorTilesSourceHandle;
}> {
  const fixture = await makeMap({
    size: { width: 200, height: 200 },
    center: toGeo(100, 100),
    zoom: 1,
  });
  const fake = new FakeTiles(mainRoutes());
  const source = fixture.map.data.vectorTiles({
    id: 'vt',
    url: URL_MAIN,
    minZoom: 0,
    maxZoom: 2,
    fetchFn: fake.fetchFn,
  });
  return { fixture, fake, source };
}

/* --------------------------------- tests --------------------------------- */

test('MVT-01/02/03: fragments share one identity, source layers are namespaces, ids stay exact', async () => {
  const { fixture, fake, source } = await setup();
  const { map } = fixture;
  map.addLayer({ id: 'ln', type: 'lines', source: 'vt', namespace: 'roads', style: {} });
  map.addLayer({ id: 'fl', type: 'fills', source: 'vt', namespace: 'buildings', style: {} });
  map.addLayer({ id: 'any', type: 'points', source: 'vt', style: {} });
  await until(() => source.snapshot().stats.loaded.length === 4, 'four tiles loaded');

  assert.equal(source.features.count(), 4, 'roads 5, buildings 5, tile-local pois, big id');

  // MVT-01: the road crosses two tiles but is ONE logical feature.
  const road = source.features.get(5, { namespace: 'roads' });
  assert.ok(road, 'road exists');
  assert.equal(road.geometry.type, 'multiLineString');
  if (road.geometry.type !== 'multiLineString') throw new Error('expected multiLineString');
  assert.equal(road.geometry.lines.length, 2, 'both tile fragments render');

  // MVT-02: the same provider id in two source layers stays two identities.
  const building = source.features.get(5, { namespace: 'buildings' });
  assert.ok(building);
  assert.equal(building.geometry.type, 'polygon');
  assert.equal(map.debug.countLayerRecords('ln'), 1, 'roads layer sees only its namespace');
  assert.equal(map.debug.countLayerRecords('fl'), 1, 'buildings layer sees only its namespace');
  assert.equal(
    map.debug.countLayerRecords('any'),
    4,
    'a layer without a namespace sees every record',
  );
  assert.ok(map.debug.layerInstances('ln') > 0, 'the road batch is planned');

  // MVT-03: the uint64 id beyond 2^53 is retrievable exactly.
  assert.equal(source.features.has('9007199254740993', { namespace: 'big' }), true);
  assert.equal(
    source.features.get('9007199254740993', { namespace: 'big' })?.ref.id,
    '9007199254740993',
  );

  // MVT-01: selection and state never split between fragments.
  const ref = source.features.ref(5, { namespace: 'roads' });
  map.state.set(ref, { selected: true });
  map.selection.set([ref]);
  assert.equal(map.state.get(ref).selected, true);
  assert.equal(map.selection.get().length, 1);
  assert.equal(fake.calls.length, 4);
  map.destroy();
});

test('MVT-05/06: viewport unload changes availability; reload restores stable-identity state', async () => {
  const { fixture, source } = await setup();
  const { map } = fixture;
  await until(() => source.snapshot().stats.loaded.length === 4, 'four tiles loaded');
  const ref = source.features.ref(5, { namespace: 'roads' });
  map.state.set(ref, { selected: true });

  // Part unload: tile (1,1,0) leaves the viewport, its fragment disappears.
  map.setView({ center: toGeo(20, 20) });
  await until(() => source.snapshot().stats.loaded.length === 1, 'outer tiles retired');
  const partial = source.features.get(5, { namespace: 'roads' });
  assert.equal(partial?.geometry.type, 'lineString', 'one fragment left declares one line');

  // Full unload: no fragment remains, so the provider feature is not available.
  map.setView({ center: toGeo(240, 240) });
  await until(() => source.features.count() === 0, 'all fragments unloaded');
  assert.equal(source.features.has(5, { namespace: 'roads' }), false);

  // Reload: the stable identity comes back and keeps its state (MVT-06).
  map.setView({ center: toGeo(100, 100) });
  await until(() => source.features.count() === 4, 'features reloaded');
  const reloaded = source.features.ref(5, { namespace: 'roads' });
  assert.equal(map.state.get(reloaded).selected, true, 'state follows the stable identity');
  assert.equal(source.features.get(5, { namespace: 'roads' })?.geometry.type, 'multiLineString');
  map.destroy();
});

test('MVT-04: tile-local identity is scoped to the loaded tile and never transfers state', async () => {
  const { fixture, source } = await setup();
  const { map } = fixture;
  await until(() => source.snapshot().stats.loaded.length === 4, 'four tiles loaded');
  const oldId = source.features.ids({ namespace: 'pois' })[0]!;
  assert.match(String(oldId), /^tl:1\/0\/0:/);
  map.state.set(source.features.ref(oldId, { namespace: 'pois' }), { selected: true });

  map.setView({ center: toGeo(240, 240) });
  await until(() => source.features.count() === 0, 'unloaded');
  map.setView({ center: toGeo(100, 100) });
  await until(() => source.features.count() === 4, 'reloaded');

  const newId = source.features.ids({ namespace: 'pois' })[0]!;
  assert.match(String(newId), /^tl:1\/0\/0:/);
  assert.notEqual(newId, oldId, 'a reloaded tile-local feature is a new identity');
  assert.equal(source.features.has(oldId, { namespace: 'pois' }), false);
  assert.equal(
    map.state.get(source.features.ref(newId, { namespace: 'pois' })).selected,
    false,
    'state never transfers to a different tile-local object',
  );
  map.destroy();
});

test('MVT-08: stale responses never overwrite the current tile revision', async () => {
  const fixture = await makeMap({
    size: { width: 200, height: 200 },
    center: toGeo(20, 20),
    zoom: 1,
  });
  const fake = new FakeTiles();
  fake.manual = true;
  const source = fixture.map.data.vectorTiles({
    id: 'vt',
    url: '/stale/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 2,
    fetchFn: fake.fetchFn,
  });
  await until(() => fake.pending('/stale/1/0/0.mvt') === 1, 'first tile requested');

  // Leave the viewport while the request is in flight; the tile is retired.
  fixture.map.setView({ center: toGeo(240, 240) });
  await until(() => fake.calls.includes('/stale/1/1/1.mvt'), 'the new viewport requested its tile');
  fake.respond(
    '/stale/1/0/0.mvt',
    encodeTile([
      encodeLayer({
        name: 'l',
        features: [{ id: 42, type: 1, geometry: geomPoint([[100, 100]]) }],
      }),
    ]),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(source.features.has(42, { namespace: 'l' }), false, 'stale response discarded');

  // Returning re-requests the tile; the fresh response is installed.
  fixture.map.setView({ center: toGeo(20, 20) });
  await until(() => fake.pending('/stale/1/0/0.mvt') === 1, 'second tile requested');
  fake.respond(
    '/stale/1/0/0.mvt',
    encodeTile([
      encodeLayer({
        name: 'l',
        features: [{ id: 77, type: 1, geometry: geomPoint([[100, 100]]) }],
      }),
    ]),
  );
  await until(() => source.features.has(77, { namespace: 'l' }), 'fresh response installed');
  assert.equal(source.features.has(42, { namespace: 'l' }), false);
  fixture.map.destroy();
});

test('MVT-08: a failed tile is visible, retried after eviction and recovered', async () => {
  const fixture = await makeMap({
    size: { width: 200, height: 200 },
    center: toGeo(20, 20),
    zoom: 1,
  });
  const fake = new FakeTiles();
  fake.manual = true;
  const source = fixture.map.data.vectorTiles({
    id: 'vt',
    url: '/err/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 2,
    fetchFn: fake.fetchFn,
  });
  await until(() => fake.pending('/err/1/0/0.mvt') === 1, 'tile requested');
  fake.fail('/err/1/0/0.mvt', 500);
  await until(() => source.snapshot().stats.failed === 1, 'failure reported');
  assert.equal(source.features.count(), 0, 'no half-decoded features');

  // Evict and return: the failed tile is retried, this time successfully.
  fixture.map.setView({ center: toGeo(240, 240) });
  await until(() => source.snapshot().stats.failed === 0, 'failed tile retired with the viewport');
  fixture.map.setView({ center: toGeo(20, 20) });
  await until(() => fake.pending('/err/1/0/0.mvt') === 1, 'retry requested');
  fake.respond(
    '/err/1/0/0.mvt',
    encodeTile([
      encodeLayer({ name: 'l', features: [{ id: 9, type: 1, geometry: geomPoint([[100, 100]]) }] }),
    ]),
  );
  await until(() => source.features.has(9, { namespace: 'l' }), 'recovered tile installed');
  assert.equal(source.snapshot().stats.failed, 0);
  fixture.map.destroy();
});

test('MVT: decode failures surface as tile errors without touching other tiles', async () => {
  const fixture = await makeMap({
    size: { width: 200, height: 200 },
    center: toGeo(100, 100),
    zoom: 1,
  });
  const fake = new FakeTiles();
  fake.manual = true;
  const source = fixture.map.data.vectorTiles({
    id: 'vt',
    url: '/mixed/{z}/{x}/{y}.mvt',
    minZoom: 0,
    maxZoom: 2,
    fetchFn: fake.fetchFn,
  });
  await until(() => fake.calls.length === 4, 'four tiles requested');
  fake.respond('/mixed/1/0/0.mvt', Uint8Array.from([0x1a, 0x05, 0x01]));
  fake.respond(
    '/mixed/1/1/0.mvt',
    encodeTile([
      encodeLayer({ name: 'l', features: [{ id: 1, type: 1, geometry: geomPoint([[100, 100]]) }] }),
    ]),
  );
  fake.respond('/mixed/1/0/1.mvt', EMPTY());
  fake.respond('/mixed/1/1/1.mvt', EMPTY());
  await until(() => source.snapshot().stats.failed === 1, 'one tile failed');
  await until(() => source.features.has(1, { namespace: 'l' }), 'the healthy tile is installed');
  assert.equal(source.features.count(), 1);
  fixture.map.destroy();
});

test('MVT-07: provider bytes are read-only; edits live in a mutable overlay', async () => {
  const { fixture, source } = await setup();
  const { map } = fixture;
  await until(() => source.snapshot().stats.loaded.length === 4, 'four tiles loaded');
  const provider = source.features.get(5, { namespace: 'roads' });
  assert.ok(provider);
  const geometryBefore = provider.geometry;

  const overlay = map.data.vector({ id: 'overlay' });
  overlay.features.add({
    id: 5,
    namespace: 'roads',
    geometry: geometryBefore,
    properties: { edited: true },
  });
  overlay.features.update(
    5,
    {
      geometry: {
        type: 'lineString',
        positions: [
          { lat: 50, lng: 14 },
          { lat: 50.1, lng: 14.1 },
        ],
      },
    },
    { namespace: 'roads' },
  );

  const after = source.features.get(5, { namespace: 'roads' });
  assert.deepEqual(after?.geometry, geometryBefore, 'tile geometry keeps its original bytes');
  assert.equal(
    after?.properties.edited,
    undefined,
    'overlay edits do not leak into the tile source',
  );
  assert.equal(overlay.features.get(5, { namespace: 'roads' })?.properties.edited, true);
  // The MVT handle exposes no mutation API at all.
  assert.equal('add' in source.features, false);
  assert.equal('update' in source.features, false);
  assert.equal('remove' in source.features, false);
  map.destroy();
});

test('MVT: the tile budget defers work instead of dropping needed tiles silently', async () => {
  const fixture = await makeMap({
    size: { width: 200, height: 200 },
    center: toGeo(100, 100),
    zoom: 1,
  });
  const fake = new FakeTiles(mainRoutes());
  const source = fixture.map.data.vectorTiles({
    id: 'vt',
    url: URL_MAIN,
    minZoom: 0,
    maxZoom: 2,
    maxTiles: 1,
    fetchFn: fake.fetchFn,
  });
  await until(() => source.snapshot().stats.deferred === 3, 'three tiles deferred by the budget');
  assert.equal(source.snapshot().stats.loaded.length, 1);
  assert.equal(fake.calls.length, 1, 'only the budget allows one request');
  fixture.map.destroy();
});

test('DATA listing: vector tile sources are registered sources with their handle', async () => {
  const fixture = await makeMap();
  const fake = new FakeTiles(mainRoutes());
  const source = fixture.map.data.vectorTiles({
    id: 'vt',
    url: URL_MAIN,
    attribution: '© Tiles',
    fetchFn: fake.fetchFn,
  });
  assert.ok(
    fixture.map.data.list().includes('vt'),
    'the listing feeds the attribution notice (UI-03)',
  );
  assert.equal(fixture.map.data.get('vt'), source);
  assert.equal(fixture.map.data.get('vt')?.type, 'vectorTiles');
  fixture.map.destroy();
});

test('MVT overzoom: above maxZoom tiles stay clamped and features survive further zoom', async () => {
  const routes = new Map<string, Uint8Array>();
  // z2 tile (1,1) covers world 64..128; a diagonal road makes the tile non-empty.
  routes.set(
    '/tiles/2/1/1.mvt',
    encodeTile([
      encodeLayer({
        name: 'roads',
        features: [
          {
            id: 11,
            type: 2,
            geometry: geomLine([
              [
                [0, 0],
                [4096, 4096],
              ],
            ]),
          },
        ],
      }),
    ]),
  );
  const fixture = await makeMap({
    size: { width: 200, height: 200 },
    center: toGeo(100, 100),
    zoom: 4,
  });
  const fake = new FakeTiles(routes);
  const source = fixture.map.data.vectorTiles({
    id: 'vt',
    url: URL_MAIN,
    minZoom: 0,
    maxZoom: 2,
    fetchFn: fake.fetchFn,
  });
  fixture.map.addLayer({ id: 'ln', type: 'lines', source: 'vt', namespace: 'roads', style: {} });
  await until(() => source.features.has(11, { namespace: 'roads' }), 'the maxZoom tile loaded');
  assert.ok(
    source.snapshot().stats.loaded.every((coord) => coord.z === 2),
    'tiles are clamped to maxZoom',
  );
  assert.ok(
    fake.calls.every((url) => url.startsWith('/tiles/2/')),
    `only maxZoom tiles are requested: ${fake.calls.join(', ')}`,
  );

  // Zooming further keeps the same clamped tile set: no new requests, same identity.
  const callsBefore = fake.calls.length;
  const commit = fixture.map.setView({ zoom: 9 });
  await fixture.map.whenRendered(commit.revision);
  assert.equal(fake.calls.length, callsBefore, 'overzoom does not request deeper tile zooms');
  assert.ok(source.features.has(11, { namespace: 'roads' }), 'identity survives the overzoom');

  // Planned geometry scales with the view zoom (2^zoom px per world unit), not the tile zoom.
  const a = fixture.map.positionToScreen(toGeo(80, 80));
  const b = fixture.map.positionToScreen(toGeo(100, 80));
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(
    Math.abs(distance - 20 * 2 ** 9) < 1e-6,
    `screen distance ${distance} follows the view zoom`,
  );
  fixture.map.destroy();
});
