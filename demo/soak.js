/**
 * Soak battery (P8): lifecycle at scale in a real browser.
 *
 * Twelve create/destroy cycles (rendered pixel, canvas removed, `destroy()`
 * idempotent, font asset released, GC-stabilized heap growth), a sustained
 * pan/update run, a 500k-point worker import with a cancelled heavy job, and a
 * heavy map destroy that must release the store. Heap deltas call `gc()` when
 * the runner exposes it (`--js-flags=--expose-gc`, always in `npm run e2e`);
 * manual runs without it use looser sanity bounds and say so.
 *
 * Results: `window.__soakCheckResult`.
 */
import { createMap } from '../dist/index.js';

const result = { checks: [], pass: false, errors: [], ms: 0, memory: {} };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const memory = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
const MB = (bytes) => (bytes === null ? null : Math.round((bytes / 1048576) * 10) / 10);
const hasGc = typeof globalThis.gc === 'function';
const gcNow = () => {
  if (hasGc) {
    globalThis.gc();
    globalThis.gc();
  }
};

let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass =
    result.errors.length === 0 && result.checks.length === 7 && result.checks.every((entry) => entry.pass);
  window.__soakCheckResult = result;
  document.title = 'soak-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
const started = performance.now();

const renderer =
  new URLSearchParams(location.search).get('backend') === 'webgpu'
    ? { primary: 'webgpu', fallback: false }
    : { primary: 'webgl1', fallback: false };

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: !!outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.checks.push({ name, pass: false, detail: String(error) });
    result.errors.push(`${name}: ${String(error)}`);
  }
}

const blue = (pixel) => pixel.b > 180 && pixel.r < 90 && pixel.g < 160;
const COUNT = 500000;
const SIDE = Math.ceil(Math.sqrt(COUNT));
const makeBatch = (prefix, mod) => {
  const positions = new Float64Array(COUNT * 2);
  const ids = new Array(COUNT);
  const properties = new Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 2] = 13.55 + (i % SIDE) * (1 / SIDE);
    positions[i * 2 + 1] = 49.5 + Math.floor(i / SIDE) * (1 / SIDE);
    ids[i] = `${prefix}:${i}`;
    properties[i] = { v: i % mod };
  }
  return { kind: 'point', positions, ids, properties };
};

gcNow();
const baseHeap = memory();
result.memory = { api: baseHeap !== null, gc: hasGc, heapLimitMB: performance.memory ? MB(performance.memory.jsHeapSizeLimit) : null };

/* ------------------------- 1) create/destroy cycles ------------------------ */
const offscreen = document.createElement('div');
offscreen.style.cssText = 'position:fixed;left:-9999px;top:0';
document.body.appendChild(offscreen);
const fontBaseline = document.fonts.size;
const cycleBlue = [];
const cycleCanvasGone = [];
let fontState = 'not-loaded';
for (let i = 0; i < 12; i++) {
  const host = document.createElement('div');
  host.style.width = '320px';
  host.style.height = '240px';
  offscreen.appendChild(host);
  const map = await createMap({
    container: host,
    renderer,
    size: { width: 320, height: 240 },
    view: { center: { lat: 50, lng: 14.05 }, zoom: 10 },
  });
  const source = map.sources.vector({ id: `v${i}` });
  source.features.replace([
    { id: 'a', geometry: { type: 'point', position: { lat: 50, lng: 14.05 } }, properties: {} },
    { id: 'b', geometry: { type: 'point', position: { lat: 50.05, lng: 14.1 } }, properties: {} },
  ]);
  map.layers.add({ id: `p${i}`, type: 'points', source, style: { radiusPx: 8, color: '#2563eb' } });
  if (i === 3) {
    const font = map.assets.addFont({ id: 'soak', family: 'SoakFixture', src: './fonts/maplet-subset.woff2' });
    await font.ready();
    fontState = font.snapshot().state;
  }
  await map.whenRendered();
  await sleep(20);
  cycleBlue.push(blue(await map.debug.samplePixel({ x: 160, y: 120 })));
  map.destroy();
  map.destroy();
  cycleCanvasGone.push(host.querySelector('canvas') === null);
  host.remove();
}
offscreen.remove();
gcNow();
const afterCyclesHeap = memory();

await check('SOAK-01 twelve create/destroy cycles render and clean up', async () => ({
  pass:
    cycleBlue.every(Boolean) &&
    cycleCanvasGone.every(Boolean) &&
    cycleBlue.length === 12 &&
    cycleCanvasGone.length === 12,
  detail: { cycles: 12, blue: cycleBlue.filter(Boolean).length, canvasGone: cycleCanvasGone.filter(Boolean).length },
}));

await check('SOAK-02 the font asset is released with its map', async () => ({
  pass: fontState === 'ready' && document.fonts.size === fontBaseline,
  detail: { fontState, fontBaseline, fontAfter: document.fonts.size },
}));

await check('SOAK-03 cycle heap growth stays bounded', async () => {
  const growthMB = baseHeap !== null && afterCyclesHeap !== null ? MB(afterCyclesHeap - baseHeap) : null;
  const boundMB = hasGc ? 8 : 80;
  return {
    pass: growthMB === null ? true : growthMB < boundMB,
    detail: {
      growthMB,
      boundMB,
      gc: hasGc,
      measured: growthMB !== null,
      note: hasGc ? 'GC-stabilized' : 'gc() not exposed; run npm run e2e for the GC-stabilized bound',
    },
  };
});

/* --------------- 2) heavy map: import, cancel, destroy release ------------- */
document.body.appendChild(offscreen);
const heavy = await (async () => {
  const host = document.createElement('div');
  host.style.width = '420px';
  host.style.height = '320px';
  offscreen.appendChild(host);
  const map = await createMap({
    container: host,
    renderer,
    size: { width: 420, height: 320 },
    view: { center: { lat: 50, lng: 14.05 }, zoom: 10 },
  });
  const source = map.sources.vector({ id: 'big' });
  map.layers.add({ id: 'big', type: 'points', source, style: { radiusPx: 2, color: '#2563eb' } });

  const tGen0 = performance.now();
  let batch = makeBatch('p', 8);
  const genMs = performance.now() - tGen0;
  let peak = memory();
  const sampler = setInterval(() => {
    const value = memory();
    if (value !== null && (peak === null || value > peak)) peak = value;
  }, 20);
  const tImp0 = performance.now();
  const commit = await source.importColumnar(batch, { copy: false });
  const importMs = performance.now() - tImp0;
  clearInterval(sampler);
  const detached = batch.positions.byteLength === 0;
  batch = null;
  gcNow();
  const heapAfterImport = memory();

  const tRender0 = performance.now();
  await map.whenRendered(commit.revision);
  await sleep(30);
  const renderMs = performance.now() - tRender0;
  const sampleAt = async (position) => {
    const screen = map.view.positionToScreen(position);
    return map.debug.samplePixel({ x: Math.round(screen.x), y: Math.round(screen.y) });
  };
  const pixelsBlue = blue(await sampleAt({ lat: 50, lng: 14.05 })) && blue(await sampleAt({ lat: 49.6, lng: 14.5 }));
  const stats = map.stats();
  const imports = map.debug.imports();

  const controller = new AbortController();
  let batch2 = makeBatch('q', 4);
  setTimeout(() => controller.abort(), 40);
  const aborted = await source
    .importColumnar(batch2, { copy: false, signal: controller.signal })
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, code: error.code, reason: error.detail?.reason }),
    );
  batch2 = null;
  await sleep(150);
  const countAfterAbort = source.features.count();
  const pendingAfterAbort = map.debug.imports().pending;
  const smallCount = await source
    .importColumnar({ kind: 'point', positions: new Float64Array([14.05, 50]), ids: ['z'], properties: [{}] }, { copy: true })
    .then(() => source.features.count(), (error) => `error:${error.code}`);

  map.destroy();
  host.remove();
  gcNow();
  const residual = memory();
  // Large ArrayBuffer backing stores are returned to the allocator
  // asynchronously; a second settled reading after a short pause is the
  // stable number (the immediate one can overstate retention by ~28 MB).
  await sleep(250);
  gcNow();
  const residualSettled = memory();
  return {
    count: COUNT,    genMs: Math.round(genMs),
    importMs: Math.round(importMs),
    peakImportMB: peak !== null && baseHeap !== null ? MB(peak - baseHeap) : null,
    detached,
    heapAfterImportMB: heapAfterImport !== null && baseHeap !== null ? MB(heapAfterImport - baseHeap) : null,
    renderMs: Math.round(renderMs),
    pixelsBlue,
    stats: { drawCalls: stats.drawCalls, instances: stats.instances, gpuBytesMB: MB(stats.gpuBytes) },
    imports,
    aborted,
    countAfterAbort,
    pendingAfterAbort,
    smallCount,
    residualMB: residual !== null && baseHeap !== null ? MB(residual - baseHeap) : null,
    residualSettledMB: residualSettled !== null && baseHeap !== null ? MB(residualSettled - baseHeap) : null,
  };
})();
offscreen.remove();

await check('SOAK-04 the 500k worker import publishes and renders', async () => ({
  pass:
    heavy.detached &&
    heavy.imports.backend === 'worker' &&
    heavy.imports.used.worker >= 1 &&
    heavy.pixelsBlue &&
    heavy.peakImportMB !== null &&
    heavy.peakImportMB < 120,
  detail: {
    detached: heavy.detached,
    imports: heavy.imports,
    pixelsBlue: heavy.pixelsBlue,
    genMs: heavy.genMs,
    importMs: heavy.importMs,
    renderMs: heavy.renderMs,
    peakImportMB: heavy.peakImportMB,
    heapAfterImportMB: heavy.heapAfterImportMB,
    stats: heavy.stats,
  },
}));

await check('SOAK-05 a cancelled heavy job rolls back and stays healthy', async () => ({
  pass:
    !heavy.aborted.ok &&
    heavy.aborted.code === 'aborted' &&
    heavy.countAfterAbort === heavy.count &&
    heavy.pendingAfterAbort === 0 &&
    heavy.smallCount === 1,
  detail: {
    aborted: heavy.aborted,
    countAfterAbort: heavy.countAfterAbort,
    pendingAfterAbort: heavy.pendingAfterAbort,
    smallCount: heavy.smallCount,
  },
}));

await check('SOAK-06 destroying the heavy map releases the store', async () => {
  const residualMB = heavy.residualSettledMB ?? heavy.residualMB;
  // 96 MB is ~2x the observed GC-stabilized residual (~45 MB, deferred
  // ArrayBuffer frees included) and well under the ~157 MB store itself, so a
  // real store leak still fails the check.
  const boundMB = hasGc ? 96 : 320;
  return {
    pass:
      residualMB === null ? true : residualMB < boundMB && residualMB < heavy.heapAfterImportMB * 0.6,
    detail: {
      residualMB,
      residualImmediateMB: heavy.residualMB,
      heapAfterImportMB: heavy.heapAfterImportMB,
      boundMB,
      gc: hasGc,
      measured: residualMB !== null,
      note: hasGc ? 'GC-stabilized after destroy' : 'gc() not exposed; loose sanity bound',
    },
  };
});

/* ---------------------------- 3) sustained run ----------------------------- */
await check('SOAK-07 a sustained pan/update run keeps rendering', async () => {
  // Bare rAF cadence without any map work: distinguishes page-level BeginFrame
  // throttling from map cost before the run below interprets its frame times.
  const bare = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    bare.push(Math.round(performance.now() - t0));
  }
  gcNow();
  const heapStart = memory();
  const host = document.getElementById('map');
  const map = await createMap({
    container: host,
    renderer,
    size: { width: 420, height: 320 },
    view: { center: { lat: 50, lng: 14.05 }, zoom: 10 },
  });
  const source = map.sources.vector({ id: 'run' });
  const features = [];
  for (let i = 0; i < 400; i++) {
    features.push({
      id: `f:${i}`,
      geometry: { type: 'point', position: { lat: 49.9 + (i % 20) * 0.01, lng: 13.9 + Math.floor(i / 20) * 0.01 } },
      properties: { v: 0 },
    });
  }
  source.features.replace(features);
  map.layers.add({ id: 'run', type: 'points', source, style: { radiusPx: 5, color: '#2563eb' } });
  await map.whenRendered();

  const bareAfterMap = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    bareAfterMap.push(Math.round(performance.now() - t0));
  }

  const frames0 = map.stats().frames;
  const times = [];
  const setTimes = [];
  const waitTimes = [];
  const end = performance.now() + 3000;
  let rafFrames = 0;
  let lastUpdate = 0;
  while (performance.now() < end) {
    const t0 = performance.now();
    map.view.set({ center: { lat: 50 + 0.0006 * Math.sin(rafFrames / 9), lng: 14.05 + 0.0008 * Math.cos(rafFrames / 7) } });
    const t1 = performance.now();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const t2 = performance.now();
    if (rafFrames < 5) {
      setTimes.push(Math.round(t1 - t0));
      waitTimes.push(Math.round(t2 - t1));
    }
    if (rafFrames % 8 === 0) {
      source.features.update('f:0', { properties: { v: rafFrames } });
      lastUpdate = rafFrames;
    }
    times.push(t2 - t0);
    rafFrames++;
  }
  const engineFrames = map.stats().frames - frames0;
  times.sort((a, b) => a - b);
  const pct = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * q))] * 10) / 10;

  map.view.set({ center: { lat: 49.9, lng: 13.9 }, zoom: 10 });
  await map.whenRendered();
  await sleep(30);
  const screen = map.view.positionToScreen({ lat: 49.9, lng: 13.9 });
  const pixel = await map.debug.samplePixel({ x: Math.round(screen.x), y: Math.round(screen.y) });
  const feature = source.features.get('f:0');
  map.destroy();

  return {
    pass:
      rafFrames >= 2 &&
      engineFrames >= 2 &&
      engineFrames >= rafFrames - 1 &&
      blue(pixel) &&
      feature !== null &&
      feature.properties.v === lastUpdate,
    detail: {
      rafFrames,
      engineFrames,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      maxMs: pct(1),
      pixel: `rgba(${pixel.r},${pixel.g},${pixel.b})`,
      updatedProperty: feature === null ? null : feature.properties.v,
      lastUpdate,
      bare,
      bareAfterMap,
      setTimes,
      waitTimes,
      visibility: document.visibilityState,
      heapStartMB: heapStart !== null && baseHeap !== null ? MB(heapStart - baseHeap) : null,
    },
  };
});

finalize();
