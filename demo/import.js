/**
 * Import battery (IO-05..IO-11, LIFE-09): a real module worker prepares
 * columnar batches and GeoJSON; the page verifies strict validation before
 * publication, copy/move buffer ownership, abort before and during the worker
 * flight (late replies never publish), bounded queue backpressure, that
 * imported identity drives get, hit-testing, update and export, and that
 * line/polygon altitudes survive preparation, rendering and export. Results:
 * `window.__importCheckResult`.
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
    result.checks.length === 9 &&
    result.checks.every((entry) => entry.pass);
  window.__importCheckResult = result;
  document.title = 'import-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
let started = 0;

const map = await createMap('map', {
  renderer:
    new URLSearchParams(location.search).get('backend') === 'webgpu'
      ? { primary: 'webgpu', fallback: false }
      : { primary: 'webgl1', fallback: false },
  size: { width: 640, height: 480 },
  center: { lat: 50, lng: 14.05 },
  zoom: 10,
});

window.__importMap = map;
const marks = map.data.vector({ id: 'marks' });
map.addLayer({
  id: 'marks',
  type: 'points',
  source: marks,
  style: { radiusPx: 7, color: '#2563eb' },
  interactive: true,
});
map.addLayer({
  id: 'marks-lines',
  type: 'lines',
  source: marks,
  style: { color: '#16724c', widthPx: 3 },
});

/* --------------------------------- helpers -------------------------------- */

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: !!outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.checks.push({ name, pass: false, detail: String(error) });
    result.errors.push(`${name}: ${String(error)}`);
  }
}

const sample = (x, y) => map.debug.samplePixel({ x, y });
const describe = (pixel) => `rgba(${pixel.r},${pixel.g},${pixel.b},${pixel.a})`;
const blue = (pixel) => pixel.b > 180 && pixel.r < 90 && pixel.g < 160;
const green = (pixel) => pixel.g > 80 && pixel.r < 90 && pixel.b < 130;
const pixelAt = async (position) => {
  const screen = map.positionToScreen(position);
  return sample(Math.round(screen.x), Math.round(screen.y));
};
const rejectionOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return { code: error.code, reason: error.detail?.reason, revision: error.detail?.revision };
  }
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

const startedMark = performance.now();
started = startedMark;

await check('IO-05 worker columnar replace draws 5000 points', async () => {
  const batch = pointGrid(5000, 100, 49.95, 13.95, 0.004, 0.006);
  const commit = await marks.importColumnar(batch);
  await map.whenRendered(commit.revision);
  const count = marks.features.count();
  const imports = map.debug.imports();
  const pixel = await pixelAt({ lat: 49.95, lng: 13.95 });
  const exported = marks.exportGeoJson();
  const spot = exported.features[4999];
  const spotLat = spot.geometry.coordinates[1];
  return {
    pass:
      count === 5000 &&
      imports.backend === 'worker' &&
      imports.used.worker >= 1 &&
      blue(pixel) &&
      exported.features.length === 5000 &&
      Math.abs(spotLat - (49.95 + 49 * 0.004)) < 1e-9 &&
      spot.properties.index === 4999,
    detail: { count, imports, pixel: describe(pixel), spotLat },
  };
});

await check('IO-05 malformed batches are refused before publication', async () => {
  const before = marks.features.count();
  const cases = [
    ['odd positions', { kind: 'point', positions: Float64Array.of(1, 2, 3) }],
    ['plain array', { kind: 'point', positions: [1, 2] }],
    ['NaN coordinate', { kind: 'point', positions: Float64Array.of(1, Number.NaN) }],
    ['ids length', { kind: 'point', positions: Float64Array.of(1, 2, 3, 4), ids: ['only-one'] }],
    [
      'point with offsets',
      { kind: 'point', positions: Float64Array.of(1, 2), partOffsets: Int32Array.of(0, 1) },
    ],
    [
      'offsets past the buffer',
      {
        kind: 'lineString',
        positions: Float64Array.of(0, 0, 1, 1),
        partOffsets: Int32Array.of(0, 9),
      },
    ],
    [
      'feature offsets past the parts',
      {
        kind: 'polygon',
        positions: Float64Array.of(0, 0, 1, 0, 1, 1),
        partOffsets: Int32Array.of(0, 3),
        featurePartOffsets: Int32Array.of(0, 4),
      },
    ],
    [
      'altitudes length',
      { kind: 'point', positions: Float64Array.of(1, 2), altitudes: Float64Array.of(1, 2) },
    ],
    ['unknown kind', { kind: 'circle', positions: Float64Array.of(1, 2) }],
  ];
  const outcomes = [];
  for (const [label, batch] of cases) {
    const rejection = await rejectionOf(marks.importColumnar(batch));
    outcomes.push([label, rejection?.code ?? 'resolved', typeof rejection?.revision]);
  }
  const allInvalid = outcomes.every(([, code]) => code === 'import-invalid');
  const allTagged = outcomes.every(([, , revision]) => revision === 'number');
  const after = marks.features.count();
  return {
    pass: allInvalid && allTagged && after === before && map.debug.imports().pending === 0,
    detail: { outcomes, before, after },
  };
});

await check('IO-06 default copy keeps the caller buffer usable', async () => {
  const positions = Float64Array.of(14.0, 50.0, 14.01, 50.01);
  const batch = { kind: 'point', positions, ids: ['copy-a', 'copy-b'] };
  await marks.importColumnar(batch);
  const byteLengthAfter = positions.byteLength;
  const before = marks.features.get('copy-a').geometry.position.lng;
  positions[0] = 15; // mutate the caller's buffer after the import
  const after = marks.features.get('copy-a').geometry.position.lng;
  await marks.importColumnar(batch); // the same buffer is still usable for another import
  const reimported = marks.features.get('copy-a').geometry.position.lng;
  return {
    pass:
      byteLengthAfter === 32 &&
      Math.abs(before - 14) < 1e-9 &&
      Math.abs(after - 14) < 1e-9 &&
      Math.abs(reimported - 15) < 1e-9,
    detail: { byteLengthAfter, before, after, reimported },
  };
});

await check('IO-07 an explicit move import detaches the batch buffers', async () => {
  const grid = pointGrid(200, 20, 49.9, 13.9, 0.005, 0.008);
  const altitudes = new Float64Array(200).fill(120);
  const points = { kind: 'point', positions: grid.positions, altitudes, ids: grid.ids };
  const commit = await marks.importColumnar(points, { copy: false });
  const detached = points.positions.byteLength === 0 && altitudes.byteLength === 0;
  const polygon = {
    kind: 'polygon',
    positions: Float64Array.of(0, 0, 2, 0, 2, 2, 0, 2),
    partOffsets: Int32Array.of(0, 4),
  };
  await marks.importColumnar(polygon, { copy: false, mode: 'append' });
  const polyDetached = polygon.positions.byteLength === 0 && polygon.partOffsets.byteLength === 0;
  await map.whenRendered(commit.revision);
  const pixel = await pixelAt({ lat: 49.9, lng: 13.9 });
  return {
    pass: detached && polyDetached && marks.features.count() === 201 && blue(pixel),
    detail: { detached, polyDetached, count: marks.features.count(), pixel: describe(pixel) },
  };
});

await check('IO-09 aborting queued and mid-flight imports publishes nothing', async () => {
  const events = [];
  const unsubscribe = marks.subscribe((snapshot) => {
    if (!snapshot.initial) events.push(snapshot.revision);
  });
  // (a) a queued job aborted before it starts
  const busy = marks.importColumnar(pointGrid(50_000, 400, 49.7, 13.7, 0.0005, 0.0005));
  const queuedController = new AbortController();
  const queued = marks.importColumnar(pointGrid(50, 10, 50, 14, 0.001, 0.001), {
    signal: queuedController.signal,
  });
  queuedController.abort();
  const queuedResult = await rejectionOf(queued);
  await busy;
  const countAfterBusy = marks.features.count();
  // (b) a job aborted while the worker prepares it (same tick as the submit)
  const flightController = new AbortController();
  const flight = marks.importColumnar(pointGrid(50_000, 400, 49.8, 13.8, 0.0005, 0.0005), {
    signal: flightController.signal,
  });
  flightController.abort();
  const flightResult = await rejectionOf(flight);
  const eventsAfterAbort = events.length;
  const usedAfterAbort = map.debug.imports().used.worker;
  await sleep(700); // the worker finishes the aborted job; its late reply must be dropped
  const countAfterWait = marks.features.count();
  const usedAfterWait = map.debug.imports().used.worker;
  const lateReplyIgnored =
    countAfterWait === countAfterBusy &&
    events.length === eventsAfterAbort &&
    usedAfterWait === usedAfterAbort;
  // The worker survived and serves the next import.
  await marks.importColumnar(pointGrid(10, 10, 50, 14, 0.001, 0.001));
  const after = map.debug.imports();
  unsubscribe();
  return {
    pass:
      queuedResult?.code === 'aborted' &&
      queuedResult.reason === 'aborted' &&
      typeof queuedResult.revision === 'number' &&
      flightResult?.code === 'aborted' &&
      typeof flightResult.revision === 'number' &&
      lateReplyIgnored &&
      after.pending === 0 &&
      after.used.worker === usedAfterWait + 1 &&
      marks.features.count() === 10,
    detail: {
      queuedResult,
      flightResult,
      countAfterBusy,
      countAfterWait,
      usedAfterAbort,
      usedAfterWait,
      events: events.length,
      after,
    },
  };
});

await check('LIFE-09 the import queue is bounded with explicit backpressure', async () => {
  const active = marks.importColumnar(pointGrid(50_000, 400, 49.6, 13.6, 0.0005, 0.0005));
  const queued = [
    marks.importColumnar(pointGrid(1000, 40, 50.0, 14.0, 0.001, 0.001)),
    marks.importColumnar(pointGrid(1000, 40, 50.1, 14.0, 0.001, 0.001)),
    marks.importColumnar(pointGrid(1000, 40, 50.2, 14.0, 0.001, 0.001)),
    marks.importColumnar(pointGrid(1000, 40, 50.3, 14.0, 0.001, 0.001)),
  ];
  const pendingWhileQueued = map.debug.imports().pending;
  const overflow = await rejectionOf(marks.importColumnar(pointGrid(10, 10, 50, 14, 0.001, 0.001)));
  await Promise.all([active, ...queued]);
  const drained = map.debug.imports().pending;
  return {
    pass:
      pendingWhileQueued === 5 &&
      overflow?.code === 'aborted' &&
      overflow.reason === 'queue-full' &&
      drained === 0 &&
      marks.features.count() === 1000,
    detail: { pendingWhileQueued, overflow, drained, count: marks.features.count() },
  };
});

await check('GeoJSON imports run through the same worker pipeline', async () => {
  const features = Array.from({ length: 2000 }, (_, i) => ({
    type: 'Feature',
    id: `g${i}`,
    geometry: {
      type: 'Point',
      coordinates: [13.9 + (i % 100) * 0.003, 49.9 + Math.floor(i / 100) * 0.006],
    },
    properties: { index: i },
  }));
  const before = map.debug.imports().used.worker;
  const commit = await marks.importGeoJson(JSON.stringify({ type: 'FeatureCollection', features }));
  await map.whenRendered(commit.revision);
  const usedWorker = map.debug.imports().used.worker;
  const pixel = await pixelAt({ lat: 49.9, lng: 13.9 });
  const bad = await rejectionOf(marks.importGeoJson('{ not json'));
  const aborted = await (async () => {
    const controller = new AbortController();
    const controllerPromise = marks.importGeoJson(
      JSON.stringify({ type: 'FeatureCollection', features: features.slice(0, 2000) }),
      { signal: controller.signal },
    );
    controller.abort();
    return rejectionOf(controllerPromise);
  })();
  await sleep(300);
  return {
    pass:
      usedWorker > before &&
      marks.features.count() === 2000 &&
      blue(pixel) &&
      bad?.code === 'import-invalid' &&
      aborted?.code === 'aborted',
    detail: {
      before,
      usedWorker,
      count: marks.features.count(),
      pixel: describe(pixel),
      bad,
      aborted,
    },
  };
});

await check('imported identity drives get, query.at, update and export', async () => {
  const batch = {
    kind: 'point',
    positions: Float64Array.of(14.02, 50.02, 14.04, 50.03),
    ids: [7, 42],
    properties: [{ name: 'seven' }, { name: 'forty-two' }],
  };
  const commit = await marks.importColumnar(batch);
  await map.whenRendered(commit.revision);
  const got = marks.features.get(7);
  const screen = map.positionToScreen({ lat: 50.02, lng: 14.02 });
  const hits = await map.query.rendered(screen);
  const exported = marks.exportGeoJson({ ids: [7] });
  await marks.features.update(7, {
    geometry: { type: 'point', position: { lat: 50.04, lng: 14.06 } },
  });
  await map.whenRendered(map.stats().revision);
  const oldPixel = await pixelAt({ lat: 50.02, lng: 14.02 });
  const newPixel = await pixelAt({ lat: 50.04, lng: 14.06 });
  return {
    pass:
      got?.properties.name === 'seven' &&
      hits[0]?.feature.id === 7 &&
      exported.features.length === 1 &&
      exported.features[0].id === 7 &&
      Math.abs(exported.features[0].geometry.coordinates[0] - 14.02) < 1e-9 &&
      blue(newPixel) &&
      !blue(oldPixel),
    detail: {
      name: got?.properties.name,
      hit: hits[0]?.feature.id,
      exported: exported.features[0],
      oldPixel: describe(oldPixel),
      newPixel: describe(newPixel),
    },
  };
});

await check('IO-05 line and polygon altitudes survive the worker round trip', async () => {
  const before = map.debug.imports().used.worker;
  const trail = {
    kind: 'lineString',
    positions: Float64Array.of(13.98, 49.98, 14.0, 50.0, 14.02, 49.98),
    altitudes: Float64Array.of(210, Number.NaN, 240),
    partOffsets: Int32Array.of(0, 3),
    ids: ['trail'],
  };
  const commit = await marks.importColumnar(trail, { copy: false });
  const trailDetached = trail.positions.byteLength === 0 && trail.altitudes.byteLength === 0;
  // Up, right, down, left: the world-space winding keeps this order and its altitudes.
  const ridge = {
    kind: 'polygon',
    positions: Float64Array.of(14.06, 49.98, 14.06, 50.0, 14.08, 50.0, 14.08, 49.98),
    altitudes: Float64Array.of(300, 320, 340, 360),
    partOffsets: Int32Array.of(0, 4),
    ids: ['ridge'],
  };
  await marks.importColumnar(ridge, { mode: 'append' });
  await map.whenRendered(map.stats().revision);
  const trailGeometry = marks.features.get('trail').geometry;
  const ridgeGeometry = marks.features.get('ridge').geometry;
  const exported = marks.exportGeoJson();
  const trailCoordinates = exported.features.find((feature) => feature.id === 'trail').geometry
    .coordinates;
  const ridgeCoordinates = exported.features.find((feature) => feature.id === 'ridge').geometry
    .coordinates;
  const imports = map.debug.imports();
  const pixel = await pixelAt({ lat: 50.0, lng: 14.0 });
  const trailAltitudes = trailGeometry.positions.map((position) => position.altitude ?? null);
  const ridgeAltitudes = ridgeGeometry.rings[0].map((position) => position.altitude ?? null);
  return {
    pass:
      imports.backend === 'worker' &&
      imports.used.worker === before + 2 &&
      String(commit.revision).length > 0 &&
      trailDetached &&
      trailAltitudes.join(',') === '210,,240' &&
      ridgeAltitudes.join(',') === '300,320,340,360,300' &&
      trailCoordinates[0].length === 3 &&
      trailCoordinates[0][2] === 210 &&
      trailCoordinates[1].length === 2 &&
      trailCoordinates[2][2] === 240 &&
      ridgeCoordinates[0][0][2] === 300 &&
      ridgeCoordinates[0][4][2] === 300 &&
      green(pixel),
    detail: {
      imports,
      served: imports.used.worker - before,
      trailDetached,
      trailAltitudes,
      ridgeAltitudes,
      trailCoordinates,
      ridgeCoordinates,
      pixel: describe(pixel),
    },
  };
});

finalize();
if (new URLSearchParams(location.search).get('keep') !== '1') {
  map.destroy();
}
