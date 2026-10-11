/**
 * WMS battery: real GetMap images over HTTP from the deterministic `/wms`
 * fixture in `demo/serve.py` (an independent Python implementation of the WMS
 * semantics), plus `?mode=live` against a public WMS.
 *
 * The fixture encodes the *interpreted* geography: red follows longitude, green
 * latitude, blue carries the request identity (+32 version 1.3.0, +64 projected
 * CRS, +16 CRS:84, 255 for `layers` containing `alt`) and `MARK=lng,lat` paints
 * a magenta square. Sampling GPU pixels therefore proves the whole path: BBOX
 * axis order and units, URL parameters, fetch, decode, placement, the hold/swap
 * behaviour on parameter changes and the bitmap's interactive area.
 *
 * Results: `window.__wmsCheckResult`.
 */
import { createMap } from '../dist/index.js';

const SIZE = 512;
const CENTER = { lat: 50.05, lng: 14.4 };
const ZOOM = 12;
const TOL = 6;
const MARKER = [255, 0, 255];
const GRADIENT_POINTS = [
  { x: 80, y: 80 },
  { x: 432, y: 80 },
  { x: 80, y: 432 },
  { x: 432, y: 432 },
];
const MARK_POINT = { x: 256, y: 256 };
const OFF_MARK = { x: 304, y: 256 };

const query = new URLSearchParams(location.search);
const backend = query.get('backend') === 'webgpu' ? 'webgpu' : 'webgl1';
const mode = query.get('mode') ?? 'fixture';
const live = mode === 'live';

const result = { checks: [], pass: false, errors: [], ms: 0, mode, backend };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expectedChecks = live ? 1 : 6;

let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass =
    result.errors.length === 0 &&
    result.checks.length === expectedChecks &&
    result.checks.every((entry) => entry.pass);
  window.__wmsCheckResult = result;
  document.title = 'wms-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${mode} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
let started = performance.now();

const map = await createMap({
  container: 'map',
  renderer: { primary: backend, fallback: false },
  size: { width: SIZE, height: SIZE },
  view: { center: CENTER, zoom: ZOOM },
});

const bounds = map.view.getBounds();
const mark = `${CENTER.lng},${CENTER.lat}`;
const source = map.sources.wms({
  id: 'wms',
  url: live ? 'https://ows.terrestris.de/osm/service' : '/wms',
  layers: live ? 'OSM-WMS' : 'roads',
  version: '1.1.1',
  crs: 'EPSG:4326',
  attribution: live ? '© terrestris GmbH & Co. KG, OpenStreetMap contributors' : '© Maplet WMS fixtures',
  ...(live ? {} : { params: { MARK: mark } }),
});
map.layers.add({ id: 'wms-layer', type: 'raster', source, interaction: { enabled: true } });

if (!live) {
  const hotspots = map.sources.vector({ id: 'hotspots' });
  await hotspots.features.replace([
    { id: 'hotspot-a', geometry: { type: 'point', position: map.view.screenToPosition({ x: 150, y: 120 }) } },
  ]);
  map.layers.add({
    id: 'hotspots',
    type: 'points',
    source: hotspots,
    interaction: { enabled: true },
    style: { radiusPx: 6, color: '#f59e0b' },
  });
}

const sample = async (point) => {
  const pixel = await map.debug.samplePixel(point);
  return [pixel.r, pixel.g, pixel.b, pixel.a];
};
const channelDelta = (pixel, expected) =>
  Math.max(Math.abs(pixel[0] - expected[0]), Math.abs(pixel[1] - expected[1]), Math.abs(pixel[2] - expected[2]));

async function until(check, timeoutMs = 15000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/** The fixture's blue channel for the active request identity. */
function expectedBlue(state) {
  let blue = state.alt ? 255 : 0;
  if (state.version === '1.3.0') blue += 32;
  if (state.projected) blue += 64;
  if (state.crs === 'CRS:84') blue += 16;
  return Math.min(255, blue);
}

function expectedColor(point, state) {
  const position = map.view.screenToPosition(point);
  const red = Math.round(
    (255 * (position.lng - bounds.southwest.lng)) / (bounds.northeast.lng - bounds.southwest.lng),
  );
  const green = Math.round(
    (255 * (position.lat - bounds.southwest.lat)) / (bounds.northeast.lat - bounds.southwest.lat),
  );
  return [red, green, expectedBlue(state)];
}

/** Geography check: four gradient corners plus the marker and its absence. */
async function verifyGeography(state) {
  const samples = [];
  for (const point of GRADIENT_POINTS) {
    const pixel = await sample(point);
    const expected = expectedColor(point, state);
    samples.push({ point, pixel, expected, delta: channelDelta(pixel, expected) });
  }
  const marker = await sample(MARK_POINT);
  const off = await sample(OFF_MARK);
  return {
    pass:
      samples.every((entry) => entry.delta <= TOL) &&
      channelDelta(marker, MARKER) <= TOL &&
      channelDelta(off, MARKER) > 40,
    detail: { samples, marker, off },
  };
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

if (live) {
  await check('WMS live public GetMap image renders', async () => {
    const loaded = await until(async () => (await sample(MARK_POINT))[3] === 255, 20000);
    const samples = [];
    for (const point of [...GRADIENT_POINTS, MARK_POINT]) samples.push(await sample(point));
    const distinct = new Set(samples.map((pixel) => pixel.join(','))).size;
    return {
      pass: loaded !== null && distinct >= 3,
      detail: { loaded: loaded !== null, distinct, samples },
    };
  });
  finalize();
} else {
  let state = { version: '1.1.1', crs: 'EPSG:4326', projected: false, alt: false };

  await check('WMS-01 WMS 1.1.1 EPSG:4326 image and geography', async () => {
    const loaded = await until(async () => channelDelta(await sample(MARK_POINT), MARKER) <= TOL);
    const geography = await verifyGeography(state);
    return {
      pass: loaded !== null && geography.pass,
      detail: { loaded: loaded !== null, ...geography.detail },
    };
  });

  await check('WMS-02 WMS 1.3.0 axis order: EPSG:4326 versus CRS:84', async () => {
    state = { ...state, version: '1.3.0' };
    source.update({ version: '1.3.0' });
    const swapped = await until(async () => (await sample(OFF_MARK))[2] === expectedBlue(state));
    const epsg = await verifyGeography(state);
    state = { ...state, crs: 'CRS:84' };
    source.update({ crs: 'CRS:84' });
    const crs84 = await until(async () => (await sample(OFF_MARK))[2] === expectedBlue(state));
    const crs84Geography = await verifyGeography(state);
    return {
      pass: swapped !== null && epsg.pass && crs84 !== null && crs84Geography.pass,
      detail: {
        swapped: swapped !== null,
        epsg4326: epsg.pass,
        crs84: crs84 !== null,
        crs84Geography: crs84Geography.pass,
        marker: epsg.detail.marker,
        offMarker: epsg.detail.off,
      },
    };
  });

  await check('WMS-03 EPSG:3857 projected metres in both versions', async () => {
    state = { version: '1.3.0', crs: 'EPSG:3857', projected: true, alt: false };
    source.update({ crs: 'EPSG:3857' });
    const modern = await until(async () => (await sample(OFF_MARK))[2] === expectedBlue(state));
    const modernGeography = await verifyGeography(state);
    state = { ...state, version: '1.1.1' };
    source.update({ version: '1.1.1' });
    const legacy = await until(async () => (await sample(OFF_MARK))[2] === expectedBlue(state));
    const legacyGeography = await verifyGeography(state);
    return {
      pass: modern !== null && modernGeography.pass && legacy !== null && legacyGeography.pass,
      detail: {
        modern: modernGeography.pass,
        legacy: legacyGeography.pass,
        modernSamples: modernGeography.detail.samples,
        legacyMarker: legacyGeography.detail.marker,
      },
    };
  });

  await check('WMS-04 special characters survive the real GetMap request', async () => {
    state = { version: '1.1.1', crs: 'EPSG:4326', projected: false, alt: false };
    source.update({ version: '1.1.1', crs: 'EPSG:4326' });
    source.setParams({ layers: 'roads & rails/1', styles: 'bold red', time: '2026-10-10' });
    const swapped = await until(async () => (await sample(OFF_MARK))[2] === expectedBlue(state));
    const url = map.debug.layerTiles('wms-layer')[0]?.url ?? '';
    const parsed = new URL(url, location.href);
    const decoded = {
      layers: parsed.searchParams.get('layers'),
      styles: parsed.searchParams.get('styles'),
      time: parsed.searchParams.get('time'),
      srs: parsed.searchParams.get('srs'),
      version: parsed.searchParams.get('version'),
    };
    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const expected = {
      layers: 'roads & rails/1',
      styles: 'bold red',
      time: '2026-10-10',
      srs: 'EPSG:4326',
      version: '1.1.1',
    };
    const geography = await verifyGeography(state);
    return {
      pass:
        swapped !== null &&
        response.ok &&
        png &&
        JSON.stringify(decoded) === JSON.stringify(expected) &&
        geography.pass,
      detail: { decoded, status: response.status, png, geography: geography.pass },
    };
  });

  await check('WMS-05 setParams: held bitmap, fast swap, late response discarded', async () => {
    const baseline = expectedColor(OFF_MARK, { version: '1.1.1', crs: 'EPSG:4326', projected: false, alt: false });
    const t0 = performance.now();
    // A slow request starts; the previous bitmap must stay visible meanwhile.
    source.update({ params: { delay: '700', MARK: mark } });
    source.setParams({ layers: 'slow' });
    await sleep(150);
    const held = await sample(OFF_MARK);
    // A fast replacement arrives while the slow request is still in flight.
    source.update({ params: { MARK: mark } });
    source.setParams({ layers: 'alt' });
    const swapped = await until(async () => (await sample(OFF_MARK))[2] === 255);
    const swapMs = Math.round(performance.now() - t0);
    await sleep(1000); // the slow response lands late
    const late = await sample(OFF_MARK);
    return {
      pass:
        held[3] === 255 &&
        channelDelta(held, baseline) <= TOL &&
        swapped !== null &&
        swapMs < 700 &&
        late[2] === 255,
      detail: { held, baseline, swapMs, late },
    };
  });

  await check('WMS-06 the bitmap provides one interactive area, no invented ids', async () => {
    const rasterHits = await map.query.rendered({ x: 200, y: 300 }, { limit: 8 });
    // Inside the 5x5 pick window the hotspot occludes the raster; just outside
    // its disc the bitmap below is the single hit.
    const nearHotspotHits = await map.query.rendered({ x: 162, y: 120 }, { limit: 8 });
    const hotspotHits = await map.query.rendered({ x: 150, y: 120 }, { limit: 8 });
    const clicks = [];
    const off = map.on('feature', (event) => {
      if (event.type === 'click') {
        clicks.push({ sourceId: event.sourceId, id: event.feature.id, layerId: event.layerId });
      }
    });
    const element = document.getElementById('map');
    const rect = element.getBoundingClientRect();
    const dispatch = (type) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: type === 'pointerdown' ? 1 : 0,
          clientX: rect.left + 200,
          clientY: rect.top + 300,
        }),
      );
    dispatch('pointerdown');
    await sleep(60);
    dispatch('pointerup');
    await sleep(400);
    off();
    const id = (hit) => `${hit.sourceId}:${hit.feature.id}`;
    return {
      pass:
        rasterHits.length === 1 &&
        rasterHits[0].sourceId === 'wms' &&
        rasterHits[0].feature.id === 'wms' &&
        rasterHits[0].layerId === 'wms-layer' &&
        nearHotspotHits.length === 1 &&
        nearHotspotHits[0].sourceId === 'wms' &&
        nearHotspotHits[0].feature.id === 'wms' &&
        hotspotHits.length >= 1 &&
        hotspotHits[0].sourceId === 'hotspots' &&
        hotspotHits[0].feature.id === 'hotspot-a' &&
        clicks.length === 1 &&
        clicks[0].sourceId === 'wms' &&
        clicks[0].id === 'wms' &&
        clicks[0].layerId === 'wms-layer',
      detail: {
        rasterHits: rasterHits.map(id),
        nearHotspotHits: nearHotspotHits.map(id),
        hotspotHits: hotspotHits.map(id),
        clicks,
      },
    };
  });

  finalize();
}
