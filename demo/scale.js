/**
 * 500 000 points example (P8) — and its own e2e battery.
 *
 * The page generates the batch procedurally, prepares it with the real import
 * worker (`copy:false` transfers the position buffer), draws it as one instanced
 * draw and runs a scripted 2.5 s pan test with measured frame cadence. The HUD
 * reports this machine's numbers; they are not reference benchmark results
 * (B01–B12 wait for reference hardware).
 *
 * Results: `window.__scaleCheckResult` (set after the automatic run).
 */
import { createMap } from '../dist/index.js';

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const memory = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
const MB = (bytes) => (bytes === null ? null : Math.round((bytes / 1048576) * 10) / 10);

const COUNT = 500000;
const SIDE = Math.ceil(Math.sqrt(COUNT));
const CENTER = { lat: 50, lng: 14.05 };
const ZOOM = 10;
const PROBE_B = { lat: 49.6, lng: 14.5 };

let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass =
    result.errors.length === 0 && result.checks.length === 3 && result.checks.every((entry) => entry.pass);
  window.__scaleCheckResult = result;
  document.title = 'scale-check-done';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
const started = performance.now();

const map = await createMap({
  container: 'map',
  renderer:
    new URLSearchParams(location.search).get('backend') === 'webgpu'
      ? { primary: 'webgpu', fallback: false }
      : { primary: 'webgl1', fallback: false },
  size: { width: 720, height: 520 },
  view: { center: CENTER, zoom: ZOOM },
});
const source = map.sources.vector({ id: 'points' });
map.layers.add({
  id: 'points',
  type: 'points',
  source,
  style: { radiusPx: 2, color: '#2563eb' },
  interaction: { enabled: true },
});

/* --------------------------------- HUD ------------------------------------- */
const hud = (id, value) => {
  document.getElementById(`hud-${id}`).textContent = value;
};
function updateStats() {
  const stats = map.stats();
  hud('instances', stats.instances.toLocaleString('en-US'));
  hud('draws', String(stats.drawCalls));
  hud('gpu', `${MB(stats.gpuBytes)} MB`);
  hud('frames', stats.frames.toLocaleString('en-US'));
  if (performance.memory) hud('heap', `${MB(performance.memory.usedJSHeapSize)} MB`);
}
let hudScheduled = false;
map.on('viewchange', () => {
  if (hudScheduled) return;
  hudScheduled = true;
  requestAnimationFrame(() => {
    hudScheduled = false;
    updateStats();
  });
});
map.on('feature', (event) => {
  if (event.type === 'mouseover') {
    const feature = source.features.get(event.feature.id);
    hud('hover', `${String(event.feature.id)} · ${feature ? JSON.stringify(feature.properties) : ''}`);
  } else if (event.type === 'mouseout') {
    hud('hover', '–');
  }
});

/* ------------------------------- the data ---------------------------------- */
function generateBatch() {
  const positions = new Float64Array(COUNT * 2);
  const ids = new Array(COUNT);
  const properties = new Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 2] = CENTER.lng - 0.5 + (i % SIDE) * (1 / SIDE);
    positions[i * 2 + 1] = CENTER.lat - 0.5 + Math.floor(i / SIDE) * (1 / SIDE);
    ids[i] = `p:${i}`;
    properties[i] = { v: i % 8 };
  }
  return { kind: 'point', positions, ids, properties };
}

const baseHeap = memory();
async function importPoints() {
  const tGen = performance.now();
  const batch = generateBatch();
  const genMs = Math.round(performance.now() - tGen);
  hud('generate', `${genMs} ms`);

  let peak = memory();
  const sampler = setInterval(() => {
    const value = memory();
    if (value !== null && (peak === null || value > peak)) peak = value;
  }, 20);
  const tImport = performance.now();
  const commit = await source.importColumnar(batch, { copy: false });
  const importMs = Math.round(performance.now() - tImport);
  clearInterval(sampler);
  const detached = batch.positions.byteLength === 0;
  hud('import', `${importMs} ms`);

  const tRender = performance.now();
  await map.whenRendered(commit.revision);
  await sleep(20);
  const renderMs = Math.round(performance.now() - tRender);
  hud('render', `${renderMs} ms`);
  hud('features', source.features.count().toLocaleString('en-US'));
  updateStats();

  return {
    genMs,
    importMs,
    renderMs,
    detached,
    count: source.features.count(),
    peakMB: peak !== null && baseHeap !== null ? MB(peak - baseHeap) : null,
    heapMB: memory() !== null && baseHeap !== null ? MB(memory() - baseHeap) : null,
    imports: map.debug.imports(),
  };
}

/* ------------------------------ measurements ------------------------------- */
const blue = (pixel) => pixel.b > 180 && pixel.r < 90 && pixel.g < 160;
async function probePixel(position) {
  const screen = map.view.positionToScreen(position);
  return map.debug.samplePixel({ x: Math.round(screen.x), y: Math.round(screen.y) });
}

async function panTest(ms = 2500) {
  const frames0 = map.stats().frames;
  const times = [];
  const end = performance.now() + ms;
  let frames = 0;
  while (performance.now() < end) {
    const t0 = performance.now();
    map.view.set({
      center: {
        lat: CENTER.lat + 0.0006 * Math.sin(frames / 9),
        lng: CENTER.lng + 0.0008 * Math.cos(frames / 7),
      },
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    times.push(performance.now() - t0);
    frames++;
  }
  const engineFrames = map.stats().frames - frames0;
  times.sort((a, b) => a - b);
  const pct = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * q))] * 10) / 10;
  const metrics = { frames, engineFrames, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: pct(1) };
  hud('pan', `${metrics.p50Ms} / ${metrics.p95Ms} ms`);
  updateStats();
  return metrics;
}

/* ------------------------------- the run ----------------------------------- */
const reimportButton = document.getElementById('reimport');
const panButton = document.getElementById('pan');
async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: !!outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.checks.push({ name, pass: false, detail: String(error) });
    result.errors.push(`${name}: ${String(error)}`);
  }
}

reimportButton.disabled = true;
panButton.disabled = true;

const imported = await importPoints();
await check('SCL-01 500k points import through the worker', async () => ({
  pass:
    imported.detached &&
    imported.count === COUNT &&
    imported.imports.backend === 'worker' &&
    imported.imports.used.worker >= 1,
  detail: {
    count: imported.count,
    detached: imported.detached,
    genMs: imported.genMs,
    importMs: imported.importMs,
    peakImportMB: imported.peakMB,
    heapAfterImportMB: imported.heapMB,
    imports: imported.imports,
  },
}));

const stats = map.stats();
const pixelA = await probePixel(CENTER);
const pixelB = await probePixel(PROBE_B);
await check('SCL-02 the batch renders as one clipped instanced draw', async () => ({
  pass:
    blue(pixelA) &&
    blue(pixelB) &&
    stats.drawCalls === 1 &&
    stats.instances > 50000 &&
    stats.instances <= COUNT &&
    stats.gpuBytes > 0,
  detail: {
    firstRenderMs: imported.renderMs,
    pixelCenter: `rgba(${pixelA.r},${pixelA.g},${pixelA.b})`,
    pixelB: `rgba(${pixelB.r},${pixelB.g},${pixelB.b})`,
    drawCalls: stats.drawCalls,
    instances: stats.instances,
    gpuBytesMB: MB(stats.gpuBytes),
  },
}));

const pan = await panTest();
map.view.set({ center: CENTER, zoom: ZOOM });
await map.whenRendered();
await sleep(30);
const pixelAfter = await probePixel(CENTER);
await check('SCL-03 a scripted pan keeps rendering', async () => ({
  pass:
    pan.frames >= 2 &&
    pan.engineFrames >= 2 &&
    pan.engineFrames >= pan.frames - 1 &&
    blue(pixelAfter),
  detail: {
    ...pan,
    pixelAfter: `rgba(${pixelAfter.r},${pixelAfter.g},${pixelAfter.b})`,
  },
}));

finalize();
reimportButton.disabled = false;
panButton.disabled = false;

reimportButton.addEventListener('click', () => {
  reimportButton.disabled = true;
  void importPoints().finally(() => {
    reimportButton.disabled = false;
  });
});
panButton.addEventListener('click', () => {
  panButton.disabled = true;
  void panTest().finally(() => {
    panButton.disabled = false;
  });
});
