/**
 * MVT battery against locally generated fixtures (demo/mvt, independent Python
 * encoder). World view = multi-tile identity (a building and a road cross tile
 * borders); Prague view = layers, namespace split, labels and picking; view
 * moves = viewport unload/reload with state restore and tile-local lifetime;
 * a second source serves broken bytes to prove decode errors stay local.
 *
 * Results: `window.__mvtCheckResult`.
 */
import { createMap, crs, style as expr } from '../dist/index.js';

const TILE_WORLD = 128; // z1 tile world size; extent 4096 -> 32 local per world unit
const mercator = crs.webMercator();
const worldOf = (tx, ty, lx, ly) => ({
  x: tx * TILE_WORLD + lx / 32,
  y: ty * TILE_WORLD + ly / 32,
});
const geoOf = (world) => mercator.fromWorld(world);
const localGeo = (tx, ty, lx, ly) => geoOf(worldOf(tx, ty, lx, ly));

const PRAGUE_CENTER = geoOf({ x: 128 + 326 / 32, y: 2775 / 32 });
const TILE_0_0_CENTER = geoOf({ x: 64, y: 64 });

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const map = await createMap('map', {
  renderer: {
    primary: new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1',
    fallback: false,
  },
  size: { width: 512, height: 512 },
  center: geoOf({ x: 128, y: 128 }),
  zoom: 1.2,
});

const vt = map.data.vectorTiles({
  id: 'vt',
  url: './mvt/{z}/{x}/{y}.mvt',
  minZoom: 0,
  maxZoom: 1,
  attribution: '© Maplet MVT fixtures',
});
const broken = map.data.vectorTiles({
  id: 'vt-broken',
  url: './mvt-broken/{z}/{x}/{y}.mvt',
  minZoom: 0,
  maxZoom: 1,
});

map.addLayer({
  id: 'vt-fills',
  type: 'fills',
  source: 'vt',
  namespace: 'buildings',
  style: { fillColor: '#f59e0b', fillOpacity: 0.95, strokeColor: '#b45309', strokeWidthPx: 2 },
});
map.addLayer({
  id: 'vt-roads',
  type: 'lines',
  source: 'vt',
  namespace: 'roads',
  style: { color: '#2563eb', widthPx: 3 },
});
map.addLayer({
  id: 'vt-pois',
  type: 'points',
  source: 'vt',
  namespace: 'pois',
  style: { radiusPx: 6, color: '#dc2626', strokeColor: '#7f1d1d', strokeWidthPx: 1 },
});
map.addLayer({
  id: 'vt-labels',
  type: 'labels',
  source: 'vt',
  namespace: 'pois',
  style: { text: expr.field('name'), sizePx: 13, offsetPx: { x: 0, y: -14 }, color: '#111827' },
});

// Diagnostics hook for the check page and manual inspection.
window.__mvt = { map, vt, broken, geoOf };

const screenOfWorld = (wx, wy) => map.positionToScreen(geoOf({ x: wx, y: wy }));
const screenOfLocal = (tx, ty, lx, ly) => map.positionToScreen(localGeo(tx, ty, lx, ly));
const sampleAt = async (screen) => {
  const pixel = await map.debug.samplePixel({ x: Math.round(screen.x), y: Math.round(screen.y) });
  return [pixel.r, pixel.g, pixel.b, pixel.a];
};
const near = (pixel, expected, tolerance = 18) =>
  pixel[3] > 200 &&
  Math.max(
    Math.abs(pixel[0] - expected[0]),
    Math.abs(pixel[1] - expected[1]),
    Math.abs(pixel[2] - expected[2]),
  ) <= tolerance;

async function inkCount(cx, cy, halfWidth, halfHeight) {
  let count = 0;
  for (let y = cy - halfHeight; y <= cy + halfHeight; y++) {
    for (let x = cx - halfWidth; x <= cx + halfWidth; x++) {
      const pixel = await map.debug.samplePixel({ x, y });
      if (pixel.a > 150 && pixel.r + pixel.g + pixel.b < 420) count++;
    }
  }
  return count;
}

async function until(condition, what, timeoutMs = 20000) {
  const start = performance.now();
  while (!(await condition())) {
    if (performance.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(60);
  }
}

async function waitStats(source, pick, what, timeoutMs = 20000) {
  const start = performance.now();
  let last = null;
  for (;;) {
    last = source.snapshot();
    if (pick(last)) return last;
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `timeout waiting for ${what}; last stats: ${JSON.stringify(last.stats)}` +
          `; view: ${JSON.stringify(map.getView())}; frames: ${map.stats().frames}`,
      );
    }
    await sleep(60);
  }
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

const started = performance.now();

await check('MVT-01: one identity spans tiles, both fragments render', async () => {
  await until(() => vt.snapshot().stats.loaded.length === 4, 'four z1 tiles');
  const count = vt.features.count();
  const polygon = vt.features.get(7, { namespace: 'buildings' });
  const line = vt.features.get(8, { namespace: 'roads' });
  const halfA = await sampleAt(await screenOfWorld(110, 110));
  const halfB = await sampleAt(await screenOfWorld(140, 110));
  const ref = vt.features.ref(7, { namespace: 'buildings' });
  map.state.set(ref, { selected: true });
  map.selection.set([ref]);
  return {
    pass:
      count === 9 &&
      polygon?.geometry.type === 'multiPolygon' &&
      polygon.geometry.polygons.length === 2 &&
      line?.geometry.type === 'multiLineString' &&
      line.geometry.lines.length === 2 &&
      near(halfA, [245, 158, 11]) &&
      near(halfB, [245, 158, 11]) &&
      map.state.get(ref).selected === true &&
      map.selection.get().length === 1,
    detail: {
      count,
      polygonType: polygon?.geometry.type,
      polygons: polygon?.geometry.polygons?.length,
      lineType: line?.geometry.type,
      lines: line?.geometry.lines?.length,
      halfA,
      halfB,
      selectedOnce: map.selection.get().length,
    },
  };
});

await check('MVT-02: identical ids in source layers stay two identities', async () => {
  const road = vt.features.get(1, { namespace: 'roads' });
  const building = vt.features.get(1, { namespace: 'buildings' });
  const visible = await sampleAt(await screenOfWorld(110, 110));
  map.layers.get('vt-fills').setVisible(false);
  await sleep(250);
  const hidden = await sampleAt(await screenOfWorld(110, 110));
  map.layers.get('vt-fills').setVisible(true);
  await sleep(250);
  return {
    pass:
      road?.geometry.type === 'lineString' &&
      building?.geometry.type === 'polygon' &&
      near(visible, [245, 158, 11]) &&
      hidden[3] === 0,
    detail: {
      roadType: road?.geometry.type,
      buildingType: building?.geometry.type,
      visible,
      hidden,
    },
  };
});

await check('MVT-03: the uint64 id beyond 2^53 stays exact', async () => {
  const id = '9007199254740993';
  return {
    pass:
      vt.features.has(id, { namespace: 'roads' }) &&
      vt.features.get(id, { namespace: 'roads' })?.ref.id === id,
    detail: { ids: vt.features.ids({ namespace: 'roads' }).map(String) },
  };
});

await check('Prague zoom: layers, hole, labels and namespace picking', async () => {
  map.setView({ center: PRAGUE_CENTER, zoom: 12 });
  await waitStats(
    vt,
    (snapshot) => {
      const loaded = snapshot.stats.loaded;
      return loaded.length === 1 && loaded[0].x === 1 && loaded[0].y === 0;
    },
    'the Prague tile',
  );
  const fillScreen = await screenOfLocal(1, 0, 325.2, 2775.4);
  const fill = await sampleAt(fillScreen);
  const hole = await sampleAt(await screenOfLocal(1, 0, 324, 2774));
  const road = await sampleAt(await screenOfLocal(1, 0, 327, 2775));
  const bigRoad = await sampleAt(await screenOfLocal(1, 0, 324, 2775));
  const poi = await sampleAt(await screenOfLocal(1, 0, 324, 2774));
  const labelScreen = await screenOfLocal(1, 0, 324, 2774);
  const ink = await inkCount(Math.round(labelScreen.x), Math.round(labelScreen.y - 14), 26, 9);
  const labels = map.debug.layerLabels('vt-labels').map((entry) => entry.text);
  const hits = await map.query.rendered({
    x: Math.round(fillScreen.x),
    y: Math.round(fillScreen.y),
  });
  const fillHit = hits.find((hit) => hit.layerId === 'vt-fills');
  return {
    pass:
      near(fill, [245, 158, 11]) &&
      near(road, [37, 99, 235]) &&
      near(bigRoad, [37, 99, 235]) &&
      near(poi, [220, 38, 38]) &&
      labels.includes('Praha') &&
      labels.includes('Bez ID') &&
      ink >= 6 &&
      fillHit?.feature.id === 1 &&
      fillHit.feature.namespace === 'buildings',
    detail: { fill, hole, road, bigRoad, poi, labels, ink, fillHit: fillHit?.feature ?? null },
  };
});

await check(
  'MVT-06/04: viewport unload keeps stable-identity state, tile-local ids are new',
  async () => {
    const before = vt.features.ids({ namespace: 'pois' }).map(String);
    const localBefore = before.find((id) => id.startsWith('tl:'));
    map.state.set(vt.features.ref(1, { namespace: 'roads' }), { selected: true });
    map.state.set(vt.features.ref(localBefore, { namespace: 'pois' }), { selected: true });
    map.setView({ center: TILE_0_0_CENTER, zoom: 8 });
    await until(() => {
      const loaded = vt.snapshot().stats.loaded;
      return loaded.length === 1 && loaded[0].x === 0 && loaded[0].y === 0;
    }, 'tile 1/0/0');
    const unloaded = {
      count: vt.features.count(),
      roadGone: !vt.features.has(1, { namespace: 'roads' }),
      multiPresent: vt.features.has(7, { namespace: 'buildings' }),
    };
    map.setView({ center: PRAGUE_CENTER, zoom: 12 });
    await waitStats(vt, (snapshot) => snapshot.count === 8, 'Prague reloaded');
    const restored = map.state.get(vt.features.ref(1, { namespace: 'roads' })).selected;
    const localAfter = vt.features
      .ids({ namespace: 'pois' })
      .map(String)
      .find((id) => id.startsWith('tl:'));
    return {
      pass:
        unloaded.count === 2 &&
        unloaded.roadGone &&
        unloaded.multiPresent &&
        restored === true &&
        localAfter !== undefined &&
        localAfter !== localBefore &&
        map.state.get(vt.features.ref(localAfter, { namespace: 'pois' })).selected === false,
      detail: { unloaded, restored, localBefore, localAfter },
    };
  },
);

await check('MVT-08: broken tiles error locally, the healthy scene stays intact', async () => {
  await until(() => broken.snapshot().stats.failed >= 1, 'a broken tile counted');
  const fill = await sampleAt(await screenOfLocal(1, 0, 325.2, 2775.4));
  return {
    pass: broken.features.count() === 0 && near(fill, [245, 158, 11]),
    detail: { brokenStats: broken.snapshot().stats, brokenFeatures: broken.features.count(), fill },
  };
});

await check('MVT features behave like map features (click + hover state)', async () => {
  const element = document.getElementById('map');
  const events = [];
  map.onFeature((event) =>
    events.push(
      `${event.type}:${event.layerId}:${String(event.feature.id)}:${event.feature.namespace}`,
    ),
  );
  const point = await screenOfLocal(1, 0, 324, 2774);
  const rect = element.getBoundingClientRect();
  const fire = (type, buttons) => {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 71,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: rect.left + point.x,
        clientY: rect.top + point.y,
      }),
    );
  };
  fire('pointermove', 0);
  // Hover is scheduled per frame and resolved by a GPU pick readback: wait for
  // the state instead of a fixed delay (software rendering can take hundreds of ms).
  await until(
    () => map.state.get(vt.features.ref(10, { namespace: 'pois' })).hovered === true,
    'hover on the POI',
  );
  const hovered = true;
  fire('pointerdown', 1);
  await sleep(40);
  fire('pointerup', 0);
  await until(() => events.some((entry) => entry === 'click:vt-pois:10:pois'), 'the click event');
  return {
    pass: hovered && events.some((entry) => entry === 'click:vt-pois:10:pois'),
    detail: { hovered, events },
  };
});

await check('MVT overzoom: above maxZoom the clamped tile keeps rendering and scales', async () => {
  // The fixtures hold only z0/z1; any request above maxZoom 1 would go to a
  // missing file and raise `failed`. Place the two landmarks so both stay in
  // view, then compare their screen distance across one zoom step.
  const poiPoint = localGeo(1, 0, 324, 2774);
  const roadPoint = localGeo(1, 0, 324, 2775);
  const mid = { lat: (poiPoint.lat + roadPoint.lat) / 2, lng: (poiPoint.lng + roadPoint.lng) / 2 };
  const failedBefore = vt.snapshot().stats.failed;
  map.setView({ center: mid, zoom: 12 });
  await sleep(200);
  const screenDistance = () => {
    const a = map.positionToScreen(poiPoint);
    const b = map.positionToScreen(roadPoint);
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const distance12 = screenDistance();
  map.setView({ zoom: 13 });
  await sleep(200);
  const distance13 = screenDistance();
  const poiPixel = await sampleAt(map.positionToScreen(poiPoint));
  const roadPixel = await sampleAt(map.positionToScreen(roadPoint));
  const loaded = vt.snapshot().stats.loaded;
  const failedAfter = vt.snapshot().stats.failed;
  return {
    pass:
      loaded.length === 1 &&
      loaded[0].z === 1 &&
      loaded[0].x === 1 &&
      loaded[0].y === 0 &&
      failedAfter === failedBefore &&
      failedAfter === 0 &&
      Math.abs(distance13 / distance12 - 2) < 0.02 &&
      near(poiPixel, [220, 38, 38]) &&
      near(roadPixel, [37, 99, 235]) &&
      vt.features.has(7, { namespace: 'buildings' }),
    detail: { loaded, failedBefore, failedAfter, distance12, distance13, poiPixel, roadPixel },
  };
});

await check('LIFE-04: a settled map stops drawing and a change asks a new frame', async () => {
  await sleep(500); // let the overzoomed viewport work settle
  const settled = map.stats().frames;
  await sleep(1000);
  const stillSettled = map.stats().frames;
  map.setView({ zoom: map.getView().zoom + 0.5 });
  await until(() => map.stats().frames > stillSettled, 'the requested frame');
  const afterChange = map.stats().frames;
  await sleep(600);
  const settledAgain = map.stats().frames;
  return {
    pass: stillSettled === settled && afterChange > stillSettled && settledAgain === afterChange,
    detail: { settled, stillSettled, afterChange, settledAgain },
  };
});

await check(
  'MVT attribution: the source notice reaches the control and follows its layers',
  async () => {
    map.addControl({ kind: 'attribution', id: 'mvt-attribution' });
    const element = document.querySelector('[data-maplet-control="attribution"]');
    const text = () => element?.textContent ?? '';
    await until(() => text().includes('© Maplet MVT fixtures'), 'the notice in the control');
    const initial = text();
    const noPlaceholders = !initial.includes('undefined') && !initial.includes('null');
    // Removing every layer that references the source clears the notice...
    for (const id of ['vt-fills', 'vt-roads', 'vt-pois', 'vt-labels']) map.layers.remove(id);
    await until(() => !text().includes('© Maplet MVT fixtures'), 'the notice to clear');
    const cleared = text();
    // ...and re-adding one layer brings it back without a reload.
    map.addLayer({
      id: 'vt-fills',
      type: 'fills',
      source: 'vt',
      namespace: 'buildings',
      style: { fillColor: '#f59e0b', fillOpacity: 0.95, strokeColor: '#b45309', strokeWidthPx: 2 },
    });
    await until(() => text().includes('© Maplet MVT fixtures'), 'the notice to return');
    return {
      pass:
        noPlaceholders &&
        !cleared.includes('© Maplet MVT fixtures') &&
        text().includes('© Maplet MVT fixtures'),
      detail: { initial, cleared, restored: text() },
    };
  },
);

result.ms = Math.round(performance.now() - started);
result.pass =
  result.errors.length === 0 &&
  result.checks.length === 10 &&
  result.checks.every((entry) => entry.pass);
window.__mvtCheckResult = result;
document.title = 'mvt-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
