/**
 * Backend parity battery (GPU-01 subset): one scene specification, two maps
 * (WebGL 1 and WebGPU). Raster tiles, point shapes, solid and dashed lines,
 * filled polygons with a hole, a glyph-atlas label and an icon are compared by
 * sampling both back buffers at the same CSS positions; picking and the draw
 * structure are compared too.
 *
 * Results: `window.__parityCheckResult`.
 */
import { createMap, crs, expr } from '../dist/index.js';

const SIZE = 512;
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">' +
  '<path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 24 16 24s16-12 16-24C32 7.2 24.8 0 16 0z" fill="#e11d48"/>' +
  '<circle cx="16" cy="16" r="6" fill="#ffffff"/></svg>';
const PIN_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(PIN_SVG);

const result = { checks: [], pass: false, errors: [], ms: 0, samples: [] };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const oracle = await (await fetch('./tiles-svg/checks.json')).json();
const { z, x, y } = oracle.tile;
const mercator = crs.webMercator();
const worldCenter = { x: ((x + 0.5) * 256) / 2 ** z, y: ((y + 0.5) * 256) / 2 ** z };
const viewCenter = mercator.fromWorld(worldCenter);
const worldAt = (dx, dy) => ({
  x: worldCenter.x + dx / 2 ** z,
  y: worldCenter.y + dy / 2 ** z,
});
const geoAt = (dx, dy) => mercator.fromWorld(worldAt(dx, dy));

// Scene offsets are relative to the view centre: a feature at `geoAt(dx, dy)`
// lands at CSS `(SIZE/2 + dx, SIZE/2 + dy)` (zoom equals the oracle tile zoom),
// so `screenAt` gives exact probe positions and every feature stays inside the
// viewport. (Earlier probes used the offsets as absolute screen positions and
// silently sampled tiles or off-screen space.)
const SCENE = {
  points: [
    { id: 'circle', at: geoAt(-170, -170), properties: { shape: 'circle', color: '#dc2626', radiusPx: 10 } },
    { id: 'square', at: geoAt(-120, -170), properties: { shape: 'square', color: '#16a34a', radiusPx: 9 } },
    { id: 'triangle', at: geoAt(-70, -170), properties: { shape: 'triangle', color: '#2563eb', radiusPx: 9 } },
  ],
  solidLine: [geoAt(-190, -110), geoAt(-90, -110)],
  dashedLine: [geoAt(-190, -70), geoAt(-90, -70)],
  fillOuter: [geoAt(-200, -20), geoAt(-40, -20), geoAt(-40, 100), geoAt(-200, 100)],
  fillHole: [geoAt(-170, 10), geoAt(-170, 70), geoAt(-70, 70), geoAt(-70, 10)],
  labelAt: geoAt(74, 150),
  iconAt: geoAt(170, 20),
};

async function buildMap(container, primary) {
  const map = await createMap({
    container,
    renderer: { primary, fallback: false },
    size: { width: SIZE, height: SIZE },
    view: { center: viewCenter, zoom: z },
  });
  map.assets.addImage({ id: 'pin', src: PIN_URL });
  const raster = map.sources.rasterTiles({
    id: 'tiles',
    url: './tiles-svg/{z}/{x}/{y}.svg',
    minZoom: 0,
    maxZoom: 3,
  });
  map.layers.add({ id: 'tiles', type: 'raster', source: raster });
  const vector = map.sources.vector({ id: 'shapes' });
  await vector.features.replace([
    { id: 'circle', geometry: { type: 'point', position: SCENE.points[0].at }, properties: SCENE.points[0].properties },
    { id: 'square', geometry: { type: 'point', position: SCENE.points[1].at }, properties: SCENE.points[1].properties },
    { id: 'triangle', geometry: { type: 'point', position: SCENE.points[2].at }, properties: SCENE.points[2].properties },
    { id: 'solid', geometry: { type: 'lineString', positions: SCENE.solidLine }, properties: {} },
    { id: 'dashed', geometry: { type: 'lineString', positions: SCENE.dashedLine }, properties: {} },
    {
      id: 'holed',
      geometry: { type: 'polygon', rings: [SCENE.fillOuter, SCENE.fillHole] },
      properties: {},
    },
    { id: 'label', geometry: { type: 'point', position: SCENE.labelAt }, properties: { name: 'Příliš žluťoučký kůň' } },
    { id: 'icon', geometry: { type: 'point', position: SCENE.iconAt }, properties: {} },
  ]);
  map.layers.add({
    id: 'shapes',
    type: 'points',
    source: 'shapes',
    filter: { or: [{ id: 'circle' }, { id: 'square' }, { id: 'triangle' }] },
    style: {
      radiusPx: expr.field('radiusPx'),
      color: expr.field('color'),
      shape: expr.field('shape'),
    },
  });
  map.layers.add({
    id: 'solid',
    type: 'lines',
    source: 'shapes',
    filter: { id: 'solid' },
    style: { color: '#0ea5e9', widthPx: 6 },
  });
  map.layers.add({
    id: 'dashed',
    type: 'lines',
    source: 'shapes',
    filter: { id: 'dashed' },
    style: { color: '#111827', widthPx: 5, dash: [12, 10] },
  });
  map.layers.add({
    id: 'holed',
    type: 'fills',
    source: 'shapes',
    filter: { id: 'holed' },
    style: { fillColor: '#f59e0b', fillOpacity: 0.9, strokeColor: '#b45309', strokeWidthPx: 2 },
  });
  map.layers.add({
    id: 'labels',
    type: 'labels',
    source: 'shapes',
    filter: { id: 'label' },
    style: { text: expr.field('name'), sizePx: 16, color: '#111827' },
  });
  map.layers.add({
    id: 'icons',
    type: 'points',
    source: 'shapes',
    filter: { id: 'icon' },
    style: { icon: 'pin', iconSize: 32, radiusPx: 0 },
  });
  return map;
}

const [glMap, gpuMap] = await Promise.all([
  buildMap('map-gl', 'webgl1'),
  buildMap('map-gpu', 'webgpu'),
]);

/** Exact CSS position of the scene feature placed at `geoAt(dx, dy)`. */
const screenAt = (dx, dy) => {
  const position = glMap.view.positionToScreen(geoAt(dx, dy));
  return { x: position.x, y: position.y };
};

const sampleOn = async (map, point) => {
  const pixel = await map.debug.samplePixel(point);
  return [pixel.r, pixel.g, pixel.b, pixel.a];
};

function maxDelta(a, b) {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
    Math.abs(a[3] - b[3]),
  );
}

async function sampleBoth(label, point, tolerance = 4) {
  const [left, right] = await Promise.all([sampleOn(glMap, point), sampleOn(gpuMap, point)]);
  const entry = { label, at: [point.x, point.y], webgl1: left, webgpu: right, delta: maxDelta(left, right) };
  result.samples.push(entry);
  return { ...entry, pass: entry.delta <= tolerance };
}

async function inkCount(map, cx, cy, halfWidth, halfHeight, threshold) {
  let count = 0;
  for (let py = cy - halfHeight; py <= cy + halfHeight; py++) {
    for (let px = cx - halfWidth; px <= cx + halfWidth; px++) {
      const pixel = await map.debug.samplePixel({ x: px, y: py });
      if (pixel.r + pixel.g + pixel.b < threshold) count++;
    }
  }
  return count;
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.errors.push(`${name}: ${String(error)}`);
    // MapletError carries structured detail (e.g. shader logs); keep it in the
    // failure report so a broken program is diagnosable from the runner output.
    const detail = error && typeof error === 'object' && 'detail' in error ? { message: String(error), detail: error.detail } : String(error);
    result.checks.push({ name, pass: false, detail });
  }
}

const started = performance.now();

// Wait until both maps finished their first complete frames.
await sleep(1200);

await check('capabilities name the requested backends', async () => ({
  pass:
    glMap.capabilities().backend === 'webgl1' &&
    gpuMap.capabilities().backend === 'webgpu',
  detail: {
    webgl1: glMap.capabilities(),
    webgpu: gpuMap.capabilities(),
  },
}));

// GPU-01 third profile: `?profile=basic` (runner `--basic`) forces the WebGL 1
// fallbacks at the API level; this check proves the forced profile is active
// (the WebGL 1 side of every comparison below then runs the fallback paths).
if (new URLSearchParams(location.search).get('profile') === 'basic') {
  await check('GPU-01 forced basic profile is active', async () => {
    const capabilities = glMap.capabilities();
    const notes = capabilities.notes;
    return {
      pass:
        capabilities.backend === 'webgl1' &&
        notes.some((note) => note.includes('ANGLE_instanced_arrays is unavailable')) &&
        notes.some((note) => note.includes('fragment highp is unavailable')),
      detail: { backend: capabilities.backend, notes },
    };
  });
}

await check('same raster tile pixels', async () => {
  const probes = [
    ['tile-a', { x: 30, y: 470 }],
    ['tile-b', { x: 470, y: 470 }],
    ['tile-c', { x: 30, y: 30 }],
  ];
  const outcomes = [];
  for (const [label, point] of probes) outcomes.push(await sampleBoth(label, point, 3));
  return { pass: outcomes.every((entry) => entry.pass), detail: outcomes };
});

await check('same point shapes', async () => {
  const outcomes = [
    await sampleBoth('circle', screenAt(-170, -170), 4),
    await sampleBoth('square', screenAt(-120, -170), 4),
    await sampleBoth('triangle', screenAt(-70, -168), 6),
  ];
  // The probes must land on the drawn shapes, not on the tiles below.
  const onShape = (entry, expected) => maxDelta(entry.webgl1, expected) <= 12;
  return {
    pass:
      outcomes.every((entry) => entry.pass) &&
      onShape(outcomes[0], [220, 38, 38, 255]) &&
      onShape(outcomes[1], [22, 163, 74, 255]) &&
      onShape(outcomes[2], [37, 99, 235, 255]),
    detail: outcomes,
  };
});

await check('same solid and dashed lines', async () => {
  const outcomes = [
    await sampleBoth('solid-middle', screenAt(-140, -110), 4),
    await sampleBoth('solid-edge', screenAt(-180, -107), 10),
  ];
  // The whole dash cycle must agree, including gaps and phase.
  for (let step = 0; step <= 24; step += 2) {
    outcomes.push(await sampleBoth(`dash-x${step}`, screenAt(-180 + step, -70), 10));
  }
  return { pass: outcomes.every((entry) => entry.pass), detail: outcomes };
});

await check('same fill with a hole', async () => {
  const fill = await sampleBoth('fill', screenAt(-190, 40), 4);
  const hole = await sampleBoth('hole', screenAt(-120, 40), 4);
  const filled = maxDelta(fill.webgl1, [245, 158, 11, 255]) <= 12;
  const hollow = maxDelta(hole.webgl1, fill.webgl1) > 40;
  return { pass: fill.pass && hole.pass && filled && hollow, detail: [fill, hole] };
});

await check('same label glyph pixels', async () => {
  // The exact atlas texture and quad are identical, so a glyph interior pixel
  // must match; pick the darkest pixel of the glyph on WebGL 1 as the probe.
  // The scan band stays right of the tile crosshair (x = 256) so only glyph
  // ink is measured.
  const labelAt = screenAt(74, 150);
  let best = null;
  for (let px = labelAt.x - 46; px <= labelAt.x + 46; px += 2) {
    for (let py = labelAt.y - 10; py <= labelAt.y + 10; py += 2) {
      const pixel = await glMap.debug.samplePixel({ x: px, y: py });
      if (pixel.a > 200 && pixel.r + pixel.g + pixel.b < (best?.sum ?? 400)) {
        best = { x: px, y: py, sum: pixel.r + pixel.g + pixel.b };
      }
    }
  }
  if (!best) return { pass: false, detail: 'no dark glyph pixel found on webgl1' };
  const probe = await sampleBoth('glyph', { x: best.x, y: best.y }, 24);
  const inkGl = await inkCount(glMap, labelAt.x, labelAt.y, 46, 10, 400);
  const inkGpu = await inkCount(gpuMap, labelAt.x, labelAt.y, 46, 10, 400);
  const inkRelative = Math.abs(inkGl - inkGpu) / Math.max(1, inkGl);
  return {
    pass: probe.pass && inkGl > 20 && inkRelative <= 0.05,
    detail: { probe, inkGl, inkGpu, inkRelative },
  };
});

await check('same icon pixels', async () => {
  // The pin texture fills a square quad centred on the feature position: its
  // white circle sits above the centre, its red tip 14 px below it (the tile
  // below the quad must not satisfy either colour assertion).
  const circle = await sampleBoth('icon-circle', screenAt(170, 16), 30);
  const tip = await sampleBoth('icon-tip', screenAt(170, 34), 30);
  const isWhite = maxDelta(circle.webgl1, [255, 255, 255, 255]) <= 30;
  const isRed = maxDelta(tip.webgl1, [225, 29, 72, 255]) <= 30;
  return { pass: circle.pass && tip.pass && isWhite && isRed, detail: [circle, tip] };
});

await check('same picking results', async () => {
  // Positive probes on features (hit exists and matches, including order) and
  // negative probes: the polygon hole is not a fill hit (PICK-03) and bare
  // tiles are not interactive (raster layers are opt-in).
  const probes = [
    { at: screenAt(-170, -170), hit: true },
    { at: screenAt(-140, -110), hit: true },
    { at: screenAt(-190, 40), hit: true },
    { at: screenAt(-120, 40), hit: false },
    { at: screenAt(170, 20), hit: true },
    { at: { x: 30, y: 470 }, hit: false },
  ];
  const rows = [];
  let pass = true;
  for (const probe of probes) {
    const left = await glMap.query.rendered(probe.at);
    const right = await gpuMap.query.rendered(probe.at);
    const normalize = (hits) =>
      hits.map((hit) => `${hit.layerId}:${typeof hit.feature.id}:${String(hit.feature.id)}`);
    const a = normalize(left);
    const b = normalize(right);
    const equal = a.length === b.length && a.every((value, index) => value === b[index]);
    const populated = probe.hit ? a.length > 0 && b.length > 0 : a.length === 0 && b.length === 0;
    if (!equal || !populated) pass = false;
    rows.push({ at: [probe.at.x, probe.at.y], webgl1: a, webgpu: b, equal, populated });
  }
  return { pass, detail: rows };
});

await check('same draw structure and instances', async () => {
  const left = glMap.stats();
  const right = gpuMap.stats();
  const instancesEqual = left.instances === right.instances;
  const drawCallsClose = Math.abs(left.drawCalls - right.drawCalls) <= 2;
  return {
    pass: instancesEqual && drawCallsClose && right.drawCalls > 0,
    detail: {
      webgl1: { instances: left.instances, drawCalls: left.drawCalls },
      webgpu: { instances: right.instances, drawCalls: right.drawCalls },
    },
  };
});

await check('fallback creates a WebGL 1 scene when WebGPU is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'gpu');
  Object.defineProperty(Navigator.prototype, 'gpu', {
    configurable: true,
    get: () => undefined,
  });
  const container = document.createElement('div');
  container.style.width = '64px';
  container.style.height = '64px';
  document.body.appendChild(container);
  let fallbackMap = null;
  let error = null;
  try {
    fallbackMap = await createMap({
      container,
      renderer: { primary: 'webgpu', fallback: 'webgl1' },
      size: { width: 64, height: 64 },
      view: { center: viewCenter, zoom: z },
    });
    const capabilities = fallbackMap.capabilities();
    return {
      pass:
        capabilities.backend === 'webgl1' &&
        capabilities.notes.some((note) => note.includes('webgpu unavailable')),
      detail: capabilities,
    };
  } catch (caught) {
    error = String(caught);
    return { pass: false, detail: { error } };
  } finally {
    if (descriptor) Object.defineProperty(Navigator.prototype, 'gpu', descriptor);
    fallbackMap?.destroy();
    container.remove();
  }
});

result.ms = Math.round(performance.now() - started);
result.pass = result.errors.length === 0 && result.checks.every((entry) => entry.pass);
window.__parityCheckResult = result;
window.__parity = { glMap, gpuMap };
document.title = 'parity-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
