/**
 * e2e scenarios for `runner.mjs`.
 *
 * `batteries`: the self-reporting in-page checks (`window.__xCheckResult`),
 * collected exactly as in a manual browser session.
 *
 * `scenarios`: driver tests against `e2e/scene.html`. The runner sends real CDP
 * input (mouse, wheel, keyboard) and asserts on the public API plus the real
 * rendered pixels — the same path a user takes.
 */
import { compareUpdates } from './compare-updates.mjs';
import { retainedPoints } from './retained-points.mjs';
import { complexScene } from './complex-scene.mjs';
import { retainedScene } from './retained-scene.mjs';
import { denseGeometry } from './dense-geometry.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const batteries = [
  { name: 'comparison:maplet', page: 'compare.html', hook: '__compareCheckResult', query: 'engine=maplet', manual: true },
  { name: 'comparison:leaflet-canvas', page: 'compare.html', hook: '__compareCheckResult', query: 'engine=leaflet-canvas', manual: true },
  { name: 'comparison:leaflet-dom', page: 'compare.html', hook: '__compareCheckResult', query: 'engine=leaflet-dom', manual: true },
  { name: 'battery:interaction', page: 'interaction.html', hook: '__interactionCheckResult' },
  { name: 'battery:pick', page: 'pick.html', hook: '__pickCheckResult' },
  { name: 'battery:tiles-svg', page: 'tiles.html', hook: '__tileCheckResult', query: 'mode=svg' },
  { name: 'battery:wms', page: 'wms.html', hook: '__wmsCheckResult' },
  { name: 'battery:labels', page: 'labels.html', hook: '__labelCheckResult' },
  { name: 'battery:icons', page: 'icons.html', hook: '__iconCheckResult' },
  { name: 'battery:mvt', page: 'mvt.html', hook: '__mvtCheckResult' },
  { name: 'battery:parity', page: 'parity.html', hook: '__parityCheckResult' },
  { name: 'battery:loss', page: 'loss.html', hook: '__lossCheckResult' },
  { name: 'battery:ui', page: 'ui.html', hook: '__uiCheckResult' },
  { name: 'battery:detail', page: 'detail.html', hook: '__detailCheckResult' },
  { name: 'battery:fonts', page: 'fonts.html', hook: '__fontCheckResult' },
  { name: 'battery:media', page: 'media.html', hook: '__mediaCheckResult' },
  { name: 'battery:import', page: 'import.html', hook: '__importCheckResult' },
  { name: 'battery:csp', page: 'csp.html', hook: '__cspCheckResult', query: 'csp=worker-none' },
  { name: 'battery:soak', page: 'soak.html', hook: '__soakCheckResult' },
  { name: 'battery:scale', page: 'scale.html', hook: '__scaleCheckResult' },
];

/* --------------------------------- helpers -------------------------------- */

const METERS_PER_DEG_LAT = 110574;
const metersBetween = (a, b) => {
  const dy = (a.lat - b.lat) * METERS_PER_DEG_LAT;
  const dx = (a.lng - b.lng) * METERS_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
};
const near = (pixel, [r, g, b], tolerance = 40) =>
  Math.abs(pixel.r - r) <= tolerance && Math.abs(pixel.g - g) <= tolerance && Math.abs(pixel.b - b) <= tolerance;
const midpoint = (a, b) => ({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
const describe = (pixel) => `rgba(${pixel.r},${pixel.g},${pixel.b},${pixel.a})`;

const positionOf = (session, source, id) =>
  session.evaluate(`window.__e2e.positionOf(window.__e2e.${source}, '${id}')`);
const screenOf = (session, source, id) =>
  session.evaluate(`window.__e2e.screenOf(window.__e2e.positionOf(window.__e2e.${source}, '${id}'))`);
const pointTarget = (session, position) =>
  session.evaluate(`window.__e2e.points.features.update('p1', { geometry: { type: 'point', position: ${JSON.stringify(position)} } }).revision`);
const pixelAt = (session, position) => session.evaluate(`window.__e2e.pixel(${JSON.stringify(position)})`);
const awaitRendered = (session, revision) => session.evaluate(`window.__e2e.rendered(${revision})`);

/** Finds a background pixel so pan/zoom gestures start on empty canvas. */
async function emptyScreen(session, from) {
  return session.evaluate(`(async () => {
    const e = window.__e2e;
    const candidates = ${JSON.stringify(from)};
    for (const [x, y] of candidates) {
      const pixel = await e.samplePixel(x, y);
      if (pixel.a > 200 && pixel.r > 240 && pixel.g > 240 && pixel.b > 240) return { x, y };
    }
    return null;
  })()`);
}

/* -------------------------------- scenarios ------------------------------- */

export const scenarios = [
  { name: 'dense-geometry-performance', page: 'e2e/scene.html', manual: true, run: denseGeometry },
  { name: 'retained-mixed-scene', page: 'e2e/scene.html', run: retainedScene },
  { name: 'complex-scene-performance', page: 'e2e/scene.html', manual: true, run: complexScene },
  { name: 'retained-point-buffers', page: 'e2e/scene.html', run: retainedPoints },
  { name: 'comparison-updates:maplet', page: 'compare.html', query: 'engine=maplet',
    ready: '!!window.__comparison', manual: true, run: compareUpdates },
  { name: 'comparison-updates:leaflet-canvas', page: 'compare.html', query: 'engine=leaflet-canvas',
    ready: '!!window.__comparison', manual: true, run: compareUpdates },
  {
    name: 'scene-renders',
    page: 'e2e/scene.html',
    run: async ({ session, expect, options }) => {
      const backend = await session.evaluate('window.__e2e.map.capabilities().backend');
      if (options.webgpu) expect.equal(backend, 'webgpu', 'runner --webgpu uses the WebGPU backend');
      const probe = await session.evaluate(`(async () => {
        const e = window.__e2e;
        const plate = e.shapes.features.get('plate').geometry;
        const plateCenter = {
          lat: (plate.southwest.lat + plate.northeast.lat) / 2,
          lng: (plate.southwest.lng + plate.northeast.lng) / 2,
        };
        return {
          p1: await e.pixel(e.positionOf(e.points, 'p1')),
          t1: await e.pixel(e.positionOf(e.targets, 't1')),
          plate: await e.pixel(plateCenter),
          route: await e.pixel({ lat: 49.94, lng: 14.05 }),
          empty: await e.pixel({ lat: 49.97, lng: 14.115 }),
        };
      })()`);
      expect.ok(near(probe.p1, [37, 99, 235]), `p1 pixel ${describe(probe.p1)}`);
      expect.ok(near(probe.t1, [22, 163, 74]), `t1 pixel ${describe(probe.t1)}`);
      expect.ok(near(probe.plate, [249, 115, 22]), `plate pixel ${describe(probe.plate)}`);
      expect.ok(near(probe.route, [220, 38, 38]), `route pixel ${describe(probe.route)}`);
      expect.ok(near(probe.empty, [255, 255, 255]) && probe.empty.a === 255, `empty pixel ${describe(probe.empty)}`);
    },
  },
  {
    // Regression: every pointermove used to add the full delta since drag start
    // to the already moved position, so dragged points accelerated away.
    name: 'drag-point-follows-pointer',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const start = await positionOf(session, 'points', 'p1');
      const startScreen = await screenOf(session, 'points', 'p1');
      const steps = [
        [15, -8],
        [15, -8],
        [15, -7],
        [15, -7],
      ];
      let x = startScreen.x;
      let y = startScreen.y;
      await session.mouse('mouseMoved', x, y);
      await session.mouse('mousePressed', x, y);
      await sleep(90);
      for (const [dx, dy] of steps) {
        x += dx;
        y += dy;
        await session.mouse('mouseMoved', x, y, { dragging: true });
        await sleep(40);
        const expected = await session.evaluate(`window.__e2e.map.view.screenToPosition({ x: ${x}, y: ${y} })`);
        const actual = await positionOf(session, 'points', 'p1');
        const error = metersBetween(actual, expected);
        expect.ok(error < 3, `pointer at (${x}, ${y}): point is ${Math.round(error)} m away from the pointer`);
      }
      await session.mouse('mouseReleased', x, y);
      const expectedEnd = await session.evaluate(`window.__e2e.map.view.screenToPosition({ x: ${x}, y: ${y} })`);
      await sleep(150);
      const end = await positionOf(session, 'points', 'p1');
      expect.ok(metersBetween(end, expectedEnd) < 3, 'point drifted after release');

      const revision = await session.evaluate('window.__e2e.stats().revision');
      await awaitRendered(session, revision);
      const atTarget = await pixelAt(session, end);
      const atStart = await pixelAt(session, start);
      expect.ok(near(atTarget, [37, 99, 235]), `rendered point not at the drop position: ${describe(atTarget)}`);
      expect.ok(!near(atStart, [37, 99, 235]), `old position still drawn: ${describe(atStart)}`);
    },
  },
  {
    name: 'drag-binding-follows',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const p1 = await positionOf(session, 'points', 'p1');
      const p2 = await positionOf(session, 'points', 'p2');
      const oldMid = midpoint(p1, p2);
      const screen = await screenOf(session, 'points', 'p1');
      await session.mouse('mouseMoved', screen.x, screen.y);
      await session.mouse('mousePressed', screen.x, screen.y);
      await sleep(90);
      await session.mouse('mouseMoved', screen.x, screen.y - 40, { dragging: true });
      await sleep(40);
      await session.mouse('mouseMoved', screen.x, screen.y - 80, { dragging: true });
      await sleep(50);
      await session.mouse('mouseReleased', screen.x, screen.y - 80);
      await sleep(150);

      const moved = await positionOf(session, 'points', 'p1');
      const revision = await session.evaluate('window.__e2e.stats().revision');
      await awaitRendered(session, revision);
      const newMid = await pixelAt(session, midpoint(moved, p2));
      const oldMidPixel = await pixelAt(session, oldMid);
      expect.ok(near(newMid, [124, 58, 237]), `binding link did not follow: midpoint ${describe(newMid)}`);
      expect.ok(!near(oldMidPixel, [124, 58, 237]), `old link position still drawn: ${describe(oldMidPixel)}`);
    },
  },
  {
    name: 'hover-click-real-mouse',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const screen = await screenOf(session, 'points', 'p1');
      await session.move(screen.x, screen.y);
      await sleep(300);
      const hovered = await session.evaluate(
        `window.__e2e.map.state.get(window.__e2e.ref(window.__e2e.points, 'p1')).hovered`,
      );
      expect.equal(hovered, true, 'hovered state after real mouse move');
      const cursor = await session.evaluate(`getComputedStyle(document.getElementById('map')).cursor`);
      expect.equal(cursor, 'move', 'draggable feature cursor');

      await session.move(620, 40);
      await sleep(300);
      const cleared = await session.evaluate(
        `window.__e2e.map.state.get(window.__e2e.ref(window.__e2e.points, 'p1')).hovered`,
      );
      expect.equal(cleared, false, 'hover clears when the pointer leaves');

      await session.evaluate(
        `window.__clicked = null; window.__e2e.map.on('feature', (event) => { if (event.type === 'click') window.__clicked = { id: event.feature.id, sourceId: event.sourceId, layerId: event.layerId }; }); 1`,
      );
      await session.click(screen.x, screen.y);
      await sleep(300);
      const clicked = await session.evaluate('window.__clicked');
      expect.ok(clicked !== null, 'click event delivered');
      if (clicked) {
        expect.equal(clicked.id, 'p1', 'clicked feature id');
        expect.equal(clicked.sourceId, 'points', 'clicked source');
        expect.equal(clicked.layerId, 'points', 'clicked layer');
      }
      const rendered = await session.evaluate(
        `window.__e2e.map.query.rendered({ x: ${Math.round(screen.x)}, y: ${Math.round(screen.y)} }).then((hits) => hits.map((hit) => hit.feature.id))`,
      );
      expect.ok(rendered.includes('p1'), `query.rendered found ${JSON.stringify(rendered)}`);
    },
  },
  {
    name: 'pan-canvas-real-drag',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const spot = await emptyScreen(session, [
        [560, 420],
        [60, 420],
        [560, 60],
        [40, 60],
        [600, 300],
      ]);
      expect.ok(spot !== null, 'empty canvas spot for the pan gesture');
      if (!spot) return;
      const before = await screenOf(session, 'points', 'p3');
      const centerBefore = await session.evaluate('window.__e2e.map.view.get().center');
      await session.drag(spot.x, spot.y, [
        { x: -30, y: 10 },
        { x: -30, y: 10 },
        { x: -20, y: 10 },
      ]);
      const after = await screenOf(session, 'points', 'p3');
      const centerAfter = await session.evaluate('window.__e2e.map.view.get().center');
      expect.close(after.x - before.x, -80, 2, 'point screen dx after 80 px pan');
      expect.close(after.y - before.y, 30, 2, 'point screen dy after 30 px pan');
      expect.ok(centerAfter.lng > centerBefore.lng, 'center lng moved with the pan');
      const revision = await session.evaluate('window.__e2e.stats().revision');
      await awaitRendered(session, revision);
      const pixel = await pixelAt(session, await positionOf(session, 'points', 'p3'));
      expect.ok(near(pixel, [37, 99, 235]), `point after pan: ${describe(pixel)}`);
    },
  },
  {
    name: 'wheel-zoom-around-cursor',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const p3 = await positionOf(session, 'points', 'p3');
      const cursor = await session.evaluate(`window.__e2e.screenOf(window.__e2e.positionOf(window.__e2e.points, 'p3'))`);
      const before = await session.evaluate('window.__e2e.map.view.get().zoom');
      const p1 = await screenOf(session, 'points', 'p1');
      const p2 = await screenOf(session, 'points', 'p2');
      const distanceBefore = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      await session.move(cursor.x, cursor.y);
      await session.wheel(cursor.x, cursor.y, -120);
      await sleep(250);
      const after = await session.evaluate('window.__e2e.map.view.get().zoom');
      expect.ok(after > before, `zoom increased (${before} -> ${after})`);
      const ratio = 2 ** (after - before);
      const p1b = await screenOf(session, 'points', 'p1');
      const p2b = await screenOf(session, 'points', 'p2');
      const distanceAfter = Math.hypot(p2b.x - p1b.x, p2b.y - p1b.y);
      expect.close(distanceAfter / distanceBefore, ratio, 0.05 * ratio, 'screen distance scaled with zoom');
      // Zoom around the cursor: the feature under the cursor stays under it.
      const revision = await session.evaluate('window.__e2e.stats().revision');
      await awaitRendered(session, revision);
      const pixel = await session.evaluate(`window.__e2e.samplePixel(${Math.round(cursor.x)}, ${Math.round(cursor.y)})`);
      expect.ok(near(pixel, [37, 99, 235]), `feature under the cursor after zoom: ${describe(pixel)}`);
    },
  },
  {
    name: 'zoom-control-real-click',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const button = await session.evaluate(`(() => {
        const element = document.querySelector('[data-maplet-corner="top-left"] button[data-action="in"]');
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      expect.ok(button !== null, 'zoom-in control button exists');
      if (!button) return;
      const before = await session.evaluate('window.__e2e.map.view.get().zoom');
      const p1 = await screenOf(session, 'points', 'p1');
      const p2 = await screenOf(session, 'points', 'p2');
      const distanceBefore = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      await session.click(button.x, button.y);
      await sleep(250);
      const after = await session.evaluate('window.__e2e.map.view.get().zoom');
      const p1b = await screenOf(session, 'points', 'p1');
      const p2b = await screenOf(session, 'points', 'p2');
      const distanceAfter = Math.hypot(p2b.x - p1b.x, p2b.y - p1b.y);
      const ratio = 2 ** (after - before);
      expect.ok(after > before, `zoom control changed zoom (${before} -> ${after})`);
      expect.close(distanceAfter / distanceBefore, ratio, 0.05 * ratio, 'rendered geometry scaled with the control zoom');
    },
  },
  {
    name: 'keyboard-pan-real-keys',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      await session.evaluate(`document.getElementById('map').focus(); 1`);
      const before = await screenOf(session, 'points', 'p1');
      const centerBefore = await session.evaluate('window.__e2e.map.view.get().center');
      await session.key('keyDown', 'ArrowRight', { code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await session.key('keyUp', 'ArrowRight', { code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await sleep(200);
      const after = await screenOf(session, 'points', 'p1');
      const centerAfter = await session.evaluate('window.__e2e.map.view.get().center');
      expect.close(after.x - before.x, -60, 2, 'ArrowRight pans the view by 60 px');
      expect.ok(centerAfter.lng > centerBefore.lng, 'center lng moved right');
    },
  },
  {
    name: 'update-loop-renders-every-step',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      let previous = await positionOf(session, 'points', 'p1');
      for (let step = 0; step < 5; step++) {
        const target = { lat: 50.0 + (step % 2 === 0 ? 0.012 : -0.012), lng: 14.02 + step * 0.006 };
        const revision = await pointTarget(session, target);
        await awaitRendered(session, revision);
        const pixel = await pixelAt(session, target);
        expect.ok(near(pixel, [37, 99, 235]), `step ${step}: point not rendered at the updated position (${describe(pixel)})`);
        if (step > 0) {
          const stale = await pixelAt(session, previous);
          expect.ok(!near(stale, [37, 99, 235]), `step ${step}: previous position still rendered (${describe(stale)})`);
        }
        previous = target;
      }
      const readback = await positionOf(session, 'points', 'p1');
      expect.ok(Math.abs(readback.lat - previous.lat) < 1e-9, 'readback matches the last update');
    },
  },
  {
    name: 'add-remove-renders',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const position = { lat: 49.99, lng: 14.1 };
      const added = await session.evaluate(
        `window.__e2e.targets.features.add({ id: 't2', geometry: { type: 'point', position: ${JSON.stringify(position)} }, properties: { name: 'T2' } }).revision`,
      );
      await awaitRendered(session, added);
      const drawn = await pixelAt(session, position);
      expect.ok(near(drawn, [22, 163, 74]), `added point rendered (${describe(drawn)})`);
      const count = await session.evaluate('window.__e2e.targets.features.count()');
      expect.equal(count, 2, 'count after add');

      const removed = await session.evaluate(`window.__e2e.targets.features.remove('t2').revision`);
      await awaitRendered(session, removed);
      const cleared = await pixelAt(session, position);
      expect.ok(!near(cleared, [22, 163, 74]), `removed point gone (${describe(cleared)})`);
      expect.equal(await session.evaluate('window.__e2e.targets.features.count()'), 1, 'count after remove');
    },
  },
  {
    name: 'line-geometry-update-renders',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const oldMid = { lat: 49.94, lng: 14.05 };
      const next = {
        type: 'lineString',
        positions: [
          { lat: 49.9, lng: 14.0 },
          { lat: 49.98, lng: 14.0 },
        ],
      };
      const revision = await session.evaluate(
        `window.__e2e.routes.features.update('r1', { geometry: ${JSON.stringify(next)} }).revision`,
      );
      await awaitRendered(session, revision);
      const drawn = await pixelAt(session, { lat: 49.94, lng: 14.0 });
      const cleared = await pixelAt(session, oldMid);
      expect.ok(near(drawn, [220, 38, 38]), `updated line rendered at the new geometry (${describe(drawn)})`);
      expect.ok(!near(cleared, [220, 38, 38]), `old line position gone (${describe(cleared)})`);
    },
  },
  {
    name: 'fill-geometry-update-renders',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const oldCenter = { lat: 49.98, lng: 14.045 };
      const next = {
        type: 'rectangle',
        southwest: { lat: 50.02, lng: 13.99 },
        northeast: { lat: 50.05, lng: 14.06 },
      };
      const revision = await session.evaluate(
        `window.__e2e.shapes.features.update('plate', { geometry: ${JSON.stringify(next)} }).revision`,
      );
      await awaitRendered(session, revision);
      const drawn = await pixelAt(session, { lat: 50.035, lng: 14.025 });
      const cleared = await pixelAt(session, oldCenter);
      expect.ok(near(drawn, [249, 115, 22]), `updated fill rendered at the new geometry (${describe(drawn)})`);
      expect.ok(!near(cleared, [249, 115, 22]), `old fill position gone (${describe(cleared)})`);
    },
  },
  {
    name: 'simple-crs-update-renders',
    page: 'e2e/simple.html',
    run: async ({ session, expect }) => {
      const positions = [
        { x: -0.004, y: 0.008 },
        { x: 0.005, y: -0.002 },
        { x: 0, y: 0 },
      ];
      let previous = await positionOf(session, 'marks', 'm1');
      for (const [index, target] of positions.entries()) {
        const revision = await session.evaluate(
          `window.__e2e.marks.features.update('m1', { geometry: { type: 'point', position: ${JSON.stringify(target)} } }).revision`,
        );
        await awaitRendered(session, revision);
        const drawn = await pixelAt(session, target);
        expect.ok(near(drawn, [219, 39, 119]), `planar update ${index}: point rendered at (${target.x},${target.y}) -> ${describe(drawn)}`);
        if (index > 0) {
          const stale = await pixelAt(session, previous);
          expect.ok(!near(stale, [219, 39, 119]), `planar update ${index}: previous position still drawn (${describe(stale)})`);
        }
        previous = target;
      }
    },
  },
  {
    name: 'simple-crs-drag-follows',
    page: 'e2e/simple.html',
    run: async ({ session, expect }) => {
      const start = await positionOf(session, 'marks', 'm1');
      const screen = await screenOf(session, 'marks', 'm1');
      let x = screen.x;
      let y = screen.y;
      await session.mouse('mouseMoved', x, y);
      await session.mouse('mousePressed', x, y);
      await sleep(90);
      for (const [dx, dy] of [
        [20, 10],
        [20, 10],
        [10, 10],
      ]) {
        x += dx;
        y += dy;
        await session.mouse('mouseMoved', x, y, { dragging: true });
        await sleep(40);
        const expected = await session.evaluate(`window.__e2e.map.view.screenToPosition({ x: ${x}, y: ${y} })`);
        const actual = await positionOf(session, 'marks', 'm1');
        const error = Math.hypot(actual.x - expected.x, actual.y - expected.y);
        expect.ok(error < 1e-6, `planar drag to (${x}, ${y}): point is ${error.toExponential(2)} units off the pointer`);
      }
      await session.mouse('mouseReleased', x, y);
      await sleep(150);
      const end = await positionOf(session, 'marks', 'm1');
      const revision = await session.evaluate('window.__e2e.stats().revision');
      await awaitRendered(session, revision);
      const drawn = await pixelAt(session, end);
      const cleared = await pixelAt(session, start);
      expect.ok(near(drawn, [219, 39, 119]), `planar point rendered at the drop position (${describe(drawn)})`);
      expect.ok(!near(cleared, [219, 39, 119]), `planar point left the start position (${describe(cleared)})`);
    },
  },
  {
    name: 'demo-page-drag-station',
    page: 'index.html',
    ready: 'window.__mapletReady === true',
    run: async ({ session, expect }) => {
      // The shipped demo page: drag a station exactly like a user would.
      const probe = await session.evaluate(`(async () => {
        const { map, stations } = window.__maplet;
        const position = stations.features.get('a').geometry.position;
        const screen = map.view.positionToScreen(position);
        return { position, screen };
      })()`);
      const pixelBefore = await session.evaluate(
        `window.__maplet.map.debug.samplePixel({ x: ${Math.round(probe.screen.x)}, y: ${Math.round(probe.screen.y)} })`,
      );
      // Anchor the view first so the station is at a known spot.
      await session.evaluate(`window.__maplet.map.view.set({ center: { lat: 50.08, lng: 14.44 }, zoom: 10 }); 1`);
      await sleep(200);
      const screen = await session.evaluate(
        `window.__maplet.map.view.positionToScreen(window.__maplet.stations.features.get('a').geometry.position)`,
      );
      const rect = await session.evaluate(`(() => {
        const box = document.getElementById('map').getBoundingClientRect();
        return { left: box.left, top: box.top };
      })()`);
      let x = screen.x + rect.left;
      let y = screen.y + rect.top;
      let previous = { x: screen.x, y: screen.y };
      await session.mouse('mouseMoved', x, y);
      await session.mouse('mousePressed', x, y);
      await sleep(120);
      for (const [dx, dy] of [
        [12, 6],
        [12, 6],
        [12, 6],
      ]) {
        x += dx;
        y += dy;
        previous = { x: previous.x + dx, y: previous.y + dy };
        await session.mouse('mouseMoved', x, y, { dragging: true });
        await sleep(45);
        const expected = await session.evaluate(`window.__maplet.map.view.screenToPosition({ x: ${previous.x}, y: ${previous.y} })`);
        const actual = await session.evaluate(`window.__maplet.stations.features.get('a').geometry.position`);
        const error = metersBetween(actual, expected);
        expect.ok(error < 3, `station at container (${previous.x}, ${previous.y}) is ${Math.round(error)} m off`);
      }
      await session.mouse('mouseReleased', x, y);
      // Move the pointer away so the hover style does not tint the sample.
      await session.move(860, 30);
      await sleep(300);
      const revision = await session.evaluate('window.__maplet.map.stats().revision');
      await session.evaluate(`window.__maplet.map.whenRendered(${revision})`);
      const pixelAfter = await session.evaluate(`window.__maplet.map.debug.samplePixel({ x: ${previous.x}, y: ${previous.y} })`);
      expect.ok(pixelAfter.a > 200, `station drawn at the drop position: ${describe(pixelAfter)}`);
      expect.ok(
        Math.abs(pixelBefore.r - pixelAfter.r) + Math.abs(pixelBefore.g - pixelAfter.g) + Math.abs(pixelBefore.b - pixelAfter.b) < 30,
        `station looks the same after the drag (${describe(pixelBefore)} -> ${describe(pixelAfter)})`,
      );
    },
  },
  {
    name: 'binding-copies-property',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      await session.evaluate(`window.__e2e.map.bindings.add({
        id: 'name-copy',
        target: window.__e2e.targets.features.ref('t1'),
        properties: { kind: 'copyProperty', from: window.__e2e.points.features.ref('p1'), field: 'name', toField: 'sourceName' },
      }); 1`);
      const copied = await session.evaluate(`window.__e2e.targets.features.get('t1').properties.sourceName`);
      expect.equal(copied, 'P1', 'binding copied the initial value');
      await session.evaluate(`window.__e2e.points.features.update('p1', { properties: { name: 'P1-renamed' } }); 1`);
      const updated = await session.evaluate(`window.__e2e.targets.features.get('t1').properties.sourceName`);
      expect.equal(updated, 'P1-renamed', 'binding followed the property update');
    },
  },
  {
    name: 'relations-survive-moves',
    page: 'e2e/scene.html',
    run: async ({ session, expect }) => {
      const neighbours = await session.evaluate(
        `window.__e2e.map.relations.neighbors(window.__e2e.points.features.ref('p1')).map((ref) => ref.id)`,
      );
      expect.ok(neighbours.includes('p2'), `relation neighbours ${JSON.stringify(neighbours)}`);
      const target = { lat: 50.03, lng: 13.99 };
      const revision = await pointTarget(session, target);
      await awaitRendered(session, revision);
      const after = await session.evaluate(
        `window.__e2e.map.relations.neighbors(window.__e2e.points.features.ref('p1')).map((ref) => ref.id)`,
      );
      expect.ok(after.includes('p2'), `relation neighbours after the move ${JSON.stringify(after)}`);
      const relation = await session.evaluate(`window.__e2e.map.relations.get('p1-p2') !== undefined`);
      expect.equal(relation, true, 'relation record still exists');
    },
  },
];

export default { batteries, scenarios };
