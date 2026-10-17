/**
 * Backend loss battery (GPU-07..10): device loss with same-backend recovery,
 * fallback switch when the primary cannot be recreated, WebGL context loss and
 * a total failure that must be announced without retry loops. The public handle,
 * view, selection, state, bindings and feature generations must survive every
 * recovery. Results: `window.__lossCheckResult`.
 */
import { createMap, crs, style as expr } from '../dist/index.js';

const RED = { r: 220, g: 38, b: 38, a: 255 };
const SIZE = 512;
const result = { checks: [], pass: false, errors: [], ms: 0, events: [] };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const oracle = await (await fetch('./tiles-svg/checks.json')).json();
const { z, x, y } = oracle.tile;
const mercator = crs.webMercator();
const worldCenter = { x: ((x + 0.5) * 256) / 2 ** z, y: ((y + 0.5) * 256) / 2 ** z };
const viewCenter = mercator.fromWorld(worldCenter);
const geoAt = (dx, dy) =>
  mercator.fromWorld({
    x: worldCenter.x + dx / 2 ** z,
    y: worldCenter.y + dy / 2 ** z,
  });

const POINTS = {
  dot: geoAt(0, -136),
  a: geoAt(-96, -56),
  b: geoAt(96, -56),
};
const DOT_SCREEN = { x: 256, y: 120 };

async function buildMainMap() {
  const map = await createMap('map-main', {
    renderer: { primary: 'webgpu', fallback: 'webgl1' },
    size: { width: SIZE, height: SIZE },
    center: viewCenter,
    zoom: z,
  });
  map.data.rasterTiles({
    id: 'tiles',
    url: './tiles-svg/{z}/{x}/{y}.svg',
    minZoom: 0,
    maxZoom: z,
  });
  map.addLayer({ id: 'tiles', type: 'raster', source: 'tiles' });
  const nodes = map.data.vector({ id: 'nodes' });
  await nodes.features.replace([
    {
      id: 'dot',
      geometry: { type: 'point', position: POINTS.dot },
      properties: { color: '#dc2626' },
    },
    { id: 'a', geometry: { type: 'point', position: POINTS.a }, properties: { color: '#2563eb' } },
    { id: 'b', geometry: { type: 'point', position: POINTS.b }, properties: { color: '#2563eb' } },
  ]);
  const links = map.data.vector({ id: 'links' });
  await links.features.replace([
    { id: 'ab', geometry: { type: 'point', position: POINTS.a }, properties: {} },
  ]);
  map.addLayer({
    id: 'nodes',
    type: 'points',
    source: 'nodes',
    style: { radiusPx: 10, color: expr.field('color') },
  });
  map.addLayer({
    id: 'links',
    type: 'lines',
    source: 'links',
    style: { color: '#0ea5e9', widthPx: 4 },
  });
  map.bindings.add({
    id: 'link-ab',
    target: links.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: nodes.features.ref('a'), to: nodes.features.ref('b') },
  });
  map.selection.set([nodes.features.ref('dot')]);
  map.state.set(nodes.features.ref('dot'), { hovered: true });
  return { map, nodes, links };
}

async function buildFailMap() {
  const map = await createMap('map-fail', {
    renderer: { primary: 'webgpu', fallback: 'webgl1' },
    size: { width: 192, height: 192 },
    center: viewCenter,
    zoom: z,
  });
  const source = map.data.vector({ id: 'pois' });
  await source.features.replace([
    { id: 'center', geometry: { type: 'point', position: viewCenter }, properties: {} },
  ]);
  map.addLayer({
    id: 'pois',
    type: 'points',
    source,
    style: { radiusPx: 8, color: '#16a34a' },
  });
  return { map, source };
}

const main = await buildMainMap();
const failing = await buildFailMap();

const mainEvents = [];
const failEvents = [];
main.map.on('backend', (event) => {
  mainEvents.push({ backend: event.backend, message: event.message });
  result.events.push({ map: 'main', backend: event.backend, message: event.message });
});
failing.map.on('backend', (event) => {
  failEvents.push({ backend: event.backend, message: event.message });
  result.events.push({ map: 'fail', backend: event.backend, message: event.message });
});

const sleepFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function waitFor(check, timeoutMs = 8000, intervalMs = 60) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function maxDelta(a, b) {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
    Math.abs(a.a - b.a),
  );
}

async function sampleMatches(map, point, expected, tolerance) {
  try {
    const pixel = await map.debug.samplePixel(point);
    return { pass: maxDelta(pixel, expected) <= tolerance, pixel };
  } catch (error) {
    return { pass: false, error: String(error) };
  }
}

function canvasCount(container) {
  return document.getElementById(container).querySelectorAll('canvas').length;
}

function sceneState(map, nodes, links) {
  const link = links.features.get('ab');
  return {
    selection: map.selection.get().map((ref) => String(ref.id)),
    hovered: map.state.get(nodes.features.ref('dot'))?.hovered ?? null,
    generation: nodes.features.ref('dot').generation ?? null,
    bindingType: link?.geometry?.type ?? null,
    bindingPoints: link?.geometry?.type === 'lineString' ? link.geometry.positions.length : 0,
    center: map.getView().center,
    zoom: map.getView().zoom,
  };
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: !!outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.checks.push({ name, pass: false, detail: String(error) });
    result.errors.push(`${name}: ${String(error)}`);
  }
}

const started = performance.now();
await sleep(600);

const expectedState = sceneState(main.map, main.nodes, main.links);
const expectedGen = main.nodes.features.ref('dot').generation ?? null;

await check('LOSS-00 starts on webgpu and renders', async () => {
  const capabilities = main.map.capabilities();
  const pixel = await waitFor(
    async () => (await sampleMatches(main.map, DOT_SCREEN, RED, 6)).pass,
    6000,
    120,
  );
  const state = sceneState(main.map, main.nodes, main.links);
  return {
    pass:
      capabilities.backend === 'webgpu' &&
      pixel &&
      state.selection.includes('dot') &&
      state.hovered === true &&
      state.bindingType === 'lineString' &&
      state.bindingPoints === 2,
    detail: { capabilities, pixel, state },
  };
});

await check('LOSS-01 raster tiles render before loss', async () => {
  const ok = await waitFor(
    async () => {
      const pixel = await main.map.debug.samplePixel({ x: 30, y: 470 });
      return pixel.a > 200;
    },
    6000,
    120,
  );
  return { pass: ok, detail: { canvasCount: canvasCount('map-main') } };
});

await check('LOSS-02 device loss recovers on the same backend (GPU-07)', async () => {
  const before = mainEvents.length;
  const beforeCanvas = canvasCount('map-main');
  main.map.debug.forceBackendLoss();
  const recovered = await waitFor(
    async () =>
      mainEvents.slice(before).some((event) => event.backend === 'webgpu') &&
      main.map.capabilities().backend === 'webgpu',
    10000,
    60,
  );
  const pixel = await waitFor(
    async () => (await sampleMatches(main.map, DOT_SCREEN, RED, 6)).pass,
    6000,
    120,
  );
  const state = sceneState(main.map, main.nodes, main.links);
  const newEvents = mainEvents.slice(before);
  return {
    pass:
      recovered &&
      pixel &&
      newEvents.length === 1 &&
      newEvents[0].backend === 'webgpu' &&
      canvasCount('map-main') === 1 &&
      state.selection.includes('dot') &&
      state.hovered === true &&
      state.generation === expectedGen &&
      state.bindingType === 'lineString' &&
      main.map.capabilities().backend === 'webgpu' &&
      beforeCanvas === 1,
    detail: { newEvents, state, pixel, canvasCount: canvasCount('map-main'), expectedGen },
  };
});

await check('LOSS-03 picking and view survive recovery', async () => {
  const hits = await main.map.query.rendered(DOT_SCREEN);
  const state = sceneState(main.map, main.nodes, main.links);
  const viewOk =
    Math.abs(state.center.lng - expectedState.center.lng) < 1e-9 &&
    Math.abs(state.center.lat - expectedState.center.lat) < 1e-9 &&
    state.zoom === expectedState.zoom;
  return {
    pass: hits.some((hit) => String(hit.feature.id) === 'dot') && viewOk,
    detail: { hits: hits.map((hit) => String(hit.feature.id)), viewOk, state },
  };
});

await check('LOSS-04 fallback switch when webgpu cannot be recreated (GPU-09)', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'gpu');
  Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined });
  try {
    const before = mainEvents.length;
    main.map.debug.forceBackendLoss();
    const recovered = await waitFor(
      async () =>
        mainEvents.slice(before).some((event) => event.backend === 'webgl1') &&
        main.map.capabilities().backend === 'webgl1',
      10000,
      60,
    );
    const pixel = await waitFor(
      async () => (await sampleMatches(main.map, DOT_SCREEN, RED, 6)).pass,
      6000,
      120,
    );
    const state = sceneState(main.map, main.nodes, main.links);
    const hits = await main.map.query.rendered(DOT_SCREEN);
    const newEvents = mainEvents.slice(before);
    return {
      pass:
        recovered &&
        pixel &&
        newEvents.length === 1 &&
        newEvents[0].backend === 'webgl1' &&
        canvasCount('map-main') === 1 &&
        state.selection.includes('dot') &&
        state.hovered === true &&
        state.generation === expectedGen &&
        state.bindingType === 'lineString' &&
        hits.some((hit) => String(hit.feature.id) === 'dot'),
      detail: { newEvents, state, pixel, hits: hits.map((hit) => String(hit.feature.id)) },
    };
  } finally {
    if (descriptor) Object.defineProperty(Navigator.prototype, 'gpu', descriptor);
  }
});

await check('LOSS-05 GL context loss recovers with the same state (GPU-08)', async () => {
  const before = mainEvents.length;
  const wasWebgl1 = main.map.capabilities().backend === 'webgl1';
  main.map.debug.forceBackendLoss();
  const recovered = await waitFor(
    async () =>
      mainEvents.slice(before).some((event) => event.backend === 'webgl1') &&
      main.map.capabilities().backend === 'webgl1',
    10000,
    60,
  );
  const pixel = await waitFor(
    async () => (await sampleMatches(main.map, DOT_SCREEN, RED, 6)).pass,
    6000,
    120,
  );
  const state = sceneState(main.map, main.nodes, main.links);
  return {
    pass:
      wasWebgl1 &&
      recovered &&
      pixel &&
      mainEvents.slice(before).length === 1 &&
      canvasCount('map-main') === 1 &&
      state.selection.includes('dot') &&
      state.bindingType === 'lineString',
    detail: { wasWebgl1, state, pixel, events: mainEvents.slice(before) },
  };
});

await check(
  'LOSS-06 pending queries during a loss settle with a defined result (GPU-07)',
  async () => {
    const pendingPick = failing.map.query.rendered({ x: 96, y: 96 });
    const pendingSample = failing.map.debug.samplePixel({ x: 96, y: 96 });
    const before = failEvents.length;
    failing.map.debug.forceBackendLoss();
    const settled = await Promise.race([
      Promise.allSettled([pendingPick, pendingSample]).then((entries) =>
        entries.map((entry) =>
          entry.status === 'fulfilled'
            ? { status: 'fulfilled' }
            : { status: 'rejected', code: entry.reason?.code ?? String(entry.reason) },
        ),
      ),
      sleep(4000).then(() => null),
    ]);
    const recovered = await waitFor(
      async () => failEvents.slice(before).some((event) => event.backend === 'webgpu'),
      10000,
      60,
    );
    const defined =
      settled !== null &&
      settled.every((entry) => entry.status === 'fulfilled' || entry.code === 'gpu-unavailable');
    return {
      pass: defined && recovered,
      detail: { settled, recovered },
    };
  },
);

await check(
  'LOSS-07 both recovery paths failing is announced without retries (GPU-10)',
  async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'gpu');
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined });
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (type === 'webgl' || type === 'experimental-webgl') return null;
      return originalGetContext.call(this, type, ...rest);
    };
    try {
      const before = failEvents.length;
      failing.map.debug.forceBackendLoss();
      const announced = await waitFor(
        async () => failEvents.slice(before).some((event) => event.backend === 'unavailable'),
        10000,
        60,
      );
      const capabilities = failing.map.capabilities();
      const notes = capabilities.notes.join(' | ');
      const settled = failEvents.length;
      await sleep(700);
      const noRetries = failEvents.length === settled;
      let pickError = null;
      try {
        await failing.map.query.rendered({ x: 96, y: 96 });
      } catch (error) {
        pickError = error?.code ?? String(error);
      }
      let sampleError = null;
      try {
        await failing.map.debug.samplePixel({ x: 96, y: 96 });
      } catch (error) {
        sampleError = error?.code ?? String(error);
      }
      return {
        pass:
          announced &&
          capabilities.backend === 'unavailable' &&
          notes.includes('webgpu recovery failed') &&
          notes.includes('webgl1 recovery failed') &&
          noRetries &&
          pickError === 'gpu-unavailable' &&
          sampleError === 'gpu-unavailable' &&
          canvasCount('map-fail') === 0,
        detail: {
          capabilities,
          noRetries,
          pickError,
          sampleError,
          canvasCount: canvasCount('map-fail'),
        },
      };
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      if (descriptor) Object.defineProperty(Navigator.prototype, 'gpu', descriptor);
    }
  },
);

result.ms = Math.round(performance.now() - started);
result.pass =
  result.errors.length === 0 &&
  result.checks.every((entry) => entry.pass) &&
  result.checks.length === 8;
window.__lossCheckResult = result;
window.__loss = { main, failing, mainEvents, failEvents };
document.title = 'loss-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
void sleepFrame;
