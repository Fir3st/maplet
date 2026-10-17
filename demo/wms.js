/**
 * WMS battery: real GetMap images over HTTP from the deterministic `/wms`
 * fixture in `demo/serve.py` (an independent Python implementation of the WMS
 * semantics), plus `?mode=live` against a public WMS.
 *
 * The fixture encodes the *interpreted* geography against one fixed window:
 * red follows longitude, green latitude, blue carries the request identity
 * (+32 version 1.3.0, +64 projected CRS, +16 CRS:84, 255 for `layers`
 * containing `alt`) and `MARK=lng,lat` paints a magenta square. Because the
 * colours are absolute, neighbouring GetMap tiles stitch together and a scaled
 * ancestor tile shows the right colours, so sampling GPU pixels proves the
 * whole path: BBOX axis order and units, URL parameters, fetch, decode,
 * placement, tile fallbacks, the hold/swap behaviour on parameter changes and
 * the bitmap's interactive area.
 *
 * Results: `window.__wmsCheckResult`.
 */
import { createMap } from '../dist/index.js';

const SIZE = 512;
const CENTER = { lat: 50.05, lng: 14.4 };
const ZOOM = 12;
const TOL = 6;
const MARKER = [255, 0, 255];
// Must match the FIXTURE_* constants in demo/serve.py.
const WINDOW = { minLng: 13.0, maxLng: 16.0, minLat: 48.5, maxLat: 51.5 };
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
const expectedChecks = live ? 1 : 11;

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

const map = await createMap('map', {
  renderer: { primary: backend, fallback: false },
  size: { width: SIZE, height: SIZE },
  center: CENTER,
  zoom: ZOOM,
});

const mark = `${CENTER.lng},${CENTER.lat}`;
const source = map.data.wms({
  id: 'wms',
  url: live ? 'https://ows.terrestris.de/osm/service' : '/wms',
  layers: live ? 'OSM-WMS' : 'roads',
  version: '1.1.1',
  crs: 'EPSG:4326',
  attribution: live
    ? '© terrestris GmbH & Co. KG, OpenStreetMap contributors'
    : '© Maplet WMS fixtures',
  ...(live ? {} : { params: { MARK: mark } }),
});
map.addLayer({ id: 'wms-layer', type: 'raster', source, interactive: true });

if (!live) {
  const hotspots = map.data.vector({ id: 'hotspots' });
  await hotspots.features.replace([
    {
      id: 'hotspot-a',
      geometry: { type: 'point', position: map.screenToPosition({ x: 150, y: 120 }) },
    },
  ]);
  map.addLayer({
    id: 'hotspots',
    type: 'points',
    source: hotspots,
    interactive: true,
    style: { radiusPx: 6, color: '#f59e0b' },
  });
}

const sample = async (point) => {
  const pixel = await map.debug.samplePixel(point);
  return [pixel.r, pixel.g, pixel.b, pixel.a];
};
const channelDelta = (pixel, expected) =>
  Math.max(
    Math.abs(pixel[0] - expected[0]),
    Math.abs(pixel[1] - expected[1]),
    Math.abs(pixel[2] - expected[2]),
  );

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
  const position = map.screenToPosition(point);
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
  return [
    clamp((255 * (position.lng - WINDOW.minLng)) / (WINDOW.maxLng - WINDOW.minLng)),
    clamp((255 * (position.lat - WINDOW.minLat)) / (WINDOW.maxLat - WINDOW.minLat)),
    expectedBlue(state),
  ];
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
    const png =
      bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47;
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

  await check(
    'WMS-05 setParams: held bitmaps, superseding swap, late response discarded',
    async () => {
      const baseline = expectedColor(OFF_MARK, {
        version: '1.1.1',
        crs: 'EPSG:4326',
        projected: false,
        alt: false,
      });
      const t0 = performance.now();
      // A slow request starts; the previous bitmaps must stay visible meanwhile.
      source.update({ params: { delay: '700', MARK: mark } });
      source.setParams({ layers: 'slow' });
      await sleep(150);
      const held = await sample(OFF_MARK);
      // A faster replacement arrives while the slow tiles are still in flight.
      source.update({ params: { MARK: mark } });
      source.setParams({ layers: 'alt' });
      const swapped = await until(async () => (await sample(OFF_MARK))[2] === 255);
      const swapMs = Math.round(performance.now() - t0);
      await sleep(1200); // the superseded slow responses land late
      const late = await sample(OFF_MARK);
      // The held bitmap covers the delay and the late tiles never replace the
      // accepted (alt) ones. The swap itself waits for the whole tile row, so no
      // wall-clock bound is asserted here.
      return {
        pass:
          held[3] === 255 &&
          channelDelta(held, baseline) <= TOL &&
          swapped !== null &&
          late[2] === 255,
        detail: { held, baseline, swapMs, late },
      };
    },
  );

  await check('WMS-06 the bitmap provides one interactive area, no invented ids', async () => {
    const rasterHits = await map.query.rendered({ x: 200, y: 300 }, { limit: 8 });
    // Inside the 5x5 pick window the hotspot occludes the raster; just outside
    // its disc the bitmap below is the single hit.
    const nearHotspotHits = await map.query.rendered({ x: 162, y: 120 }, { limit: 8 });
    const hotspotHits = await map.query.rendered({ x: 150, y: 120 }, { limit: 8 });
    const clicks = [];
    const off = map.onFeature((event) => {
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

  await check(
    'WMS-07 GetCapabilities discovery reports layers, CRS, formats and defaults',
    async () => {
      const capabilities = await map.data.wmsCapabilities('/wms');
      const layers = capabilities.layers.map((layer) => ({
        name: layer.name,
        title: layer.title,
        queryable: layer.queryable,
        crs: layer.crs,
      }));
      return {
        pass:
          capabilities.version === '1.3.0' &&
          capabilities.title === 'Maplet WMS fixture' &&
          (capabilities.abstract ?? '').includes('red = longitude') &&
          JSON.stringify(capabilities.formats) === JSON.stringify(['image/jpeg', 'image/png']) &&
          JSON.stringify(capabilities.crs) ===
            JSON.stringify(['EPSG:3857', 'EPSG:4326', 'CRS:84', 'EPSG:5514']) &&
          capabilities.bounds?.southwest.lng === 12.2 &&
          capabilities.bounds?.northeast.lat === 51.5 &&
          JSON.stringify(layers.map((layer) => layer.name)) ===
            JSON.stringify(['roads', 'alt', 'slow']) &&
          JSON.stringify(capabilities.preferred) ===
            JSON.stringify({ version: '1.3.0', crs: 'CRS:84', format: 'image/png' }) &&
          layers[0].queryable === true &&
          layers[1].queryable === false &&
          layers[2].crs.includes('EPSG:5514'),
        detail: {
          version: capabilities.version,
          title: capabilities.title,
          formats: capabilities.formats,
          crs: capabilities.crs,
          bounds: capabilities.bounds,
          layers,
          preferred: capabilities.preferred,
        },
      };
    },
  );

  await check('WMS-08 a layer built from the discovered defaults renders the service', async () => {
    const capabilities = await map.data.wmsCapabilities('/wms');
    const discovered = map.data.wms({
      id: 'wms-discovered',
      url: '/wms',
      layers: 'roads',
      ...capabilities.preferred,
      params: { MARK: mark },
    });
    map.addLayer({ id: 'wms-discovered-layer', type: 'raster', source: discovered });
    try {
      // The battery's previous request left blue at 255 (`alt`, 1.1.1); the
      // discovered options (1.3.0, CRS:84, no `alt`) paint 48, so waiting for
      // that value proves the discovered request itself reached the screen.
      // Tiles load independently, so the geography is retried until every
      // sampled corner carries the new identity.
      const state = { version: '1.3.0', crs: 'CRS:84', projected: false, alt: false };
      const loaded = await until(async () => (await sample(OFF_MARK))[2] === expectedBlue(state));
      const geography = await until(async () => {
        const result = await verifyGeography(state);
        return result.pass ? result : null;
      }, 10000);
      const url = new URL(
        map.debug.layerTiles('wms-discovered-layer')[0]?.url ?? 'about:blank',
        location.href,
      );
      const requested = {
        crs: url.searchParams.get('crs'),
        version: url.searchParams.get('version'),
        format: url.searchParams.get('format'),
      };
      return {
        pass:
          loaded !== null &&
          geography !== null &&
          requested.crs === 'CRS:84' &&
          requested.version === '1.3.0' &&
          requested.format === 'image/png',
        detail: { loaded: loaded !== null, geography: geography !== null, requested },
      };
    } finally {
      map.layers.remove('wms-discovered-layer');
      map.data.remove('wms-discovered');
    }
  });

  await check(
    'WMS-09 unsupported CRS and non-document responses fail with clear errors',
    async () => {
      const failures = [];
      const expectFailure = async (run, code) => {
        try {
          await run();
          failures.push(`no error, expected ${code}`);
        } catch (error) {
          if (error?.code !== code)
            failures.push(`${String(error?.code)}: ${String(error?.message).slice(0, 90)}`);
        }
      };
      await expectFailure(
        () => map.data.wms({ id: 'bad-crs', url: '/wms', layers: 'slow', crs: 'EPSG:5514' }),
        'invalid-argument',
      );
      await expectFailure(() => map.data.wmsCapabilities('./nope-404.xml'), 'import-invalid');
      await expectFailure(() => map.data.wmsCapabilities('./wms.html'), 'import-invalid');
      const legacy = await map.data.wmsCapabilities('./wms-legacy.xml');
      return {
        pass:
          failures.length === 0 &&
          legacy.version === '1.1.1' &&
          legacy.preferred === undefined &&
          legacy.crs.join() === 'EPSG:5514' &&
          legacy.layers[0]?.name === 'grid' &&
          legacy.layers[0]?.queryable === true,
        detail: {
          failures,
          legacy: {
            version: legacy.version,
            preferred: legacy.preferred,
            crs: legacy.crs,
            layer: legacy.layers[0]?.name,
          },
        },
      };
    },
  );

  await check('WMS-10 a partial zoom reuses the requested tiles', async () => {
    const before = map.debug
      .layerTiles('wms-layer')
      .map((tile) => ({ key: tile.tileKey, url: tile.url }));
    map.setView({ center: CENTER, zoom: map.getZoom() + 0.4 });
    const after = map.debug
      .layerTiles('wms-layer')
      .map((tile) => ({ key: tile.tileKey, url: tile.url }));
    // The tile grid only deepens per integer zoom level, so part of a level of
    // scrolling requests nothing and the same decoded tiles scale with the view.
    const reused = after.every((tile) => {
      const match = before.find((entry) => entry.key === tile.key);
      return match !== undefined && match.url === tile.url;
    });
    const missing =
      after.find((tile) => !before.some((entry) => entry.key === tile.key))?.key ?? null;
    return {
      pass: after.length > 0 && reused,
      detail: {
        tiles: after.length,
        reused,
        missing,
        zoom: Math.round(map.getZoom() * 1000) / 1000,
      },
    };
  });

  await check(
    'WMS-11 a zoom change stays covered by the previous level while the new one loads',
    async () => {
      // Slow every tile of the next level down and let the current level settle
      // (the fixture sleeps per request), so the previous level is decoded when
      // the view changes.
      source.update({ params: { delay: '400', MARK: mark } });
      await until(async () => (await sample(MARK_POINT))[3] === 255, 4000);
      await sleep(1800);
      const zoomBefore = map.getZoom();
      map.setView({ center: CENTER, zoom: zoomBefore + 1 });
      const markerAfter = map.positionToScreen(CENTER);
      await sleep(120);
      // The new level is still loading, so the ancestors stand in: the marker is
      // painted at its projected position and a gradient sample matches the
      // absolute fixture window, i.e. the stand-in is geographically correct.
      const covered = await sample(markerAfter);
      const gradientPoint = { x: 128, y: 96 };
      const gradient = await sample(gradientPoint);
      const expected = expectedColor(gradientPoint, {
        version: '1.1.1',
        crs: 'EPSG:4326',
        projected: false,
        alt: false,
      });
      const standInKeys = map.debug.layerTiles('wms-layer')[0]?.fallbacks[0]?.url;
      await sleep(1200);
      const settled = await sample(markerAfter);
      const level = map.debug.layerTiles('wms-layer')[0]?.tileKey?.split('/')[0];
      const magenta = (pixel) => channelDelta(pixel, MARKER) <= TOL;
      return {
        pass:
          magenta(covered) &&
          channelDelta(gradient, expected) <= TOL &&
          magenta(settled) &&
          typeof standInKeys === 'string' &&
          level === String(Math.floor(zoomBefore + 1)),
        detail: {
          covered,
          gradient,
          expected,
          settled,
          zoomBefore,
          level,
          standIn: standInKeys?.slice(-46),
        },
      };
    },
  );

  finalize();
}
