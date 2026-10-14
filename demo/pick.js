/**
 * PICK-12 battery: rendered picking with a limited region and candidates.
 *
 * The pick pass reads back a 5x5 device-pixel window around the pointer
 * (`PICK_RADIUS = 2`) and returns the distinct candidates found there:
 *
 * 1. target and candidates — pointer over `a` hits `a`, the neighbour `b` 3 CSS
 *    px below is a candidate, a feature `c` 6 px above is outside the window,
 *    an empty area returns nothing, `limit` caps the list, and hiding `b`
 *    leaves exactly the pointer's own target;
 * 2. measured stall — `stats().picking` matches the externally measured
 *    synchronous span of `query.rendered` and is recorded before the Promise
 *    resolves (the number is measured, not implied by the async signature);
 * 3. readback honesty — on WebGL 1 a synchronous burst of picks holds the main
 *    thread for the whole burst (a 1 ms heartbeat cannot tick during it), while
 *    a WebGPU burst awaited per pick adds measurable yield time on top of the
 *    recorded synchronous sections (the `mapAsync` readback really waits).
 *
 * Results: `window.__pickCheckResult`.
 */
import { createMap } from '../dist/index.js';

const SIZE = 512;
const PROBE = { x: 256, y: 256 };
const EMPTY = { x: 256, y: 270 };
const BURST = 40;
const backend = new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1';

const result = { checks: [], pass: false, errors: [], ms: 0, env: {} };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round3 = (value) => Math.round(value * 1000) / 1000;

let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass =
    result.errors.length === 0 && result.checks.length === 3 && result.checks.every((entry) => entry.pass);
  window.__pickCheckResult = result;
  document.title = 'pick-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
let started = performance.now();

const map = await createMap('map', {
    renderer: { primary: backend, fallback: false },
    size: { width: SIZE, height: SIZE },
    center: { lat: 50.05, lng: 14.4 }, zoom: 12
});

const toScreen = (x, y) => map.screenToPosition({ x, y });
const probes = map.data.vector({ id: 'probes' });
await probes.features.replace([
  { id: 'a', geometry: { type: 'point', position: toScreen(PROBE.x, PROBE.y) } },
  { id: 'b', geometry: { type: 'point', position: toScreen(PROBE.x, PROBE.y + 3) } },
  { id: 'c', geometry: { type: 'point', position: toScreen(PROBE.x, PROBE.y - 6) } },
]);

// A dense interactive base layer gives the pick pass realistic work (and makes
// the measured span comfortably above the clock resolution); the neighbourhood
// of the probe stays clear so the candidates there are known.
const grid = map.data.vector({ id: 'grid' });
const gridFeatures = [];
for (let y = 12; y <= SIZE - 12; y += 16) {
  for (let x = 12; x <= SIZE - 12; x += 16) {
    if (Math.hypot(x - PROBE.x, y - PROBE.y) < 30) continue;
    gridFeatures.push({ id: `g${gridFeatures.length}`, geometry: { type: 'point', position: toScreen(x, y) } });
  }
}
await grid.features.replace(gridFeatures);

map.addLayer({
  id: 'grid-layer',
  type: 'points',
  source: 'grid',
  interactive: true ,
  style: { radiusPx: 1, color: '#2563eb' },
});
const layer = map.addLayer({
  id: 'probes-layer',
  type: 'points',
  source: 'probes',
  interactive: true ,
  style: { radiusPx: 2, color: '#dc2626' },
});

const refB = probes.features.ref('b');
await map.whenRendered(map.stats().revision);

result.env = {
  backend: map.capabilities().backend,
  dpr: window.devicePixelRatio,
  features: map.stats().features,
  grid: gridFeatures.length,
  burst: BURST,
};

const ids = (hits) => hits.map((hit) => hit.feature.id);

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.errors.push(`${name}: ${String(error)}`);
    result.checks.push({ name, pass: false, detail: String(error) });
  }
}

await check('PICK-12 target, candidates, limit and window', async () => {
  const full = ids(await map.query.rendered(PROBE, { limit: 8 }));
  const two = ids(await map.query.rendered(PROBE, { limit: 2 }));
  const one = ids(await map.query.rendered(PROBE, { limit: 1 }));
  const empty = ids(await map.query.rendered(EMPTY, { limit: 8 }));
  // With the neighbour hidden only the pointer's own target may remain.
  layer.setFeatureStyle(refB, { visible: false });
  await map.whenRendered(map.stats().revision);
  const isolated = ids(await map.query.rendered(PROBE, { limit: 8 }));
  layer.clearFeatureStyle(refB);
  await map.whenRendered(map.stats().revision);
  return {
    pass:
      [...full].sort().join(',') === 'a,b' &&
      two.length === 2 &&
      one.length === 1 &&
      empty.length === 0 &&
      isolated.join(',') === 'a',
    detail: { full, limitedTo2: two, limitedTo1: one, empty, isolated },
  };
});

await check('PICK-12 stall measurement matches the synchronous span', async () => {
  const before = map.stats().picking;
  const t0 = performance.now();
  const pending = map.query.rendered(PROBE, { limit: 4 });
  const t1 = performance.now();
  const atCall = map.stats().picking;
  const hits = await pending;
  const after = map.stats().picking;
  const span = t1 - t0;
  return {
    pass:
      atCall.picks === before.picks + 1 &&
      after.picks === atCall.picks &&
      after.lastMs === atCall.lastMs &&
      atCall.readback === (backend === 'webgpu' ? 'async' : 'blocking') &&
      // A blocking `readPixels` always takes measurable time; a WebGPU
      // submission may stay under the 100 µs `performance.now()` resolution.
      (atCall.lastMs > 0 || backend === 'webgpu') &&
      atCall.lastMs <= span + 0.5 &&
      span - atCall.lastMs < 3 &&
      atCall.lastReadMs <= atCall.lastMs &&
      atCall.maxMs >= atCall.lastMs &&
      atCall.maxReadMs >= atCall.lastReadMs &&
      hits.length === 2,
    detail: {
      syncSpanMs: round3(span),
      recordedMs: round3(atCall.lastMs),
      recordedReadMs: round3(atCall.lastReadMs),
      readback: atCall.readback,
      hits: ids(hits),
    },
  };
});

await check('PICK-12 the Promise does not hide the readback', async () => {
  // 1 ms heartbeat: its largest gap shows how long the main thread was blocked.
  let lastTick = performance.now();
  let heartbeatGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    heartbeatGap = Math.max(heartbeatGap, now - lastTick);
    lastTick = now;
  }, 1);
  await sleep(60);
  const before = map.stats().picking;
  const t0 = performance.now();
  let span;
  if (backend === 'webgl1') {
    // One synchronous burst: every pick blocks to completion inside its call,
    // so no timer callback can run until the whole burst finishes.
    const pending = [];
    for (let i = 0; i < BURST; i++) pending.push(map.query.rendered(PROBE, { limit: 4 }));
    span = performance.now() - t0;
    await Promise.all(pending);
  } else {
    // Awaited per pick: each call blocks only for its synchronous section and
    // the readback wait yields to the event loop.
    for (let i = 0; i < BURST; i++) await map.query.rendered(PROBE, { limit: 4 });
    span = performance.now() - t0;
  }
  const stats = map.stats().picking;
  const recorded = stats.totalMs - before.totalMs;
  const picks = stats.picks - before.picks;
  await sleep(60);
  clearInterval(timer);
  if (backend === 'webgl1') {
    return {
      pass:
        picks === BURST &&
        span >= 1.5 &&
        heartbeatGap >= span - 1 &&
        recorded >= span * 0.5 &&
        recorded <= span + 1,
      detail: {
        burst: BURST,
        burstSpanMs: round3(span),
        recordedTotalMs: round3(recorded),
        heartbeatGapMs: round3(heartbeatGap),
        readback: stats.readback,
      },
    };
  }
  return {
    pass: picks === BURST && recorded > 0 && span - recorded > 0.5,
    detail: {
      burst: BURST,
      wallMs: round3(span),
      recordedTotalMs: round3(recorded),
      yieldMs: round3(span - recorded),
      heartbeatGapMs: round3(heartbeatGap),
      readback: stats.readback,
    },
  };
});

finalize();
