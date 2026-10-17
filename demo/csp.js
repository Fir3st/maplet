/**
 * CSP / bundler fallback battery: the import worker is blocked
 * (`Content-Security-Policy: worker-src 'none'`, served by `demo/serve.py` for
 * `?csp=worker-none`; a bundler that leaves `new URL(…, import.meta.url)`
 * alone ends up in the same state). The pipeline must surface the failure
 * explicitly on the first preparation (`worker-failed`), then prepare every
 * later import inline and stay inline — never a silent half-published import.
 * Results: `window.__cspCheckResult`.
 */
import { createMap } from '../dist/index.js';

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass =
    result.errors.length === 0 &&
    result.checks.length === 4 &&
    result.checks.every((entry) => entry.pass);
  window.__cspCheckResult = result;
  document.title = 'csp-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
const started = performance.now();

/** True when the page actually runs under the blocking CSP. */
async function workerBlocked() {
  try {
    const probe = new Worker(new URL('../dist/workers/import.worker.js', location.href), {
      type: 'module',
    });
    const blocked = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        probe.terminate();
        resolve(false);
      }, 700);
      probe.addEventListener('error', () => {
        clearTimeout(timer);
        probe.terminate();
        resolve(true);
      });
    });
    return blocked;
  } catch {
    return true;
  }
}

const blocked = await workerBlocked();

const map = await createMap('map', {
  renderer:
    new URLSearchParams(location.search).get('backend') === 'webgpu'
      ? { primary: 'webgpu', fallback: false }
      : { primary: 'webgl1', fallback: false },
  size: { width: 420, height: 320 },
  center: { lat: 50, lng: 14.05 },
  zoom: 10,
});
const source = map.data.vector({ id: 'marks' });
map.addLayer({
  id: 'marks',
  type: 'points',
  source,
  style: { radiusPx: 6, color: '#2563eb' },
  interactive: true,
});

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
const describe = (pixel) => `rgba(${pixel.r},${pixel.g},${pixel.b},${pixel.a})`;
const pixelAt = async (position) => {
  const screen = map.positionToScreen(position);
  return map.debug.samplePixel({ x: Math.round(screen.x), y: Math.round(screen.y) });
};

/** Row-major grid of `count` points; positions are flat `x = lng, y = lat`. */
function pointGrid(count, columns, lat0, lng0, dLat, dLng) {
  const positions = new Float64Array(count * 2);
  const ids = new Array(count);
  const properties = new Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = lng0 + (i % columns) * dLng;
    positions[i * 2 + 1] = lat0 + Math.floor(i / columns) * dLat;
    ids[i] = `p:${i}`;
    properties[i] = { index: i };
  }
  return { kind: 'point', positions, ids, properties };
}

await check('CSP-00 the page runs under worker-src none', async () => ({
  pass: blocked,
  detail: {
    blocked,
    hint: 'open this battery as ?csp=worker-none (the dev server sends the header)',
  },
}));

await check('CSP-01 the blocked worker fails the first preparation explicitly', async () => {
  const outcome = await source.importColumnar(pointGrid(200, 20, 49.98, 13.98, 0.004, 0.006)).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, code: error.code, reason: error.detail?.reason }),
  );
  const imports = map.debug.imports();
  return {
    pass: !outcome.ok && outcome.code === 'worker-failed' && imports.backend === 'inline',
    detail: { outcome, imports },
  };
});

await check('CSP-02 the inline fallback publishes correct data', async () => {
  const commit = await source.importColumnar(pointGrid(300, 30, 49.98, 13.98, 0.004, 0.006));
  await map.whenRendered(commit.revision);
  await sleep(50);
  const imports = map.debug.imports();
  const count = source.features.count();
  const pixel = await pixelAt({ lat: 49.98, lng: 13.98 });
  return {
    pass:
      count === 300 &&
      imports.backend === 'inline' &&
      imports.used.worker === 0 &&
      imports.used.inline >= 1 &&
      blue(pixel),
    detail: { count, imports, pixel: describe(pixel) },
  };
});

await check('CSP-03 inline stays permanent for later imports', async () => {
  const commit = await source.importColumnar(pointGrid(120, 12, 49.99, 14.0, 0.004, 0.006));
  await map.whenRendered(commit.revision);
  const imports = map.debug.imports();
  return {
    pass:
      imports.backend === 'inline' &&
      imports.used.worker === 0 &&
      imports.used.inline >= 2 &&
      source.features.count() === 120,
    detail: { imports, count: source.features.count() },
  };
});

finalize();
