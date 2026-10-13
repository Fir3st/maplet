import test from 'node:test';
import assert from 'node:assert/strict';
import { crs, expr } from '../../src/index.ts';
import { Scene } from '../../src/scene/scene.ts';
import { ViewImpl } from '../../src/view/view.ts';
import { buildFramePlan, invalidateFramePlanCache, type FramePlan } from '../../src/render/frame-plan.ts';
import { manualClock } from '../helpers/fixture.ts';

const options = { deviceWidth: 720, deviceHeight: 520, dpr: 1 };
function labels(plan: FramePlan) {
  const draw = plan.draws.find(draw => draw.type === 'labels');
  assert.ok(draw?.type === 'labels');
  return draw;
}
function fixture() {
  invalidateFramePlanCache();
  const clock = manualClock(), scene = new Scene(crs.simple(), clock);
  const view = new ViewImpl(scene.crs, scene, { width: 720, height: 520, minZoom: 0, maxZoom: 24, maxBounds: null }, { x: 0, y: 0 }, 0, clock);
  scene.attachView(view);
  const source = scene.createVectorSource('s');
  source.features.add([
    { id: 'a', geometry: { type: 'point', position: { x: 0, y: 0 } } as never, properties: { name: 'A', priority: 1 } },
    { id: 'b', geometry: { type: 'point', position: { x: 0.5, y: 0.5 } } as never, properties: { name: 'B', priority: 2 } },
  ]);
  const layer = scene.layers.add({ id: 'labels', type: 'labels', source, style: { collision: true, priority: expr.field<'priority', number>('priority') } });
  return { scene, view, source, layer };
}

test('symbol color/state-only patches keep placement identity and invalidate only their appearance', () => {
  const { scene, view, source, layer } = fixture();
  const first = labels(buildFramePlan(scene, options));
  layer.setOverride('a', { color: '#dd2266' }); scene.publishStateChange(true);
  const color = labels(buildFramePlan(scene, options));
  assert.equal(color.labels, first.labels);
  assert.deepEqual(color.appearance, { version: 1, previousVersion: 0, indices: [1] });
  assert.equal(color.labels[1]!.color[0], 221 / 255);
  view.set({ center: { x: 0.02, y: 0 } } as never);
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
  source.features.update('a', { properties: { name: 'changed' } }); compare();
  source.features.update('a', { properties: { priority: 3 } }); compare();
  layer.setOverride('a', { visible: false }); scene.publishStateChange(true); compare();
  layer.clearOverride('a'); scene.publishStateChange(true); compare();
  source.features.remove('a');
  source.features.add({ id: 'a', geometry: { type: 'point', position: { x: 0, y: 0 } } as never, properties: { name: 'new' } });
  compare();
  assert.equal(previous.labels.find(label => label.feature.id === 'a')!.feature.generation, 2);
  scene.destroy();
});
