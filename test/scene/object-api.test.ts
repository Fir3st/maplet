import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../src/index.ts';
import {
  createMap,
  crs,
  style,
  type MapFeatureEvent,
  type PointGeometry,
} from '../../src/index.ts';
import { Emitter } from '../../src/api/events.ts';
import { featureEvents } from '../../src/api/feature-events.ts';
import { makeMap } from '../helpers/fixture.ts';

test('object API: flat map options, tuple coordinates, detached view methods and no legacy facade', async () => {
  const map = await createMap(null, { renderer: 'none', center: [50.08, 14.44], zoom: 8 });
  assert.equal(map.getZoom(), 8);
  assert.ok('lat' in map.getCenter());
  assert.equal('sources' in map, false);
  assert.equal('view' in map, false);
  assert.equal('add' in map.layers, false);
  assert.equal('expr' in api, false);
  const proxiedMap = new Proxy(map, {});
  const setCenter = proxiedMap.setCenter.bind(proxiedMap);
  setCenter([51, 15]);
  assert.ok(Math.abs((map.getCenter() as { lat: number }).lat - 51) < 1e-9);
  await assert.rejects(createMap({ container: 'map' } as never), /element/);
  await assert.rejects(
    createMap(null, { renderer: 'none', projection: crs.simple(), center: [1, 2] }),
    /planar CRS/,
  );
  map.destroy();
});

test('object API: points can be created, moved, styled, selected and deleted directly', async () => {
  const { map } = await makeMap();
  const points = map.addPoints<{ status: 'online' | 'offline'; name: string }>(
    [{ id: 'prague', position: [50.08, 14.44], properties: { status: 'online', name: 'Prague' } }],
    {
      draggable: true,
      style: {
        radiusPx: 9,
        color: style.by('status', { online: '#16a34a', offline: '#dc2626' }, '#6b7280'),
      },
    },
  );
  const prague = points.get('prague')!;
  const ref = prague.ref;
  assert.equal(map.layers.get(points.id), points);
  assert.equal(map.debug.layerColor(points.id), '#16a34a');
  prague.setProperties({ status: 'offline' });
  assert.equal(map.debug.layerColor(points.id), '#dc2626');
  const proxiedPrague = new Proxy(prague, {});
  const move = proxiedPrague.setPosition.bind(proxiedPrague);
  move([50.1, 14.5]);
  assert.deepEqual(prague.ref, ref);
  assert.equal(prague.get().properties.name, 'Prague');
  prague.setStyle({ color: '#0000ff' });
  prague.hide();
  assert.equal(map.debug.layerInstances(points.id), 0);
  prague.show();
  assert.equal(map.debug.layerColor(points.id), '#0000ff');
  assert.equal(points.count(), 1);
  prague.select();
  assert.deepEqual(map.selection.get(), [ref]);
  prague.deselect();
  assert.deepEqual(map.selection.get(), []);
  prague.remove();
  assert.equal(points.get('prague'), undefined);
  assert.equal(prague.removed, true);
  points.add({ id: 'prague', position: [49, 13], properties: { name: 'New', status: 'online' } });
  assert.throws(() => prague.setPosition([0, 0]), /removed/);
  assert.notEqual(points.get('prague')!.ref.generation, ref.generation);
  points.remove();
  assert.equal(map.data.list().length, 0, 'inline data is released with its last layer');
  map.destroy();
});

test('object API: replacement is atomic and retains identities, bulk addition uses one commit', async () => {
  const { map } = await makeMap();
  const points = map.addPoints([{ id: 'a', position: [50, 14] }]);
  const first = points.get('a')!;
  let commits = 0;
  map.on('commit', () => commits++);
  points.addMany([
    { id: 'b', position: [51, 15] },
    { id: 'c', position: [52, 16] },
  ]);
  assert.equal(commits, 1);
  await points.setData([{ id: 'a', position: [49, 13] }]);
  assert.deepEqual(points.get('a')!.ref, first.ref);
  assert.equal(first.removed, false);
  const before = points.source.exportGeoJson();
  await assert.rejects(
    points.setData([
      { id: 'a', position: [48, 12] },
      { id: 'a', position: [0, 0] },
    ]),
    /duplicate/,
  );
  assert.deepEqual(points.source.exportGeoJson(), before);
  map.destroy();
});

test('object API: shared labels use one source and survive removal of the point layer', async () => {
  const { map } = await makeMap();
  const points = map.addPoints([{ id: 'a', position: [50, 14], properties: { name: 'A' } }]);
  const labels = map.addLabels(points.source);
  const sourceId = points.sourceId;
  points.remove();
  assert.ok(map.data.get(sourceId));
  assert.equal(map.debug.layerLabels(labels.id)[0]?.text, 'A');
  labels.get('a')!.setProperties({ name: 'Renamed' });
  assert.equal(map.debug.layerLabels(labels.id)[0]?.text, 'Renamed');
  labels.remove();
  assert.equal(map.data.get(sourceId), undefined);
  map.destroy();
});

test('object API: source ownership, id reuse and failed construction cannot affect unrelated objects', async () => {
  const { map } = await makeMap();
  const other = await makeMap();
  const source = map.data.vector<PointGeometry>({ id: 'shared' });
  const foreign = other.map.data.vector<PointGeometry>({ id: 'shared' });
  assert.throws(() => map.addPoints(foreign), /belong/);
  const points = map.addPoints(new Proxy(source, {}), { id: 'display' });
  points.add({ id: 'proxied', position: [50, 14] });
  points.get('proxied')!.setPosition([51, 15]);
  points.remove();
  assert.equal(map.data.get(source.id), source, 'explicit shared sources are caller-owned');
  const replacement = map.addPoints([], { id: 'display' });
  assert.throws(() => points.hide(), /removed/);
  assert.equal(replacement.isVisible(), true);
  const dataBefore = map.data.list();
  assert.throws(() => map.addPoints([{ position: [0, 0] }], { id: 'display' }), /already exists/);
  assert.throws(() => map.addPoints([{ position: [0, 0] }], { parent: 'missing' }), /not found/);
  assert.deepEqual(map.data.list(), dataBefore);
  map.destroy();
  other.map.destroy();
});

test('object API: line and polygon editing use the same coordinate shorthand as creation', async () => {
  const { map } = await makeMap({ projection: crs.simple(), center: { x: 0, y: 0 }, zoom: 0 });
  const lines = map.addLines([
    {
      id: 'route',
      positions: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    },
  ]);
  lines.get('route')!.setPositions([
    { x: -1, y: -1 },
    { x: 1, y: 1 },
  ]);
  lines.add({
    id: 'second',
    positions: [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ],
  });
  const polygons = map.addPolygons([
    {
      id: 'area',
      rings: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
      ],
    },
  ]);
  polygons.get('area')!.setRings([
    [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 2 },
    ],
  ]);
  assert.equal(lines.count(), 2);
  assert.equal(polygons.count(), 1);
  assert.ok(map.debug.layerInstances(polygons.id) > 0);
  map.destroy();
});

test('object API: inline namespace defaults and style snapshots do not leak into other identities', async () => {
  const { map } = await makeMap();
  const points = map.addPoints([{ id: 'a', position: [50, 14] }], { namespace: 'stations' });
  const point = points.get('a')!;
  assert.equal(point.ref.namespace, 'stations');
  point.setStyle({ color: [1, 0, 0] });
  const snapshot = points.getFeatureStyle(point.ref)!;
  (snapshot.color as unknown as number[])[0] = 0;
  assert.deepEqual(points.getFeatureStyle(point.ref)?.color, [1, 0, 0]);
  assert.equal(map.debug.layerInstances(points.id), 1);
  map.destroy();
});

test('object API: object writes keep binding ownership and batch rollback', async () => {
  const { map } = await makeMap();
  const points = map.addPoints([
    { id: 'a', position: [50, 14] },
    { id: 'b', position: [51, 15] },
  ]);
  const lines = map.addLines([
    {
      id: 'ab',
      positions: [
        [50, 14],
        [51, 15],
      ],
    },
  ]);
  const a = points.get('a')!,
    b = points.get('b')!,
    line = lines.get('ab')!;
  map.bindings.add({
    id: 'follow',
    target: line.ref,
    geometry: { kind: 'lineBetween', from: a.ref, to: b.ref },
  });
  const before = a.getPosition();
  assert.throws(
    () =>
      map.batch(() => {
        a.setPosition([48, 12]);
        line.setPositions([
          [0, 0],
          [1, 1],
        ]);
      }),
    { code: 'ownership-conflict' },
  );
  assert.deepEqual(a.getPosition(), before);
  const revision = map.stats().revision;
  map.batch(() => {
    a.setPosition([48, 12]);
    b.setPosition([49, 13]);
  });
  assert.equal(map.stats().revision, revision + 1);
  assert.ok(Math.abs((line.get().geometry.positions[0] as { lat: number }).lat - 48) < 1e-9);
  map.destroy();
});

test('object API: layer removal releases owned data and stale layer handles cannot reach a reused id', async () => {
  const { map } = await makeMap();
  const group = map.addLayer({ id: 'group' });
  const points = group.addPoints([{ position: [50, 14] }]);
  group.remove();
  assert.equal(points.removed, true);
  assert.deepEqual(map.data.list(), []);
  const replacement = map.addLayer({ id: 'group' });
  assert.throws(() => group.hide(), /removed/);
  assert.equal(replacement.isVisible(), true);
  map.destroy();
});

test('object API: tiles create a usable layer in one operation; headless controls fail explicitly', async () => {
  const { map } = await makeMap();
  const tiles = map.addTiles('https://example.test/{z}/{x}/{y}.png', { attribution: 'Test tiles' });
  assert.equal(map.layers.get(tiles.id), tiles);
  assert.ok(map.debug.layerTiles(tiles.id).length > 0);
  assert.equal(tiles.source.getOptions().attribution, 'Test tiles');
  assert.throws(() => map.addControl('zoom'), /container/);
  assert.deepEqual(map.controls.list(), []);
  tiles.remove();
  assert.deepEqual(map.data.list(), []);
  await assert.rejects(createMap(null, { renderer: 'none', controls: ['zoom'] }), /container/);
  map.destroy();
});

test('object API: style.by uses own cases, explicit fallback and dotted properties', () => {
  const color = style.by('data.status', { online: '#16a34a' }, '#6b7280');
  const evaluate = (status: unknown) =>
    color.evaluate({
      properties: { data: { status } },
      state: { hovered: false, selected: false, disabled: false },
      zoom: 8,
    });
  assert.equal(evaluate('online'), '#16a34a');
  for (const value of ['offline', 'toString', '__proto__', null, undefined])
    assert.equal(evaluate(value), '#6b7280');
});

test('object API: subscribed objects release listeners on data removal, abort and layer removal', async () => {
  const { map } = await makeMap();
  const points = map.addPoints([{ id: 'a', position: [50, 14] }]);
  const labels = map.addLabels(points.source);
  const sourceOn = points.source.on.bind(points.source);
  let watches = 0;
  points.source.on = (type, fn, options) => {
    watches++;
    const stop = sourceOn(type, fn, options);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      watches--;
      stop();
    };
  };
  const first = points.get('a')!;
  assert.equal(watches, 0, 'getting an object installs no listener');
  first.on('click', () => {});
  first.once('dragend', () => {});
  assert.equal(watches, 1);
  points.source.features.remove('a');
  assert.equal(watches, 0, 'advanced data removal releases the object subscriptions');
  const second = points.add({ id: 'a', position: [50, 14] });
  const controller = new AbortController();
  second.on('click', () => {}, { signal: controller.signal });
  controller.abort();
  assert.equal(watches, 0);
  second.on('click', () => {});
  points.remove();
  assert.equal(
    watches,
    0,
    'layer removal releases listeners even when labels keep the source alive',
  );
  labels.remove();
  map.destroy();
});

test('object API: once waits for the requested event and AbortSignal cancels filtered subscriptions', () => {
  const emitter = new Emitter<{ feature: MapFeatureEvent }>();
  const events = featureEvents((fn, options) => emitter.on('feature', fn, options));
  const event = {
    type: 'mouseover',
    feature: { sceneId: 's', sourceId: 's', id: 'a', generation: 1 },
  } as MapFeatureEvent;
  let clicks = 0;
  events.once('click', (hit) => {
    assert.equal(hit.type, 'click');
    clicks++;
  });
  emitter.emit('feature', event);
  emitter.emit('feature', { ...event, type: 'click' });
  emitter.emit('feature', { ...event, type: 'click' });
  assert.equal(clicks, 1);
  const controller = new AbortController();
  const off = events.on('dragend', () => clicks++, { signal: controller.signal });
  controller.abort();
  off();
  off();
  emitter.emit('feature', { ...event, type: 'dragend' });
  assert.equal(clicks, 1);
  assert.throws(() => events.on('feature' as never, () => {}), /unknown/);
});

test('object API: layer lifetime cancels filtered listeners and their external abort handlers', () => {
  const emitter = new Emitter<{ feature: MapFeatureEvent }>();
  const lifetime = new AbortController();
  const external = new AbortController();
  let abortHandlers = 0;
  const add = external.signal.addEventListener.bind(external.signal);
  const remove = external.signal.removeEventListener.bind(external.signal);
  external.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => {
    if (args[0] === 'abort') abortHandlers++;
    add(...args);
  };
  external.signal.removeEventListener = (
    ...args: Parameters<AbortSignal['removeEventListener']>
  ) => {
    if (args[0] === 'abort') abortHandlers--;
    remove(...args);
  };
  const events = featureEvents(
    (fn, options) => emitter.on('feature', fn, options),
    undefined,
    lifetime.signal,
  );
  const off = events.on('click', () => {}, { signal: external.signal });
  assert.equal(emitter.hasListeners('feature'), true);
  lifetime.abort();
  assert.equal(emitter.hasListeners('feature'), false);
  assert.equal(abortHandlers, 0);
  off();
  external.abort();
  assert.equal(abortHandlers, 0, 'repeated unsubscribe performs no additional cleanup');
  assert.equal(emitter.hasListeners('feature'), false);
});

test('object API: binding an imported large source does not create per-feature objects or snapshot it', async () => {
  const { map } = await makeMap();
  const source = map.data.vector<PointGeometry>({ id: 'large' });
  const positions = new Float64Array(100_000 * 2);
  await source.importColumnar({ kind: 'point', positions });
  const get = source.features.get.bind(source.features);
  source.features.get = () => {
    throw new Error('unexpected per-feature read');
  };
  const points = map.addPoints(source);
  assert.equal(points.count(), 100_000);
  source.features.get = get;
  points.get('auto:1')!.setPosition([50, 14]);
  assert.equal(points.count(), 100_000);
  map.destroy();
});
