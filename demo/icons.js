/**
 * Icon (image asset / sprite) battery: asset states, one GPU texture shared by
 * hundreds of instances, shape fallback on load error, alpha-threshold picking
 * and anchors.
 *
 * Results: `window.__iconCheckResult`.
 */
import { createMap } from '../dist/index.js';

const SIZE = 512;
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">' +
  '<path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 24 16 24s16-12 16-24C32 7.2 24.8 0 16 0z" fill="#e11d48"/>' +
  '<circle cx="16" cy="16" r="6" fill="#ffffff"/></svg>';
const PIN_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(PIN_SVG);

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const map = await createMap({
  container: 'map',
  renderer: { primary: new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1', fallback: false },
  size: { width: SIZE, height: SIZE },
  view: { center: { lat: 50.0, lng: 14.0 }, zoom: 12 },
});

const source = map.sources.vector({ id: 'pois' });
// Diagnostics hook for the check page and manual inspection.
window.__iconDebug = { map, source };
const centerFeature = {
  id: 'center',
  geometry: { type: 'point', position: { lat: 50.0, lng: 14.0 } },
  properties: { name: 'center' },
};
// The rotated twin sits at an exact integer screen offset from the centre
// feature, so the GEOM-04 check can compare texel-identical samples (a quarter
// turn maps the sampling grid onto itself).
const centerScreen = map.view.positionToScreen({ lat: 50.0, lng: 14.0 });
const rotatedPosition = map.view.screenToPosition({ x: centerScreen.x + 58, y: centerScreen.y - 45 });
// A pin whose tip is declared as the anchor (tip 12 px below the 24 px sprite
// centre) and which is rotated: the tip must stay on the feature position.
const tipPosition = map.view.screenToPosition({ x: centerScreen.x + 150, y: centerScreen.y + 60 });
const bulk = [];
for (let i = 0; i < 500; i++) {
  bulk.push({
    id: `b${i}`,
    geometry: { type: 'point', position: { lat: 49.94 + (i % 25) * 0.0006, lng: 13.94 + Math.floor(i / 25) * 0.0006 } },
    properties: { name: `B${i}` },
  });
}
bulk.push(centerFeature);
bulk.push({ id: 'broken', geometry: { type: 'point', position: { lat: 50.03, lng: 14.03 } }, properties: {} });
bulk.push({ id: 'anchor', geometry: { type: 'point', position: { lat: 50.02, lng: 13.98 } }, properties: {} });
bulk.push({ id: 'rotated', geometry: { type: 'point', position: rotatedPosition }, properties: {} });
bulk.push({ id: 'tip', geometry: { type: 'point', position: tipPosition }, properties: {} });
await source.features.replace(bulk);

const states = [];
const asset = map.assets.addImage({ id: 'pin', src: PIN_URL });
asset.subscribe((snapshot) => states.push(snapshot.state));
const broken = map.assets.addImage({ id: 'broken-pin', src: './definitely-missing.png' });
map.layers.add({
  id: 'icons',
  type: 'points',
  source,
  filter: { and: [{ not: { id: 'broken' } }, { not: { id: 'anchor' } }, { not: { id: 'rotated' } }, { not: { id: 'tip' } }] },
  style: { icon: 'pin', iconSize: 24, radiusPx: 4, color: '#64748b' },
});
map.layers.add({
  id: 'broken-icons',
  type: 'points',
  source,
  filter: { id: 'broken' },
  style: { icon: 'broken-pin', radiusPx: 10, color: '#16a34a', strokeColor: '#052e16', strokeWidthPx: 1 },
});
map.layers.add({
  id: 'anchored',
  type: 'points',
  source,
  filter: { id: 'anchor' },
  style: { icon: 'pin', iconSize: 24, radiusPx: 0, iconAnchor: { x: 0, y: -40 } },
});
map.layers.add({
  id: 'rotated-icons',
  type: 'points',
  source,
  filter: { id: 'rotated' },
  style: { icon: 'pin', iconSize: 24, radiusPx: 0, iconRotate: 90 },
});
map.layers.add({
  id: 'tip-icons',
  type: 'points',
  source,
  filter: { id: 'tip' },
  style: { icon: 'pin', iconSize: 24, radiusPx: 0, iconAnchor: { x: 0, y: -12 }, iconRotate: 90 },
});

const sample = async (x, y) => {
  const pixel = await map.debug.samplePixel({ x, y });
  return [pixel.r, pixel.g, pixel.b, pixel.a];
};
const channel = (pixel, expected) =>
  Math.max(Math.abs(pixel[0] - expected[0]), Math.abs(pixel[1] - expected[1]), Math.abs(pixel[2] - expected[2]));

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.errors.push(`${name}: ${String(error)}`);
    result.checks.push({ name, pass: false, detail: String(error) });
  }
}

const started = performance.now();

await check('MEDIA-08 error state is explicit and falls back to the shape', async () => {
  const brokenState = await broken.ready();
  const brokenAnchor = map.view.positionToScreen({ lat: 50.03, lng: 14.03 });
  await sleep(300);
  const fallbackPixel = await sample(brokenAnchor.x, brokenAnchor.y);
  return {
    pass:
      brokenState.state === 'error' &&
      typeof brokenState.error === 'string' &&
      brokenState.error.length > 0 &&
      channel(fallbackPixel, [22, 163, 74]) <= 12,
    detail: {
      brokenState,
      fallbackPixel,
      spritesForBroken: map.debug.layerSprites('broken-icons').length,
    },
  };
});

await check('MEDIA-07 one texture shared by 500 instances', async () => {
  const ready = await asset.ready();
  const planSprites = map.debug.layerSprites('icons').length;
  await sleep(400);
  const stats = map.stats();
  const center = map.view.positionToScreen({ lat: 50.0, lng: 14.0 });
  // Icon centre maps to the white inner circle of the pin; the lower tip is red.
  const white = await sample(center.x, center.y);
  const red = await sample(center.x, center.y + 7);
  return {
    pass:
      ready.state === 'ready' &&
      planSprites === 501 &&
      stats.drawCalls <= 6 &&
      channel(white, [255, 255, 255]) <= 12 &&
      channel(red, [225, 29, 72]) <= 40,
    detail: { state: ready.state, width: ready.width, height: ready.height, planSprites, drawCalls: stats.drawCalls, white, red },
  };
});

await check('PICK-05 transparent icon areas are not hits', async () => {
  const center = map.view.positionToScreen({ lat: 50.0, lng: 14.0 });
  const corner = await map.query.rendered({ x: Math.round(center.x - 12), y: Math.round(center.y - 12) });
  const middle = await map.query.rendered({ x: Math.round(center.x), y: Math.round(center.y) });
  return {
    pass:
      !corner.some((hit) => hit.feature.id === 'center') &&
      middle.some((hit) => hit.feature.id === 'center'),
    detail: { corner: corner.map((hit) => hit.feature.id), middle: middle.map((hit) => hit.feature.id) },
  };
});

await check('anchor offset shifts the sprite', async () => {
  const anchor = map.view.positionToScreen({ lat: 50.02, lng: 13.98 });
  const atAnchor = await sample(anchor.x, anchor.y);
  const above = await sample(anchor.x, anchor.y - 40);
  return {
    pass: atAnchor[3] === 0 && channel(above, [255, 255, 255]) <= 12,
    detail: { atAnchor, above },
  };
});

await check('GEOM-04 rotation turns the sprite around its anchor', async () => {
  const flatAnchor = map.view.positionToScreen({ lat: 50.0, lng: 14.0 });
  const turnedAnchor = map.view.positionToScreen(rotatedPosition);
  // Model-free proof with texel-identical samples. Pixel centres are
  // half-integers, so a quarter clockwise turn about an integer anchor maps
  // the sampling grid onto itself as flat(dx,dy) = turned(-dy-1, dx).
  const turnedIndex = (dx, dy) => ({
    x: Math.round(turnedAnchor.x) - dy - 1,
    y: Math.round(turnedAnchor.y) + dx,
  });
  const grid = [];
  for (let dy = -9; dy <= 9; dy += 3) {
    for (let dx = -9; dx <= 9; dx += 3) grid.push({ dx, dy });
  }
  let pixelMatches = 0;
  let pickMatches = 0;
  let maxPixelDelta = 0;
  for (const { dx, dy } of grid) {
    const index = turnedIndex(dx, dy);
    const flat = await sample(Math.round(flatAnchor.x + dx), Math.round(flatAnchor.y + dy));
    const turned = await sample(index.x, index.y);
    const delta = Math.max(
      Math.abs(flat[0] - turned[0]),
      Math.abs(flat[1] - turned[1]),
      Math.abs(flat[2] - turned[2]),
      Math.abs(flat[3] - turned[3]),
    );
    if (delta > maxPixelDelta) maxPixelDelta = delta;
    if (delta <= 4) pixelMatches += 1;
    const flatHit = (await map.query.rendered({ x: Math.round(flatAnchor.x + dx), y: Math.round(flatAnchor.y + dy) })).some(
      (hit) => hit.feature.id === 'center',
    );
    const turnedHit = (await map.query.rendered({ x: index.x, y: index.y })).some(
      (hit) => hit.feature.id === 'rotated',
    );
    if (flatHit === turnedHit) pickMatches += 1;
  }
  // The pin's white inner circle is a readable anchor landmark: it sits ~10%
  // above the centre at 0 degrees and must move to the right at 90 degrees.
  const whiteCentroid = async (anchor) => {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const pixel = await sample(anchor.x + dx, anchor.y + dy);
        if (pixel[0] > 235 && pixel[1] > 235 && pixel[2] > 235 && pixel[3] > 200) {
          sx += dx;
          sy += dy;
          count += 1;
        }
      }
    }
    return count > 0 ? { x: sx / count, y: sy / count, count } : null;
  };
  const flat = await whiteCentroid(flatAnchor);
  const turned = await whiteCentroid(turnedAnchor);
  const required = Math.ceil(grid.length * 0.9);
  return {
    pass:
      pixelMatches >= required &&
      pickMatches >= required &&
      flat !== null &&
      turned !== null &&
      Math.abs(flat.x) <= 2 &&
      Math.abs(flat.y + 2.4) <= 2.5 &&
      Math.abs(turned.x - 2.4) <= 2.5 &&
      Math.abs(turned.y) <= 2,
    detail: { grid: grid.length, pixelMatches, pickMatches, maxPixelDelta, flat, turned },
  };
});

await check('GEOM-04 rotation keeps the declared anchor at the feature position', async () => {
  // The pin's tip is the declared anchor (iconAnchor y = -12 for a 24 px
  // sprite) and sits on the feature position; a quarter turn must orbit the
  // sprite around that point: ink only to the right of it (the head), the tip
  // body just right of it and nothing above or left.
  const anchor = map.view.positionToScreen(tipPosition);
  const body = await sample(anchor.x + 6, anchor.y);
  const left = await sample(anchor.x - 6, anchor.y);
  const top = await sample(anchor.x, anchor.y - 6);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let dy = -16; dy <= 16; dy += 2) {
    for (let dx = -16; dx <= 32; dx += 2) {
      const pixel = await sample(anchor.x + dx, anchor.y + dy);
      if (pixel[3] > 30) {
        if (dx < minX) minX = dx;
        if (dx > maxX) maxX = dx;
        if (dy < minY) minY = dy;
        if (dy > maxY) maxY = dy;
      }
    }
  }
  return {
    pass:
      channel(body, [225, 29, 72]) <= 40 &&
      body[3] > 200 &&
      left[3] < 30 &&
      top[3] < 30 &&
      minX >= -3 &&
      maxX >= 18 &&
      minY <= -8 &&
      maxY >= 8,
    detail: { anchor: [Math.round(anchor.x), Math.round(anchor.y)], body, left, top, box: { minX, maxX, minY, maxY } },
  };
});

await check('asset state sequence loading -> ready repaints', async () => {
  const second = map.assets.addImage({ id: 'pin-copy', src: PIN_URL });
  const before = map.stats().frames;
  const snapshot = await second.ready();
  // The repaint is scheduled through the frame loop; poll for it instead of
  // assuming a fixed latency (headless BeginFrames can be throttled to ~1 Hz,
  // measured up to ~0.9 s, while a visible page repaints in one frame).
  const started = performance.now();
  let frames = before;
  while (performance.now() - started < 3000 && frames === before) {
    await sleep(100);
    frames = map.stats().frames;
  }
  return {
    pass: states[0] === 'loading' && states.includes('ready') && snapshot.state === 'ready' && frames > before,
    detail: {
      states,
      snapshot: snapshot.state,
      frames: [before, frames],
      latencyMs: Math.round(performance.now() - started),
    },
  };
});

result.ms = Math.round(performance.now() - started);
result.pass = result.errors.length === 0 && result.checks.every((entry) => entry.pass);
window.__iconCheckResult = result;
document.title = 'icons-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
