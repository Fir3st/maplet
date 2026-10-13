import test from 'node:test';
import assert from 'node:assert/strict';
import { crs } from '../../src/index.ts';
import { Scene } from '../../src/scene/scene.ts';
import { ViewImpl } from '../../src/view/view.ts';
import { buildFramePlan, releaseFramePlan } from '../../src/render/frame-plan.ts';
import { manualClock } from '../helpers/fixture.ts';

test('frame-plan release clears point, vector and symbol residents inside hidden groups', () => {
  const clock = manualClock(), scene = new Scene(crs.simple(), clock);
  scene.attachView(new ViewImpl(scene.crs, scene, { width: 720, height: 520, minZoom: 0, maxZoom: 24, maxBounds: null }, { x: 0, y: 0 }, 0, clock));
  const group = scene.layers.addGroup({ id: 'group' }), points = scene.createVectorSource('points'), vectors = scene.createVectorSource('vectors');
  points.features.add({ id: 'point', geometry: { type: 'point', position: { x: 0, y: 0 } } as never, properties: { name: 'Point' } });
  vectors.features.add({ id: 'line', geometry: { type: 'lineString', positions: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } as never });
  scene.layers.add({ id: 'points', type: 'points', source: points, group: group.id });
  scene.layers.add({ id: 'lines', type: 'lines', source: vectors, group: group.id });
  scene.layers.add({ id: 'labels', type: 'labels', source: points, group: group.id });
  const options = { deviceWidth: 720, deviceHeight: 520, dpr: 1 }, first = buildFramePlan(scene, options);
  assert.equal(first.draws.length, 3);
  // Isolate destruction cleanup: publishing visibility would independently
  // invalidate caches and mask an omitted hidden-group release.
  group.visible = false;
  releaseFramePlan(scene);
  group.visible = true;
  const rebuilt = buildFramePlan(scene, options);
  for (let i = 0; i < first.draws.length; i++) {
    const before = first.draws[i]!, after = rebuilt.draws[i]!;
    if (before.type === 'batch' && after.type === 'batch') assert.notEqual(after.batch.data, before.batch.data);
    else if (before.type === 'labels' && after.type === 'labels') assert.notEqual(after.labels, before.labels);
    else assert.fail('resident draw kind changed');
  }
  scene.destroy();
});
