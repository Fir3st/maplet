import test from 'node:test';
import assert from 'node:assert/strict';
import { crs, expr } from '../../src/index.ts';
import { Scene } from '../../src/scene/scene.ts';
import { ViewImpl } from '../../src/view/view.ts';
import { buildFramePlan, invalidateFramePlanCache, FLAG_HIDDEN, type FramePlan, type PlanBatch } from '../../src/render/frame-plan.ts';
import { manualClock } from '../helpers/fixture.ts';

function fixture(count = 10) {
  const clock = manualClock();
  const scene = new Scene(crs.webMercator(), clock);
  const view = new ViewImpl(scene.crs, scene, { width: 720, height: 520, minZoom: 0, maxZoom: 24, maxBounds: null }, { lat: 50, lng: 14 }, 10, clock);
  scene.attachView(view);
  const source = scene.createVectorSource('s');
  source.features.add(Array.from({ length: count }, (_, id) => ({
    id, geometry: { type: 'point' as const, position: { lat: 50 + id % 100 * 0.0001, lng: 14 + Math.floor(id / 100) * 0.0001 } }, properties: { visible: true, z: 0 },
  })));
  const layer = scene.layers.add({ id: 'points', type: 'points', source, style: { radiusPx: 5, color: '#2563eb' }, filter: { field: 'visible', eq: true } });
  const plan = () => buildFramePlan(scene, { deviceWidth: 720, deviceHeight: 520, dpr: 1 });
  return { scene, view, source, layer, plan };
}

function batch(plan: FramePlan, layerId = 'points'): PlanBatch {
  const draw = plan.draws.find((draw) => draw.type === 'batch' && draw.batch.layerId === layerId);
  assert.ok(draw?.type === 'batch');
  return draw.batch;
}

function visibleRows(plan: FramePlan) {
  const rows: { id: string | number; generation: number; layer: string; values: number[] }[] = [];
  for (const draw of plan.draws) {
    if (draw.type !== 'batch' || draw.batch.kind !== 'points') continue;
    const b = draw.batch;
    for (let i = 0; i < b.count; i++) {
      const values = Array.from(b.data.subarray(i * 16, (i + 1) * 16));
      if (values[15]! >= FLAG_HIDDEN) continue;
      const ref = plan.pickTable.get(values[14]! + (b.pickBase ?? 0))!.feature;
      values[0] = Math.round((values[0]! + (b.offsetX ?? 0)) * 1000) / 1000;
      values[1] = Math.round((values[1]! + (b.offsetY ?? 0)) * 1000) / 1000;
      values[14] = 0; // Backend-local pick numbering is not public identity.
      rows.push({ id: ref.id, generation: ref.generation, layer: b.layerId, values });
    }
  }
  return rows;
}

test('retained points: pan and one-record edits never revisit the resident collection', () => {
  const f = fixture(50000);
  let evaluations = 0;
  f.layer.style = { color: { constant: false, evaluate: () => { evaluations++; return '#2563eb'; } }, radiusPx: 5 };
  const first = batch(f.plan());
  assert.equal(evaluations, 50000);
  const initialVersion = first.upload!.version;
  f.view.set({ center: f.view.screenToPosition({ x: 370, y: 265 }) });
  const panned = batch(f.plan());
  assert.equal(panned.data, first.data);
  assert.equal(panned.upload!.version, initialVersion);
  assert.equal(evaluations, 50000, 'pan does not evaluate styles');
  assert.ok(Math.abs(panned.offsetX! + 10) < 1e-8);
  f.source.features.update(7, { properties: { changed: true } });
  const edited = batch(f.plan());
  assert.equal(edited.data, first.data);
  assert.equal(evaluations, 50001, 'only the edited record evaluates its style');
  assert.deepEqual(edited.upload!.ranges, [{ start: 7 * 16, end: 8 * 16 }]);
  assert.equal(edited.upload!.previousVersion, initialVersion);
  f.scene.destroy();
});

test('retained points: local visibility, filter, move, state and selection match a fresh rebuild', () => {
  const f = fixture();
  f.layer.style = { color: expr.when(expr.state('selected'), '#ff0000', expr.when(expr.state('hovered'), '#00ff00', '#2563eb')) };
  f.plan();
  const ref = f.source.features.ref(3);
  const mutations = [
    () => { f.layer.setOverride(ref, { visible: false }); f.scene.publishStateChange(true); },
    () => { f.layer.clearOverride(ref); f.scene.publishStateChange(true); },
    () => f.source.features.update(2, { properties: { visible: false } }),
    () => f.source.features.update(2, { properties: { visible: true } }),
    () => f.source.features.update(3, { geometry: { type: 'point', position: { lat: 50.1, lng: 14.1 } } }),
    () => f.scene.state.set(ref, { hovered: true }),
    () => f.scene.selection.add([ref]),
    () => f.scene.selection.remove([ref]),
  ];
  for (const mutate of mutations) {
    mutate();
    const actual = visibleRows(f.plan());
    invalidateFramePlanCache();
    assert.deepEqual(actual, visibleRows(f.plan()));
  }
  f.scene.destroy();
});

test('retained points: large pan, zoom, ordering and generation changes rebuild safely', () => {
  const f = fixture();
  let previous = batch(f.plan()).data;
  f.view.set({ center: f.view.screenToPosition({ x: 410, y: 260 }) });
  assert.notEqual(batch(f.plan()).data, previous, 'leaving the resident margin refreshes candidates');
  previous = batch(f.plan()).data;
  f.view.set({ zoom: 11.25 });
  assert.notEqual(batch(f.plan()).data, previous, 'zoom-dependent styles are reevaluated');
  previous = batch(f.plan()).data;
  f.layer.setOverride(f.source.features.ref(0), { zIndex: 2 });
  f.scene.publishStateChange(true);
  assert.notEqual(batch(f.plan()).data, previous);
  assert.equal(visibleRows(f.plan()).at(-1)!.id, 0);
  const old = f.source.features.ref(1);
  f.source.features.remove(1);
  f.plan();
  f.source.features.add({ id: 1, geometry: { type: 'point', position: { lat: 50, lng: 14 } }, properties: { visible: true } });
  const row = visibleRows(f.plan()).find((row) => row.id === 1)!;
  assert.notEqual(row.generation, old.generation);
  f.scene.destroy();
});

test('retained points: layers/maps share neither cache ownership nor pick bases', () => {
  const a = fixture();
  const b = fixture();
  const first = batch(a.plan()).data;
  b.plan();
  assert.equal(batch(a.plan()).data, first);
  a.scene.layers.add({ id: 'above', type: 'points', source: a.source, style: { color: '#ff0000' } });
  const plan = a.plan();
  assert.equal(batch(plan, 'above').pickBase, 10);
  assert.equal(plan.pickTable.get(13)!.layerId, 'above');
  a.layer.visible = false;
  a.layer.touch();
  a.scene.publishStateChange();
  assert.equal(batch(a.plan(), 'above').pickBase, 0);
  a.scene.destroy(); b.scene.destroy();
});

test('retained points: coalesced edits and journal overflow do not lose changes', () => {
  const f = fixture();
  const first = batch(f.plan());
  f.scene.batch(() => {
    f.source.features.update(3, { properties: { visible: false } });
    f.source.features.update(4, { properties: { visible: false } });
    f.source.features.update(3, { properties: { visible: true } });
  });
  assert.deepEqual(batch(f.plan()).upload!.ranges, [{ start: 48, end: 80 }]);
  assert.equal(f.plan().stats.instances, 9);
  for (let i = 0; i < 4100; i++) f.source.features.update(0, { properties: { n: i } });
  assert.notEqual(batch(f.plan()).data, first.data, 'overflow forces a rebuild');
  assert.equal(f.source.features.get(0)!.properties.n, 4099);
  f.scene.destroy();
});

test('retained points: failed geometry changes and slot reuse keep the accepted output', () => {
  const f = fixture();
  const accepted = visibleRows(f.plan());
  assert.throws(() => f.scene.batch(() => {
    f.source.features.remove(4);
    f.source.features.update(3, { geometry: { type: 'point', position: { lat: Number.NaN, lng: 0 } } });
  }));
  assert.deepEqual(visibleRows(f.plan()), accepted);
  f.source.features.add({ id: 'new', geometry: { type: 'point', position: { lat: 50, lng: 14 } }, properties: { visible: true } });
  assert.equal(f.source.features.count(), 11);
  assert.ok(f.source.features.has(4), 'rollback restored slot must not be allocated again');
  assert.equal(visibleRows(f.plan()).length, 11);
  f.scene.destroy();
});

test('retained points: different identities reusing a slot do not alias equal generations', async () => {
  const f = fixture();
  f.plan();
  const old = f.source.features.ref(4);
  f.source.features.remove(4);
  f.source.features.add({ id: 'other', geometry: { type: 'point', position: { lat: 50, lng: 14 } }, properties: { visible: true } });
  assert.equal(f.source.features.ref('other').generation, old.generation, 'generations alone are not identity');
  assert.ok(visibleRows(f.plan()).some((row) => row.id === 'other'));
  assert.ok(!visibleRows(f.plan()).some((row) => row.id === 4));
  await f.source.importColumnar({ kind: 'point', positions: Float64Array.of(14, 50, 14.01, 50.01), ids: [7, 'seven'], properties: [{ visible: true }, { visible: true }] });
  assert.deepEqual(visibleRows(f.plan()).map((row) => row.id).sort(), [7, 'seven']);
  f.scene.destroy();
});
