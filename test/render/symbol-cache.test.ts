import test from 'node:test';
import assert from 'node:assert/strict';
import { crs, style as expr } from '../../src/index.ts';
import { Scene } from '../../src/scene/scene.ts';
import { ViewImpl } from '../../src/view/view.ts';
import {
  buildFramePlan,
  invalidateFramePlanCache,
  type FramePlan,
} from '../../src/render/frame-plan.ts';
import { manualClock } from '../helpers/fixture.ts';

const options = { deviceWidth: 720, deviceHeight: 520, dpr: 1 };
function labels(plan: FramePlan) {
  const draw = plan.draws.find((draw) => draw.type === 'labels');
  assert.ok(draw?.type === 'labels');
  return draw;
}
function sprites(plan: FramePlan) {
  const draw = plan.draws.find((draw) => draw.type === 'sprites');
  assert.ok(draw?.type === 'sprites');
  return draw;
}
function fixture() {
  invalidateFramePlanCache();
  const clock = manualClock(),
    scene = new Scene(crs.simple(), clock);
  const view = new ViewImpl(
    scene.crs,
    scene,
    { width: 720, height: 520, minZoom: 0, maxZoom: 24, maxBounds: null },
    { x: 0, y: 0 },
    0,
    clock,
  );
  scene.attachView(view);
  const source = scene.createVectorSource('s');
  source.features.add([
    {
      id: 'a',
      geometry: { type: 'point', position: { x: 0, y: 0 } } as never,
      properties: { name: 'A', priority: 1 },
    },
    {
      id: 'b',
      geometry: { type: 'point', position: { x: 0.5, y: 0.5 } } as never,
      properties: { name: 'B', priority: 2 },
    },
  ]);
  const layer = scene.layers.add({
    id: 'labels',
    type: 'labels',
    source,
    style: { collision: true, priority: expr.field<'priority', number>('priority') },
  });
  return { scene, view, source, layer };
}
function spriteFixture(style: Record<string, unknown> = {}) {
  invalidateFramePlanCache();
  const clock = manualClock(),
    scene = new Scene(crs.simple(), clock);
  const view = new ViewImpl(
    scene.crs,
    scene,
    { width: 720, height: 520, minZoom: 0, maxZoom: 24, maxBounds: null },
    { x: 0, y: 0 },
    0,
    clock,
  );
  scene.attachView(view);
  const source = scene.createVectorSource('s');
  source.features.add([
    { id: 'a', geometry: { type: 'point', position: { x: 0, y: 0 } } as never, properties: {} },
    { id: 'b', geometry: { type: 'point', position: { x: 0.5, y: 0.5 } } as never, properties: {} },
  ]);
  scene.assets.addImage('pin', './pin.png').state = 'ready';
  const layer = scene.layers.add({
    id: 'icons',
    type: 'points',
    source,
    style: { icon: 'pin', ...style },
  });
  return { scene, view, source, layer };
}

test('symbol color/state-only patches keep placement identity and invalidate only their appearance', () => {
  const { scene, view, source, layer } = fixture();
  const first = labels(buildFramePlan(scene, options));
  layer.setOverride('a', { color: '#dd2266' });
  scene.publishStateChange(true);
  const color = labels(buildFramePlan(scene, options));
  assert.equal(color.labels, first.labels);
  assert.deepEqual(color.appearance, { version: 1, previousVersion: 0, indices: [1] });
  assert.equal(color.labels[1]!.color[0], 221 / 255);
  view.set({ center: { x: 0.02, y: 0 } });
  const pan = labels(buildFramePlan(scene, options));
  assert.equal(pan.labels, color.labels);
  assert.equal(pan.appearance, color.appearance);
  source.features.update('b', { properties: { unrelated: true } });
  const property = labels(buildFramePlan(scene, options));
  assert.equal(property.labels, pan.labels);
  assert.equal(property.appearance!.version, 2);
  scene.destroy();
});

test('text, priority, visibility and generation changes rerun symbol layout and match a fresh plan', () => {
  const { scene, source, layer } = fixture();
  let previous = labels(buildFramePlan(scene, options));
  const compare = () => {
    const current = labels(buildFramePlan(scene, options));
    assert.notEqual(current.labels, previous.labels);
    const snapshot = current.labels.slice();
    invalidateFramePlanCache();
    assert.deepEqual(labels(buildFramePlan(scene, options)).labels, snapshot);
    previous = labels(buildFramePlan(scene, options));
  };
  source.features.update('a', { properties: { name: 'changed' } });
  compare();
  source.features.update('a', { properties: { priority: 3 } });
  compare();
  layer.setOverride('a', { visible: false });
  scene.publishStateChange(true);
  compare();
  layer.clearOverride('a');
  scene.publishStateChange(true);
  compare();
  source.features.remove('a');
  source.features.add({
    id: 'a',
    geometry: { type: 'point', position: { x: 0, y: 0 } } as never,
    properties: { name: 'new' },
  });
  compare();
  assert.equal(previous.labels.find((label) => label.feature.id === 'a')!.feature.generation, 2);
  scene.destroy();
});

test('multi-line text stays one placement and is a layout change, not an appearance patch', () => {
  const { scene, source } = fixture();
  const first = labels(buildFramePlan(scene, options));
  source.features.update('a', { properties: { name: 'TOP\nBOTTOM' } });
  const multi = labels(buildFramePlan(scene, options));
  // Text changes rebuild the label layout; the newline is not split into placements.
  assert.notEqual(multi.labels, first.labels);
  const placements = multi.labels.filter((label) => label.feature.id === 'a');
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.text, 'TOP\nBOTTOM');
  const snapshot = multi.labels.slice();
  invalidateFramePlanCache();
  assert.deepEqual(labels(buildFramePlan(scene, options)).labels, snapshot);
  scene.destroy();
});

test('sprites default to an identity tint; layer and override tints resolve to RGBA values', () => {
  const plain = spriteFixture();
  const untinted = sprites(buildFramePlan(plain.scene, options));
  assert.deepEqual(untinted.sprites[0]!.tint, [1, 1, 1, 1]);
  plain.scene.destroy();

  const { scene, layer } = spriteFixture({ iconTint: '#3366ff' });
  const first = sprites(buildFramePlan(scene, options));
  assert.deepEqual(first.sprites[0]!.tint, [51 / 255, 102 / 255, 1, 1]);
  layer.setOverride('a', { iconTint: '#00ff00' });
  scene.publishStateChange(true);
  const override = sprites(buildFramePlan(scene, options));
  assert.deepEqual(override.sprites[0]!.tint, [0, 1, 0, 1]);
  assert.deepEqual(override.sprites[1]!.tint, [51 / 255, 102 / 255, 1, 1]);
  scene.destroy();
});

test('a tint-only override patches one sprite quad without a layout rebuild', () => {
  const { scene, layer } = spriteFixture({ iconTint: '#3366ff' });
  const first = sprites(buildFramePlan(scene, options));
  layer.setOverride('a', { iconTint: '#00ff00', opacity: 0.5 });
  scene.publishStateChange(true);
  const patched = sprites(buildFramePlan(scene, options));
  // Same placement array: tint is appearance, not layout (no atlas or full-mesh upload).
  assert.equal(patched.sprites, first.sprites);
  assert.deepEqual(patched.appearance, { version: 1, previousVersion: 0, indices: [0] });
  assert.equal(patched.sprites[0]!.opacity, 0.5);
  layer.clearOverride('a');
  scene.publishStateChange(true);
  const cleared = sprites(buildFramePlan(scene, options));
  assert.equal(cleared.sprites, first.sprites);
  assert.deepEqual(cleared.appearance, { version: 2, previousVersion: 1, indices: [0] });
  assert.deepEqual(cleared.sprites[0]!.tint, [51 / 255, 102 / 255, 1, 1]);
  scene.destroy();
});
