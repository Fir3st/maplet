import test from 'node:test';
import assert from 'node:assert/strict';
import { crs, expr } from '../../src/index.ts';
import { Scene } from '../../src/scene/scene.ts';
import { ViewImpl } from '../../src/view/view.ts';
import { buildFramePlan, invalidateFramePlanCache, FLAG_HIDDEN, type FramePlan, type PlanBatch } from '../../src/render/frame-plan.ts';
import { manualClock } from '../helpers/fixture.ts';

const options = { deviceWidth: 720, deviceHeight: 520, dpr: 1 };
function batches(plan: FramePlan): PlanBatch[] { return plan.draws.flatMap((draw) => draw.type === 'batch' ? [draw.batch] : []); }
function fixture() {
  const clock = manualClock(), scene = new Scene(crs.simple(), clock);
  const view = new ViewImpl(scene.crs, scene, { width: 720, height: 520, minZoom: 0, maxZoom: 24, maxBounds: null }, { x: 0, y: 0 }, 0, clock);
  scene.attachView(view);
  const source = scene.createVectorSource('mixed');
  source.features.add([
    { id: 'p', geometry: { type: 'point', position: { x: 0, y: 0 } } as never },
    { id: 'line', geometry: { type: 'lineString', positions: [{ x: -0.5, y: 0 }, { x: 0, y: 0.4 }, { x: 0.5, y: 0 }] } as never },
    { id: 'area', geometry: { type: 'polygon', rings: [[{ x: -0.4, y: -0.4 }, { x: 0.4, y: -0.4 }, { x: 0.4, y: 0.4 }, { x: -0.4, y: 0.4 }],
      [{ x: -0.1, y: -0.1 }, { x: 0.1, y: -0.1 }, { x: 0.1, y: 0.1 }, { x: -0.1, y: 0.1 }]] } as never },
  ]);
  const points = scene.layers.add({ id: 'points', type: 'points', source });
  const lines = scene.layers.add({ id: 'lines', type: 'lines', source, style: { color: expr.when(expr.state('selected'), '#ff0000', '#008800'), dash: [10, 5] } });
  const fills = scene.layers.add({ id: 'fills', type: 'fills', source });
  return { scene, view, source, points, lines, fills };
}

test('mixed points, lines, polygon fills and strokes pan without geometry repacking', () => {
  const { scene, view } = fixture();
  const first = buildFramePlan(scene, options);
  view.set({ center: view.screenToPosition({ x: 370, y: 265 }) });
  const moved = buildFramePlan(scene, options);
  const before = batches(first), after = batches(moved);
  assert.equal(before.length, 4);
  before.forEach((batch, i) => {
    assert.equal(after[i]!.data, batch.data);
    assert.equal(after[i]!.upload!.version, 0);
    assert.equal(after[i]!.offsetX, -10);
    assert.equal(after[i]!.offsetY, -5);
  });
  invalidateFramePlanCache();
  const fresh = batches(buildFramePlan(scene, options));
  after.forEach((batch, i) => {
    const step = batch.kind === 'fills' ? 12 : 16;
    for (let at = 0; at < batch.data.length; at += step) {
      const components = batch.kind === 'lines' ? 4 : 2;
      for (let j = 0; j < components; j++) assert.ok(Math.abs(batch.data[at + j]! + (j % 2 ? batch.offsetY! : batch.offsetX!) - fresh[i]!.data[at + j]!) < 0.0001);
    }
  });
});

test('selection, overrides and hide/show patch only resident feature ranges', () => {
  const { scene, source, lines, fills } = fixture();
  const first = batches(buildFramePlan(scene, options));
  scene.state.set(source.features.ref('line'), { selected: true });
  fills.setOverride(source.features.ref('area'), { fillColor: '#ff00ff' });
  scene.publishStateChange(true);
  const changed = batches(buildFramePlan(scene, options));
  first.forEach((batch, i) => assert.equal(changed[i]!.data, batch.data));
  assert.ok(changed[1]!.upload!.ranges.length > 0);
  assert.ok(changed[2]!.upload!.ranges.length > 0);
  lines.setOverride(source.features.ref('line'), { visible: false });
  scene.publishStateChange(true);
  const hidden = batches(buildFramePlan(scene, options))[1]!;
  assert.equal(hidden.data, first[1]!.data);
  assert.equal(hidden.data[7], FLAG_HIDDEN);
  lines.clearOverride(source.features.ref('line'));
  scene.publishStateChange(true);
  const shown = batches(buildFramePlan(scene, options))[1]!;
  assert.equal(shown.data, hidden.data);
  assert.equal(shown.data[7], 1);
  invalidateFramePlanCache();
  const fresh = batches(buildFramePlan(scene, options));
  assert.deepEqual(shown.data, fresh[1]!.data);
});

test('geometry size changes, generation recycling and z-order changes rebuild safely', () => {
  const { scene, source, points } = fixture();
  const first = buildFramePlan(scene, options);
  source.features.update('line', { geometry: { type: 'lineString', positions: [{ x: -0.5, y: 0 }, { x: 0.5, y: 0 }] } as never });
  const geometry = buildFramePlan(scene, options);
  assert.notEqual(batches(geometry)[1]!.data, batches(first)[1]!.data);
  const stale = source.features.ref('p');
  source.features.remove(stale);
  source.features.add({ id: 'p', geometry: { type: 'point', position: { x: 0.1, y: 0.1 } } as never });
  const recycled = buildFramePlan(scene, options);
  assert.ok(Array.from({ length: recycled.pickTable.length }, (_, i) => recycled.pickTable.get(i)!).filter((entry) => entry.feature.id === 'p').every((entry) => entry.feature.generation !== stale.generation));
  points.setOverride(source.features.ref('p'), { zIndex: 100 });
  scene.publishStateChange(true);
  const ordered = buildFramePlan(scene, options);
  assert.notEqual(batches(ordered)[0]!.data, batches(recycled)[0]!.data);
});
