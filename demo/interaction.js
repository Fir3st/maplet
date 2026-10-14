/**
 * Interaction battery: feature events, bubbling, hover state/style, cursor,
 * visibility, selection style, keyboard, pinch and feature drag.
 *
 * All pointer input is dispatched as synthetic PointerEvents on the map
 * element, so the page is a deterministic, self-checking contract harness
 * (the same path a real pointer takes, including pointer capture failures for
 * synthetic ids). Results land in `window.__interactionCheckResult`.
 *
 * Colour oracle (style expressions over `expr.state`):
 *   base   a = #16a34a  b = #2563eb
 *   hover  #ff0000      selected #f59e0b
 */
import { createMap, style as expr } from '../dist/index.js';

const SIZE = 512;
const TOL = 8;
const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channelDelta = (pixel, expected) =>
  Math.max(Math.abs(pixel.r - expected[0]), Math.abs(pixel.g - expected[1]), Math.abs(pixel.b - expected[2]));
const GREEN = [22, 163, 74];
const HOVER_RED = [255, 0, 0];
const SELECTED_AMBER = [245, 158, 11];

const map = await createMap('map', {
    renderer: { primary: new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1', fallback: false },
    size: { width: SIZE, height: SIZE },
    center: { lat: 50.1, lng: 14.1 }, zoom: 10
});

const source = map.data.vector({ id: 'pois' });
await source.features.replace([
  { id: 'a', geometry: { type: 'point', position: { lat: 50.0, lng: 14.0 } }, properties: { name: 'a' } },
  { id: 'b', geometry: { type: 'point', position: { lat: 50.2, lng: 14.2 } }, properties: { name: 'b' } },
]);
const root = map.addLayer({ id: 'root' });
const leaf = root.addLayer({ id: 'leaf' });
const layer = leaf.addLayer({
  id: 'pois-layer',
  type: 'points',
  source,
  interactive: true, draggable: true ,
  style: {
    radiusPx: 10,
    color: expr.when(
      expr.state('selected'),
      '#f59e0b',
      expr.when(expr.state('hovered'), '#ff0000', expr.match(expr.field('name'), { a: '#16a34a', b: '#2563eb' }, '#374151')),
    ),
  },
});

const element = document.getElementById('map');
const refA = source.features.ref('a');
const refB = source.features.ref('b');
const posA = map.positionToScreen({ lat: 50.0, lng: 14.0 });
const posB = map.positionToScreen({ lat: 50.2, lng: 14.2 });
const empty = { x: 40, y: 40 };

/* Event capture through the bubbling chain. */
const list = [];
const capture = (tag) => (event) => list.push(`${tag}:${event.type}`);
layer.onFeature(capture('layer'));
leaf.onFeature(capture('leaf'));
root.onFeature(capture('root'));
map.onFeature(capture('map'));

function pointer(type, point, options = {}) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: options.pointerId ?? 1,
      pointerType: options.pointerType ?? 'mouse',
      isPrimary: true,
      button: options.button ?? 0,
      buttons: options.buttons ?? (type === 'pointerdown' ? 1 : 0),
      clientX: rect.left + point.x,
      clientY: rect.top + point.y,
    }),
  );
}

async function click(point) {
  pointer('pointerdown', point);
  await sleep(40);
  pointer('pointerup', point);
  await sleep(350);
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.errors.push(`${name}: ${String(error)}`);
    result.checks.push({ name, pass: false, detail: String(error) });
  }
}

await sleep(300);

await check('EVENT-01 bubbling order', async () => {
  list.length = 0;
  await click(posA);
  const order = [...list].filter((entry) => entry.endsWith(':click'));
  return {
    pass: order.join(',') === 'layer:click,leaf:click,root:click,map:click',
    detail: { order },
  };
});

await check('EVENT-02 stopPropagation at the layer', async () => {
  const stopper = (event) => {
    if (event.type === 'click') {
      list.push('stop');
      event.stopPropagation();
    }
  };
  layer.onFeature(stopper);
  list.length = 0;
  await click(posA);
  const order = [...list];
  return {
    pass: order.join(',') === 'layer:click,stop',
    detail: { order },
  };
});

await check('hover drives state, style and cursor', async () => {
  list.length = 0;
  pointer('pointermove', posA);
  await sleep(450);
  const hovered = map.state.get(refA).hovered;
  const pixelHover = await map.debug.samplePixel(posA);
  const cursorHover = element.style.cursor;
  const sawOver = list.includes('map:mouseover');

  list.length = 0;
  pointer('pointermove', empty);
  await sleep(450);
  const hoveredAfter = map.state.get(refA).hovered;
  const pixelAway = await map.debug.samplePixel(posA);
  const cursorAway = element.style.cursor;
  const sawOut = list.includes('map:mouseout');
  return {
    pass:
      hovered &&
      sawOver &&
      channelDelta(pixelHover, HOVER_RED) <= TOL &&
      cursorHover === 'move' &&
      !hoveredAfter &&
      sawOut &&
      channelDelta(pixelAway, GREEN) <= TOL &&
      cursorAway === 'grab',
    detail: {
      hovered,
      sawOver,
      pixelHover: [pixelHover.r, pixelHover.g, pixelHover.b],
      cursorHover,
      hoveredAfter,
      sawOut,
      pixelAway: [pixelAway.r, pixelAway.g, pixelAway.b],
      cursorAway,
    },
  };
});

await check('PICK-09 last hover wins', async () => {
  pointer('pointermove', posA);
  pointer('pointermove', posB);
  await sleep(500);
  const a = map.state.get(refA).hovered;
  const b = map.state.get(refB).hovered;
  return { pass: !a && b, detail: { aHovered: a, bHovered: b } };
});

await check('STYLE-11 visibility override', async () => {
  const before = await map.debug.samplePixel(posA);
  layer.setFeatureStyle(refA, { visible: false });
  await sleep(350);
  const hidden = await map.debug.samplePixel(posA);
  const hitsHidden = await map.query.rendered(posA);
  layer.clearFeatureStyle(refA);
  await sleep(350);
  const back = await map.debug.samplePixel(posA);
  const hitsBack = await map.query.rendered(posA);
  return {
    pass:
      channelDelta(before, GREEN) <= TOL &&
      hidden.a === 0 &&
      hitsHidden.length === 0 &&
      channelDelta(back, GREEN) <= TOL &&
      hitsBack.some((hit) => hit.feature.id === 'a') &&
      source.features.count() === 2,
    detail: {
      before: [before.r, before.g, before.b, before.a],
      hidden: [hidden.r, hidden.g, hidden.b, hidden.a],
      hitsHidden: hitsHidden.length,
      back: [back.r, back.g, back.b, back.a],
      hitsBack: hitsBack.map((hit) => hit.feature.id),
      dataCount: source.features.count(),
    },
  };
});

await check('selection style via state.selected', async () => {
  map.selection.set([refA]);
  await sleep(350);
  const selectedPixel = await map.debug.samplePixel(posA);
  const selectedState = map.state.get(refA).selected;
  map.selection.clear();
  await sleep(350);
  const clearedPixel = await map.debug.samplePixel(posA);
  return {
    pass:
      selectedState &&
      channelDelta(selectedPixel, SELECTED_AMBER) <= TOL &&
      channelDelta(clearedPixel, GREEN) <= TOL,
    detail: {
      selectedState,
      selectedPixel: [selectedPixel.r, selectedPixel.g, selectedPixel.b],
      clearedPixel: [clearedPixel.r, clearedPixel.g, clearedPixel.b],
    },
  };
});

await check('INPUT-07/02 keyboard pan and zoom, form guard', async () => {
  element.focus();
  const before = map.getView();
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await sleep(120);
  const afterPan = map.getView();
  element.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
  await sleep(120);
  const afterZoom = map.getView();
  const input = document.createElement('input');
  element.appendChild(input);
  const lngBefore = map.getView().center.lng;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await sleep(120);
  const lngAfterInput = map.getView().center.lng;
  input.remove();
  return {
    pass:
      afterPan.center.lng > before.center.lng &&
      afterZoom.zoom > afterPan.zoom &&
      lngAfterInput === lngBefore,
    detail: {
      lng: [before.center.lng, afterPan.center.lng],
      zoom: [before.zoom, afterPan.zoom, afterZoom.zoom],
      formGuard: lngAfterInput === lngBefore,
    },
  };
});

await check('INPUT-03 pinch mid-gesture and pending-drag', async () => {
  map.setView({ center: { lat: 50.1, lng: 14.1 }, zoom: 10 });
  await sleep(150);
  const zoom0 = map.getView().zoom;
  // Both fingers land while the first press still waits for its pick.
  pointer('pointerdown', { x: 206, y: 256 }, { pointerId: 21, pointerType: 'touch' });
  pointer('pointerdown', { x: 306, y: 256 }, { pointerId: 22, pointerType: 'touch' });
  await sleep(40);
  // Settle moves establish the baseline distance (no zoom on the first move).
  pointer('pointermove', { x: 206, y: 256 }, { pointerId: 21, pointerType: 'touch', buttons: 1 });
  pointer('pointermove', { x: 306, y: 256 }, { pointerId: 22, pointerType: 'touch', buttons: 1 });
  await sleep(40);
  pointer('pointermove', { x: 156, y: 256 }, { pointerId: 21, pointerType: 'touch', buttons: 1 });
  pointer('pointermove', { x: 356, y: 256 }, { pointerId: 22, pointerType: 'touch', buttons: 1 });
  await sleep(60);
  const zoomEarly = map.getView().zoom;
  pointer('pointerup', { x: 156, y: 256 }, { pointerId: 21, pointerType: 'touch' });
  pointer('pointerup', { x: 356, y: 256 }, { pointerId: 22, pointerType: 'touch' });
  await sleep(80);
  // A finger lifted later: pinch continues as pan without a jump.
  const zoom1 = map.getView().zoom;
  pointer('pointerdown', { x: 206, y: 256 }, { pointerId: 23, pointerType: 'touch' });
  await sleep(120);
  pointer('pointerdown', { x: 306, y: 256 }, { pointerId: 24, pointerType: 'touch' });
  await sleep(40);
  pointer('pointermove', { x: 206, y: 256 }, { pointerId: 23, pointerType: 'touch', buttons: 1 });
  pointer('pointermove', { x: 306, y: 256 }, { pointerId: 24, pointerType: 'touch', buttons: 1 });
  await sleep(40);
  pointer('pointermove', { x: 156, y: 256 }, { pointerId: 23, pointerType: 'touch', buttons: 1 });
  pointer('pointermove', { x: 356, y: 256 }, { pointerId: 24, pointerType: 'touch', buttons: 1 });
  await sleep(60);
  const zoom2 = map.getView().zoom;
  pointer('pointerup', { x: 156, y: 256 }, { pointerId: 23, pointerType: 'touch' });
  await sleep(60);
  const zoomAfterLift = map.getView().zoom;
  pointer('pointermove', { x: 120, y: 300 }, { pointerId: 24, pointerType: 'touch', buttons: 1 });
  await sleep(60);
  const zoomWhilePan = map.getView().zoom;
  pointer('pointerup', { x: 120, y: 300 }, { pointerId: 24, pointerType: 'touch' });
  return {
    pass:
      zoomEarly > zoom0 + 0.5 &&
      zoom2 > zoom1 + 0.5 &&
      Math.abs(zoomAfterLift - zoom2) < 1e-6 &&
      Math.abs(zoomWhilePan - zoom2) < 1e-6,
    detail: { zoom0, zoomEarly, zoom1, zoom2, zoomAfterLift, zoomWhilePan },
  };
});

await check('INPUT-04 feature drag moves the feature, not the map', async () => {
  // Earlier checks moved the view; re-anchor so posA points at the feature again.
  map.setView({ center: { lat: 50.1, lng: 14.1 }, zoom: 10 });
  await sleep(150);
  const anchorA = map.positionToScreen({ lat: 50.0, lng: 14.0 });
  const centerBefore = map.getView().center;
  const aBefore = source.features.get('a').geometry.position;
  list.length = 0;
  pointer('pointerdown', anchorA, { pointerId: 41 });
  await sleep(120);
  pointer('pointermove', { x: anchorA.x + 20, y: anchorA.y + 10 }, { pointerId: 41, buttons: 1 });
  await sleep(40);
  const aMid = source.features.get('a').geometry.position;
  const expectedMid = map.screenToPosition({ x: anchorA.x + 20, y: anchorA.y + 10 });
  pointer('pointermove', { x: anchorA.x + 40, y: anchorA.y + 20 }, { pointerId: 41, buttons: 1 });
  await sleep(60);
  pointer('pointerup', { x: anchorA.x + 40, y: anchorA.y + 20 }, { pointerId: 41 });
  await sleep(250);
  const aAfter = source.features.get('a').geometry.position;
  const expectedEnd = map.screenToPosition({ x: anchorA.x + 40, y: anchorA.y + 20 });
  const centerAfter = map.getView().center;
  const dragEvents = list.filter((entry) => entry.includes('drag'));
  // Every move must land exactly under the pointer: adding the full delta since
  // drag start to the already moved position used to accelerate the feature.
  const meters = (a, b) =>
    Math.hypot(
      (a.lng - b.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)),
      (a.lat - b.lat) * 110540,
    );
  const midErrorM = Math.round(meters(aMid, expectedMid));
  const endErrorM = Math.round(meters(aAfter, expectedEnd));
  return {
    pass:
      (aAfter.lng !== aBefore.lng || aAfter.lat !== aBefore.lat) &&
      centerAfter.lng === centerBefore.lng &&
      centerAfter.lat === centerBefore.lat &&
      midErrorM <= 3 &&
      endErrorM <= 3 &&
      dragEvents.includes('layer:dragstart') &&
      dragEvents.includes('layer:drag') &&
      dragEvents.includes('layer:dragend') &&
      dragEvents.includes('map:dragend'),
    detail: {
      before: [aBefore.lat, aBefore.lng],
      after: [aAfter.lat, aAfter.lng],
      midErrorM,
      endErrorM,
      viewMoved: centerAfter.lng !== centerBefore.lng || centerAfter.lat !== centerBefore.lat,
      dragEvents,
    },
  };
});

result.pass = result.errors.length === 0 && result.checks.every((entry) => entry.pass);
window.__interactionCheckResult = result;
document.title = 'interaction-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
