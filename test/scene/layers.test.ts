import test from 'node:test';
import assert from 'node:assert/strict';

import { style as expr, isMapletError, type FeatureRef } from '../../src/index.ts';
import { LayerImpl, featureIsDraggable } from '../../src/scene/layers.ts';
import { makeMap } from '../helpers/fixture.ts';

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    geometry: { type: 'point' as const, position: { lat: 50 + i * 0.001, lng: 14 + i * 0.001 } },
    properties: { status: i % 2 === 0 ? 'online' : 'offline', pop: i * 10 },
  }));

test('LAYER-02: layer registry add/get/list/update/remove keeps shared data', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 'stations' });
  source.features.add(items(3));
  const layer = map.addLayer({
    id: 'points',
    type: 'points',
    source,
    style: { radiusPx: 4, color: '#ff0000' },
  });
  assert.equal(layer.kind, 'points');
  assert.equal(layer.sourceId, 'stations');
  assert.equal(map.layers.get('points')?.id, 'points');
  assert.equal(map.layers.list().length, 1);
  layer.update({ style: { radiusPx: 8 } });
  map.layers.remove('points');
  assert.equal(map.layers.list().length, 0);
  assert.equal(source.features.count(), 3, 'removing a layer never removes source data');
  map.destroy();
});

test('LAYER-03/04: order and visibility control what a frame draws', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(2));
  map.addLayer({ id: 'below', type: 'points', source });
  map.addLayer({ id: 'above', type: 'points', source });
  assert.deepEqual([...map.debug.layerOrder()], ['below', 'above']);
  map.layers.move('below', { after: 'above' });
  assert.deepEqual([...map.debug.layerOrder()], ['above', 'below']);
  const layer = map.layers.get('above')!;
  layer.setVisible(false);
  assert.equal(layer.isVisible(), false);
  assert.equal(map.debug.layerInstances('above'), 0);
  assert.equal(map.debug.layerInstances('below'), 2, 'the other layer still draws');
  assert.equal(source.features.count(), 2, 'hidden layers keep the data available');
  layer.setVisible(true);
  assert.equal(map.debug.layerInstances('above'), 2);
  map.destroy();
});

test('LAYER-05: a runtime filter updates membership without deleting data', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(4));
  map.addLayer({
    id: 'filtered',
    type: 'points',
    source,
    filter: { field: 'status', eq: 'online' },
  });
  assert.equal(map.debug.countLayerRecords('filtered'), 2);
  assert.equal(map.debug.layerInstances('filtered'), 2);
  source.features.update(1, { properties: { status: 'online' } });
  assert.equal(map.debug.countLayerRecords('filtered'), 3, 'membership follows data changes');
  source.features.update(1, { properties: { status: 'offline' } });
  assert.equal(map.debug.countLayerRecords('filtered'), 2);
  assert.equal(source.features.count(), 4, 'filtered-out data is not deleted');
  map.destroy();
});

test('LAYER-06: per-layer overrides do not leak into other layers or the source', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(1));
  const a = map.addLayer({ id: 'a', type: 'points', source, style: { color: '#ff0000' } });
  map.addLayer({ id: 'b', type: 'points', source, style: { color: '#ff0000' } });
  const ref = source.features.ref(0);
  a.setFeatureStyle(ref, { color: '#00ff00', opacity: 0.5 });
  assert.equal(a.hasFeatureStyle(ref), true);
  assert.equal(map.debug.layerColor('a'), '#00ff00');
  assert.equal(map.debug.layerColor('b'), '#ff0000');
  assert.deepEqual(source.features.get(0)?.properties, { status: 'online', pop: 0 });
  a.clearFeatureStyle(ref);
  assert.equal(map.debug.layerColor('a'), '#ff0000');
  map.destroy();
});

test('INPUT-10: a feature is draggable through the layer flag or its own override', () => {
  const layer = new LayerImpl({ id: 'points', type: 'points', source: 'stations' });
  const ref = { sceneId: 'scene', sourceId: 'stations', id: 'p1', generation: 1 } as FeatureRef;
  assert.equal(featureIsDraggable(layer, ref), false, 'nothing is draggable by default');
  layer.setOverride(ref, { draggable: true });
  assert.equal(featureIsDraggable(layer, ref), true);
  layer.setOverride(ref, { color: '#00ff00' });
  assert.equal(featureIsDraggable(layer, ref), false, 'a rebuilt override drops dragging with it');
  layer.setOverride(ref, { draggable: false });
  assert.equal(featureIsDraggable(layer, ref), false);
  layer.draggable = true;
  assert.equal(
    featureIsDraggable(layer, ref),
    false,
    'a feature override opts out of a draggable layer',
  );
  layer.clearOverride(ref);
  assert.equal(
    featureIsDraggable(layer, ref),
    true,
    'without an override the layer flag covers every feature',
  );
});

test('LAYER-07/08/09: logical layers toggle descendants, reject cycles and release membership', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(2));
  const inner = map.addLayer({ id: 'inner' });
  const outer = inner.addLayer({ id: 'outer' });
  inner.addLayer({ id: 'l1', type: 'points', source });
  outer.addLayer({ id: 'l2', type: 'points', source });
  inner.setVisible(false);
  assert.equal(map.layers.get('l1')!.isVisible(), false);
  assert.equal(map.layers.get('l2')!.isVisible(), false);
  inner.setVisible(true);
  outer.setVisible(false);
  assert.equal(map.layers.get('l1')!.isVisible(), true, 'individual settings are retained');
  assert.equal(map.layers.get('l2')!.isVisible(), false);
  try {
    inner.move({ into: 'outer' });
    assert.fail('expected a cycle rejection');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-argument');
  }
  assert.equal(map.layers.get('l1')?.id, 'l1', 'rejected move changed nothing');
  assert.equal(map.layers.get('l2')?.id, 'l2');
  // Move a collection to the root; removing its old parent must not delete it.
  map.layers.move('l2', { into: null, index: 0 });
  outer.remove();
  assert.equal(map.layers.get('l2')?.id, 'l2');
  assert.equal(map.layers.get('l1')?.id, 'l1');
  map.destroy();
});

test('LAYER-10: unknown sources and incompatible layer types are rejected before registration', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 'vector-source' });
  map.data.rasterTiles({ id: 'raster-source', url: '/tiles/{z}/{x}/{y}.png' });
  for (const spec of [
    { id: 'bad', type: 'points' as const, source: 'missing' as const },
    { id: 'bad2', type: 'points' as const, source: 'raster-source' },
    { id: 'bad3', type: 'raster' as const, source: 'vector-source' },
  ]) {
    try {
      map.addLayer(spec);
      assert.fail(`expected rejection for ${spec.id}`);
    } catch (error) {
      assert.ok(isMapletError(error));
      assert.ok(error.code === 'not-found' || error.code === 'invalid-argument');
    }
  }
  assert.equal(map.layers.list().length, 0);
  assert.ok(source);
  map.destroy();
});

test('STYLE-01/02/04: expressions evaluate fields, matches, arithmetic and fallbacks', () => {
  const context = {
    properties: { status: 'online', pop: 1500, name: 'A' },
    state: { hovered: false, selected: false, disabled: false },
    zoom: 6.5,
  };
  const status = expr.field<'status', string>('status');
  const color = expr.match(status, { online: '#16a34a', offline: '#dc2626' }, '#999999');
  assert.equal(color.evaluate(context), '#16a34a');
  assert.equal(
    expr
      .match(expr.field<'status', string>('status'), { online: 1 }, 0)
      .evaluate({ ...context, properties: { status: 'other' } }),
    0,
    'a missing case falls back without NaN',
  );
  assert.equal(expr.gt(expr.field<'pop', number>('pop'), 1000).evaluate(context), true);
  assert.equal(
    expr.when(expr.gt(expr.field<'pop', number>('pop'), 1000), 'big', 'small').evaluate(context),
    'big',
  );
  assert.equal(expr.add(expr.field<'pop', number>('pop'), 100).evaluate(context), 1600);
  const width = expr.interpolate(expr.zoom(), [
    [4, 2],
    [8, 10],
  ] as const);
  assert.equal(width.evaluate({ ...context, zoom: 4 }), 2);
  assert.equal(width.evaluate({ ...context, zoom: 8 }), 10);
  assert.equal(width.evaluate({ ...context, zoom: 6 }), 6, 'midpoint is not rounded');
  assert.equal(width.evaluate({ ...context, zoom: 5 }), 4);
  assert.equal(width.evaluate({ ...context, zoom: 3 }), 2, 'below the first stop clamps');
});

test('STYLE-05/06: override and state order; state changes never touch properties', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(1));
  const layer = map.addLayer({
    id: 'layer',
    type: 'points',
    source,
    style: {
      color: expr.match(expr.field<'status', string>('status'), { online: '#00ff00' }, '#ff0000'),
    },
  });
  const ref = source.features.ref(0);
  assert.equal(map.debug.layerColor('layer'), '#00ff00');
  layer.setFeatureStyle(ref, { color: '#0000ff' });
  assert.equal(map.debug.layerColor('layer'), '#0000ff', 'override beats the expression');
  const before = JSON.stringify(source.features.get(0)?.properties);
  map.state.set(ref, { selected: true });
  assert.equal(map.state.get(ref).selected, true);
  assert.equal(JSON.stringify(source.features.get(0)?.properties), before);
  layer.clearFeatureStyle(ref);
  assert.equal(map.debug.layerColor('layer'), '#00ff00');
  map.destroy();
});

test('STYLE-05: interaction style reacts to state.hovered above the base expression', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(1));
  map.addLayer({
    id: 'layer',
    type: 'points',
    source,
    style: {
      color: expr.when(expr.state('hovered'), '#ff0000', '#00ff00'),
      radiusPx: expr.when(expr.state('hovered'), 10, 4),
    },
  });
  const ref = source.features.ref(0);
  assert.equal(map.debug.layerColor('layer'), '#00ff00');
  map.state.set(ref, { hovered: true });
  assert.equal(
    map.debug.layerColor('layer'),
    '#ff0000',
    'hover state re-evaluates the interaction style',
  );
  map.state.set(ref, { hovered: false });
  assert.equal(
    map.debug.layerColor('layer'),
    '#00ff00',
    'clearing the state restores the base value',
  );
  map.destroy();
});

test('STYLE-11: a hidden override leaves the plan and picking without data loss', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(2));
  const layer = map.addLayer({ id: 'layer', type: 'points', source });
  assert.equal(map.debug.layerInstances('layer'), 2);
  layer.setFeatureStyle(source.features.ref(0), { visible: false });
  assert.equal(map.debug.layerInstances('layer'), 1, 'a hidden override is excluded from the plan');
  assert.deepEqual([...map.debug.layerPickOrder('layer')], [1], 'and from picking');
  assert.equal(source.features.count(), 2, 'the data is untouched');
  layer.clearFeatureStyle(source.features.ref(0));
  assert.equal(map.debug.layerInstances('layer'), 2);
  map.destroy();
});

test('TEXT-01/07: label plan follows text, identity, zoom range and priority order', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add([
    {
      id: 'a',
      geometry: { type: 'point', position: { lat: 50, lng: 14 } },
      properties: { name: 'Praha', rank: 1 },
    },
    {
      id: 'b',
      geometry: { type: 'point', position: { lat: 50.001, lng: 14 } },
      properties: { rank: 2 },
    },
    {
      id: 'c',
      geometry: { type: 'point', position: { lat: 50.002, lng: 14 } },
      properties: { name: '   ', rank: 3 },
    },
  ]);
  const labels = map.addLayer({
    id: 'lbl',
    type: 'labels',
    source,
    style: {
      text: expr.field('name'),
      offsetPx: { x: 4, y: -10 },
      collision: true,
      priority: expr.field('rank'),
    },
  });
  const before = map.debug.layerLabels('lbl');
  assert.equal(before.length, 1, 'features without usable text produce no label');
  assert.equal(before[0]!.text, 'Praha');
  assert.deepEqual([before[0]!.offsetX, before[0]!.offsetY], [4, -10]);

  // TEXT-01: a label reads the same source as its point and keeps the identity.
  source.features.update('b', { properties: { name: 'Brno', rank: 2 } });
  assert.deepEqual(
    map.debug.layerLabels('lbl').map((entry) => entry.text),
    ['Brno', 'Praha'],
    'with collision, higher priority plans first (deterministic suppression input)',
  );

  // The anchor tracks the feature position.
  source.features.update('a', { geometry: { type: 'point', position: { lat: 50.05, lng: 14.0 } } });
  const praha = map.debug.layerLabels('lbl').find((entry) => entry.text === 'Praha');
  const screen = map.positionToScreen({ lat: 50.05, lng: 14.0 });
  assert.ok(praha, 'the moved feature still has its label');
  assert.ok(Math.abs(praha.sx - screen.x) < 1e-9 && Math.abs(praha.sy - screen.y) < 1e-9);

  // Zoom visibility uses the same closed range as other layers.
  labels.update({ style: { text: expr.field('name'), minZoom: 9 } });
  assert.equal(map.debug.layerLabels('lbl').length, 0, 'below minZoom nothing plans');
  map.setView({ zoom: 9 });
  assert.equal(map.debug.layerLabels('lbl').length, 2, 'inside the range both labels plan');
  map.destroy();
});

test('MEDIA-08: an unavailable icon asset falls back to the shape, never a silent symbol', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(2));
  const asset = map.assets.addImage({
    id: 'pin',
    src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  });
  assert.equal(
    asset.snapshot().state,
    'error',
    'headless environments surface an explicit error state',
  );
  assert.ok(asset.snapshot().error, 'the reason is visible');
  map.addLayer({ id: 'pts', type: 'points', source, style: { icon: 'pin', radiusPx: 6 } });
  assert.equal(
    map.debug.layerSprites('pts').length,
    0,
    'no sprite is planned without a decoded asset',
  );
  assert.equal(
    map.debug.layerInstances('pts'),
    2,
    'the declared shape fallback carries the features',
  );
  map.assets.remove('pin');
  assert.equal(map.debug.layerInstances('pts'), 2, 'removing the asset keeps the fallback stable');
  map.destroy();
});

test('STYLE-07/08: instance order is stable by zIndex and slot', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add([
    { id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14 } }, properties: {} },
    { id: 'b', geometry: { type: 'point', position: { lat: 50.1, lng: 14.1 } }, properties: {} },
    { id: 'c', geometry: { type: 'point', position: { lat: 50.2, lng: 14.2 } }, properties: {} },
  ]);
  const layer = map.addLayer({ id: 'layer', type: 'points', source });
  layer.setFeatureStyle(source.features.ref('c'), { zIndex: 5 });
  layer.setFeatureStyle(source.features.ref('b'), { zIndex: 5 });
  assert.deepEqual(
    [...map.debug.layerPickOrder('layer')],
    ['a', 'b', 'c'],
    'stable slot tie-break',
  );
  map.destroy();
});

test('STYLE-09: zoom visibility uses the closed boundary in the plan', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(2));
  map.addLayer({ id: 'layer', type: 'points', source, style: { minZoom: 6, maxZoom: 8 } });
  map.setView({ zoom: 6 });
  assert.equal(map.debug.layerInstances('layer'), 2, 'exactly at minZoom is visible');
  map.setView({ zoom: 5.999 });
  assert.equal(map.debug.layerInstances('layer'), 0);
  map.setView({ zoom: 8 });
  assert.equal(map.debug.layerInstances('layer'), 2, 'exactly at maxZoom is visible');
  map.setView({ zoom: 8.001 });
  assert.equal(map.debug.layerInstances('layer'), 0);
  map.destroy();
});

test('SELECT-01/02/03/04/06: selection identity and lifecycle', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(3));
  const refA = source.features.ref(0);
  const refB = source.features.ref(1);
  map.selection.set([refA, refA, { ...refA }]);
  assert.equal(map.selection.get().length, 1, 'value-identity deduplication');
  map.selection.add([refB]);
  assert.equal(map.selection.get().length, 2);
  map.selection.remove([refB]);
  assert.equal(map.selection.get().length, 1);
  const stale = { ...refA, generation: refA.generation + 10 };
  try {
    map.selection.add([stale]);
    assert.fail('expected stale-reference');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'stale-reference');
  }
  assert.equal(map.selection.get().length, 1);
  source.features.remove(0);
  assert.equal(map.selection.get().length, 0, 'selection drops with the removed feature');
  source.features.add({ id: 0, geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
  assert.equal(map.selection.get().length, 0, 'a recreated id is never auto-selected');
  const ref0 = source.features.ref(0);
  const ref2 = source.features.ref(2);
  map.relations.add({ id: 'r', type: 'near', from: ref0, to: ref2 });
  map.selection.set([ref0]);
  assert.equal(map.selection.get().length, 1, 'relations are not implicit selection rules');
  map.destroy();
});

test('EVENT-03/06: source events carry revisions and only touch the origin source', async () => {
  const { map } = await makeMap();
  const a = map.data.vector({ id: 'a' });
  const b = map.data.vector({ id: 'b' });
  const seenA: number[] = [];
  const seenB: number[] = [];
  a.subscribe((event) => {
    if (!event.initial) seenA.push(event.revision);
  });
  b.subscribe((event) => {
    if (!event.initial) seenB.push(event.revision);
  });
  a.features.add({ id: 1, geometry: { type: 'point', position: { lat: 1, lng: 1 } } });
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 0);
  let initial: { initial: boolean; count: number } | null = null;
  a.subscribe((event) => {
    initial = { initial: event.initial, count: event.count };
  });
  assert.deepEqual(initial, { initial: true, count: 1 });
  map.destroy();
});

test('QUERY-01/02/03/04/06/07/08: data queries, pagination, filters and identity', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 'roads' });
  const hidden = map.data.vector({ id: 'zones' });
  source.features.add([
    {
      id: 'line',
      geometry: {
        type: 'lineString',
        positions: [
          { lat: 0, lng: -100 },
          { lat: 0, lng: 100 },
        ],
      },
      properties: { kind: 'road' },
    },
    {
      id: 'around',
      geometry: {
        type: 'polygon',
        rings: [
          [
            { lat: -10, lng: -10 },
            { lat: 10, lng: -10 },
            { lat: 10, lng: 10 },
            { lat: -10, lng: 10 },
          ],
        ],
      },
      properties: { kind: 'zone' },
    },
  ]);
  hidden.features.add({
    id: 'hidden-point',
    geometry: { type: 'point', position: { lat: 0, lng: 0 } },
    properties: {},
  });
  const queryBounds = { southwest: { lat: -1, lng: -1 }, northeast: { lat: 1, lng: 1 } };
  assert.equal(
    map.query.area(queryBounds).items.length,
    3,
    'data queries see stored features of every source',
  );
  const onlyRoads = map.query.area(queryBounds, { sources: ['roads'] });
  assert.equal(onlyRoads.items.length, 2, 'source filter never mixes foreign sources');
  assert.ok(
    onlyRoads.items.some((item) => item.ref.id === 'line'),
    'line intersecting with endpoints outside is found',
  );
  assert.ok(
    onlyRoads.items.some((item) => item.ref.id === 'around'),
    'surrounding polygon is found',
  );
  map.addLayer({ id: 'zones-layer', type: 'fills', source: hidden, visible: false });
  assert.equal(
    map.query.area(queryBounds, { sources: ['zones'] }).items.length,
    1,
    'hidden layers keep data queryable',
  );

  const many = map.data.vector({ id: 'many' });
  const points = Array.from({ length: 23 }, (_, i) => ({
    id: i,
    geometry: { type: 'point' as const, position: { lat: i * 1e-4, lng: i * 1e-4 } },
    properties: {},
  }));
  await many.features.replace(points);
  const pageBounds = { southwest: { lat: -1, lng: -1 }, northeast: { lat: 1, lng: 1 } };
  const seen = new Set<number>();
  let cursor: { offset: number; revision: number } | undefined;
  let pages = 0;
  for (;;) {
    const result = map.query.area(pageBounds, {
      sources: ['many'],
      limit: 5,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of result.items) seen.add(item.ref.id as number);
    pages++;
    if (!result.next) break;
    cursor = result.next;
  }
  assert.equal(seen.size, 23);
  assert.equal(pages, 5, '5 + 5 + 5 + 5 + 3');
  const first = map.query.area(pageBounds, { sources: ['many'], limit: 5 });
  assert.ok(first.next);
  many.features.update(22, { properties: { changed: true } });
  try {
    map.query.area(pageBounds, { sources: ['many'], limit: 5, cursor: first.next });
    assert.fail('expected invalid-state');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-state');
  }
  const start = performance.now();
  assert.ok(many.features.get(22));
  assert.ok(performance.now() - start < 20, 'id lookup stays direct');
  map.destroy();
});

test('STYLE-10: a static scene reuses one plan without re-evaluating per frame', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add(items(100));
  map.addLayer({ id: 'layer', type: 'points', source });
  const before = map.debug.planBuildCount();
  map.debug.layerInstances('layer');
  const first = map.debug.planBuildCount();
  map.debug.layerInstances('layer');
  assert.equal(
    map.debug.planBuildCount(),
    first,
    'the cached plan is reused while the revision is unchanged',
  );
  assert.ok(first >= before);
  source.features.update(1, { properties: { status: 'online' } });
  map.debug.layerInstances('layer');
  assert.ok(map.debug.planBuildCount() > first, 'a commit rebuilds the plan exactly once');
  map.destroy();
});

test('RENDER-PREP: points/lines/fills plans carry the expected primitive counts', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 's' });
  source.features.add([
    { id: 'p', geometry: { type: 'point', position: { lat: 50, lng: 14 } }, properties: {} },
    {
      id: 'l',
      geometry: {
        type: 'lineString',
        positions: [
          { lat: 50, lng: 14 },
          { lat: 50.1, lng: 14.1 },
          { lat: 50.2, lng: 14.05 },
        ],
      },
      properties: {},
    },
    {
      id: 'f',
      geometry: {
        type: 'polygon',
        rings: [
          [
            { lat: 50, lng: 14 },
            { lat: 50.02, lng: 14 },
            { lat: 50.02, lng: 14.03 },
            { lat: 50, lng: 14.03 },
          ],
        ],
      },
      properties: {},
    },
  ]);
  map.addLayer({ id: 'pts', type: 'points', source, filter: { id: 'p' } });
  map.addLayer({ id: 'lns', type: 'lines', source, filter: { id: 'l' } });
  map.addLayer({ id: 'fls', type: 'fills', source, filter: { id: 'f' } });
  assert.equal(map.debug.layerInstances('pts'), 1);
  assert.equal(map.debug.layerInstances('lns'), 2, 'two segments for a three-point line');
  assert.ok(map.debug.layerInstances('fls') >= 5, 'polygon fill triangles plus outline segments');
  map.destroy();
});
