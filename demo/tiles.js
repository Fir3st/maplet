/**
 * Tile checks: real bitmaps (cached or live from public providers) and SVG tiles.
 *
 * Run `demo/tiles.html?mode=svg`, `?mode=osm`, `?mode=esri-imagery&live=1`, ...
 * The page renders tiles with the WebGL 1 backend at fixed integer zooms, then
 * compares GPU pixels with the exact same bitmap decoded in a 2D canvas (any
 * placement, orientation or premultiplication error shows up as a delta), checks
 * fractional-zoom seams and, for SVG, exact vector colours and text orientation
 * from the `tiles-svg/checks.json` oracle. Results land in
 * `window.__tileCheckResult` and the page title flips to `tiles-check-done`.
 */
import { createMap } from '../dist/index.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'svg';
const live = params.get('live') === '1';
const SIZE = 512;
const TILE = 256;
const OFFSET = SIZE / 2 - TILE / 2; // an integer zoom keeps the target tile here
const TOL = 4;

const PROVIDERS = {
  // The OSM standard layer is live-only: its operations team blocks scripted
  // fetching (`fetch-tiles.py` explains), while browser requests are normal
  // usage exactly like Leaflet's quick start.
  osm: {
    live: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    cached: null,
    attribution: '\u00a9 OpenStreetMap contributors',
  },
  'osm-de': {
    live: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
    cached: './tiles-providers/osm-de/{z}/{x}/{y}.png',
    attribution: '\u00a9 OpenStreetMap contributors, openstreetmap.de style',
  },
  opentopomap: {
    live: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    cached: './tiles-providers/opentopomap/{z}/{x}/{y}.png',
    attribution: '\u00a9 OpenTopoMap (CC-BY-SA)',
  },
  'esri-imagery': {
    live: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    cached: './tiles-providers/esri-imagery/{z}/{x}/{y}.jpg',
    attribution: 'Powered by Esri \u2014 Source: Esri, Maxar, Earthstar Geographics',
  },
};

const provider = mode === 'svg' ? null : PROVIDERS[mode];
if (mode !== 'svg' && !provider) {
  const summary = document.getElementById('summary');
  summary.textContent = `unknown mode "${mode}"; use svg, ${Object.keys(PROVIDERS).join(', ')}`;
  summary.className = 'fail';
  throw new Error(`unknown mode: ${mode}`);
}
const effectiveLive = provider ? live || !provider.cached : false;
const errors = [];
window.addEventListener('error', (event) => {
  errors.push(`${event.message} (${event.filename?.split('/').pop() ?? '?'}:${event.lineno})`);
});

/* Signatures must match `src/formats/raster.ts` so the decoded comparison
   fetches exactly the URL the layer renders. */
function formatUrl(template, subdomains, z, x, y) {
  let url = template;
  if (subdomains && subdomains.length > 0) {
    url = url.replaceAll('{s}', subdomains[Math.abs(x + y) % subdomains.length]);
  }
  return url
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y));
}

function tileCenter(z, x, y) {
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (y + 0.5)) / n));
  return { lat, lng };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COMPARE_TILE = { z: 3, x: 4, y: 2 }; // central Europe: land water roads labels
const map = await createMap('map', {
    renderer: { primary: new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1', fallback: false },
    size: { width: SIZE, height: SIZE },
    ...provider
        ? { center: tileCenter(COMPARE_TILE.z, COMPARE_TILE.x, COMPARE_TILE.y), zoom: COMPARE_TILE.z }
        : { center: tileCenter(2, 1, 1), zoom: 2 }
});

const sourceOptions = provider
  ? {
      url: effectiveLive ? provider.live : provider.cached,
      ...(provider.subdomains ? { subdomains: provider.subdomains } : {}),
      minZoom: 0,
      maxZoom: effectiveLive ? 19 : 8,
      attribution: provider.attribution,
    }
  : { url: './tiles-svg/{z}/{x}/{y}.svg', minZoom: 0, maxZoom: 3, attribution: 'Local SVG tiles (maplet)' };
const source = map.data.rasterTiles({ id: 'tiles', ...sourceOptions });
map.addLayer({ id: 'tiles', type: 'raster', source, style: { opacity: 1 } });
window.__maplet = { map, source };
document.getElementById('mode-label').textContent = `${mode}${provider ? (effectiveLive ? ' · live' : ' · cache') : ''}`;

const sample = async (x, y) => {
  const pixel = await map.debug.samplePixel({ x, y });
  return [pixel.r, pixel.g, pixel.b, pixel.a];
};

async function waitFor(check, timeoutMs = 25000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

const maxDelta = (got, expected) =>
  Math.max(
    Math.abs(got[0] - expected[0]),
    Math.abs(got[1] - expected[1]),
    Math.abs(got[2] - expected[2]),
  );

/** Decodes a tile with the same CORS mode the renderer uses. */
async function decodeTile(url) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  const canvas = new OffscreenCanvas(TILE, TILE);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, TILE, TILE).data;
}

/** Texture-space coordinate (texel units, texel centre = integer) of a screen pixel. */
function texelCoord(pixel, rectStart, rectSize, u0, u1) {
  const u = u0 + ((pixel + 0.5 - rectStart) / rectSize) * (u1 - u0);
  return Math.max(0, Math.min(TILE - 1.001, u * TILE - 0.5));
}

/** The value a linear-filtered sample of a decoded tile returns at (x, y). */
function bilinear(pixels, x, y) {
  const x0 = Math.max(0, Math.min(TILE - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(TILE - 1, Math.floor(y)));
  const x1 = Math.min(TILE - 1, x0 + 1);
  const y1 = Math.min(TILE - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (cx, cy) => {
    const index = (cy * TILE + cx) * 4;
    return [pixels[index], pixels[index + 1], pixels[index + 2]];
  };
  const c00 = at(x0, y0);
  const c10 = at(x1, y0);
  const c01 = at(x0, y1);
  const c11 = at(x1, y1);
  return [0, 1, 2].map(
    (channel) =>
      c00[channel] * (1 - fx) * (1 - fy) +
      c10[channel] * fx * (1 - fy) +
      c01[channel] * (1 - fx) * fy +
      c11[channel] * fx * fy,
  );
}

function resourceSummary() {
  return performance
    .getEntriesByType('resource')
    .filter((entry) => /\.(png|jpe?g|svg)(\?|$)|\/MapServer\/tile\//.test(entry.name))
    .map((entry) => ({
      name: entry.name.replace(location.origin + location.pathname.replace(/[^/]*$/, ''), ''),
      type: entry.initiatorType,
      ms: Math.round(entry.duration),
      bytes: entry.transferSize,
      status: entry.responseStatus ?? null,
    }));
}

async function svgChecks() {
  const oracle = await (await fetch('./tiles-svg/checks.json')).json();
  const { z, x, y } = oracle.tile;
  map.setView({ center: tileCenter(z, x, y), zoom: z });
  const center = oracle.samples.find((entry) => entry.name === 'circleCenter');
  const ready = await waitFor(async () => {
    const got = await sample(OFFSET + center.x, OFFSET + center.y);
    return maxDelta(got, center.expected) <= TOL && got[3] >= 250;
  });
  const samples = [];
  for (const entry of oracle.samples) {
    const got = await sample(OFFSET + entry.x, OFFSET + entry.y);
    samples.push({
      name: entry.name,
      at: [entry.x, entry.y],
      expected: entry.expected,
      got: got.slice(0, 3),
      alpha: got[3],
      delta: maxDelta(got, entry.expected),
    });
  }
  const inkIn = async (box, step, stopAt) => {
    let count = 0;
    for (let y2 = box.y; y2 < box.y + box.h; y2 += step) {
      for (let x2 = box.x; x2 < box.x + box.w; x2 += step) {
        const got = await sample(OFFSET + x2, OFFSET + y2);
        if (got[0] + got[1] + got[2] <= oracle.text.inkThreshold) {
          count += 1;
          if (stopAt > 0 && count >= stopAt) return count;
        }
      }
    }
    return count;
  };
  const textInk = await inkIn(oracle.text.mustHaveInk, 1, oracle.text.mustHaveInk.minInk);
  const emptyBoxes = [];
  for (const box of oracle.text.mustBeEmpty) {
    emptyBoxes.push({ box: [box.x, box.y, box.w, box.h], ink: await inkIn(box, 2, -1) });
  }
  const seam = await seamChecks();
  return {
    ready,
    samples,
    samplesPass: samples.every((entry) => entry.delta <= TOL && entry.alpha >= 250),
    text: {
      topLeftInk: textInk,
      minInk: oracle.text.mustHaveInk.minInk,
      emptyBoxes,
      orientationPass:
        textInk >= oracle.text.mustHaveInk.minInk && emptyBoxes.every((entry) => entry.ink === 0),
    },
    seam,
  };
}

async function providerChecks() {
  const tile = COMPARE_TILE;
  map.setView({ center: tileCenter(tile.z, tile.x, tile.y), zoom: tile.z });
  const ready = await waitFor(async () => {
    const got = await sample(SIZE / 2, SIZE / 2);
    return got[3] >= 250;
  });
  const url = formatUrl(sourceOptions.url, sourceOptions.subdomains, tile.z, tile.x, tile.y);
  let pixels = null;
  let decodeError = null;
  try {
    pixels = await decodeTile(url);
  } catch (error) {
    decodeError = String(error);
  }
  const comparisons = [];
  if (pixels) {
    for (const [u, v] of [[64, 64], [192, 80], [96, 208], [200, 180], [128, 128]]) {
      const got = await sample(OFFSET + u, OFFSET + v);
      const index = (v * TILE + u) * 4;
      const decoded = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
      comparisons.push({
        texel: [u, v],
        gpu: got.slice(0, 3),
        decoded: decoded.slice(0, 3),
        alpha: got[3],
        delta: maxDelta(got, decoded),
      });
    }
  }
  // No-flash fallback: a tile outside the cached block must be covered by its
  // decoded z-1 ancestor while the (missing) tile itself cannot load.
  const fallback = !effectiveLive && mode !== 'svg' ? await fallbackChecks() : null;
  // Live runs keep the extra fractional-zoom requests to one provider (OSM);
  // the seam behaviour itself is format-independent and covered for the cache.
  const seam = effectiveLive && mode !== 'osm' ? null : await seamChecks();
  // Provider switch: the old bitmaps stay visible until the new ones decode.
  const urlSwitch = mode === 'osm-de' && !effectiveLive ? await switchChecks() : null;
  return {
    tile,
    url,
    ready,
    decodeError,
    comparisons,
    comparePass: !decodeError && comparisons.every((entry) => entry.delta <= TOL && entry.alpha >= 250),
    fallback,
    urlSwitch,
    seam,
  };
}

/**
 * Fallback coverage. The view centres a z5 tile that is not in the offline
 * cache (east of the cached Prague block), so the renderer must stand in with
 * the decoded z4 ancestor: the sampled pixels have to match the ancestor's
 * bilinear-filtered texels, and no pixel may stay transparent.
 */
async function fallbackChecks() {
  map.setView({ center: tileCenter(5, 19, 10), zoom: 5 });
  const ready = await waitFor(async () => (await sample(SIZE / 2, SIZE / 2))[3] >= 250);
  const probes = [];
  for (const child of [{ x: 19, y: 10 }, { x: 19, y: 9 }]) {
    const rect = {
      sx: OFFSET + (child.x - 19) * TILE,
      sy: OFFSET + (child.y - 10) * TILE,
      sw: TILE,
      sh: TILE,
    };
    const px = Math.max(2, Math.min(SIZE - 3, Math.round(rect.sx + rect.sw / 2)));
    const py = Math.max(2, Math.min(SIZE - 3, Math.round(rect.sy + rect.sh / 2)));
    const parent = { z: 4, x: 9, y: child.y >> 1 };
    const parentPixels = await decodeTile(
      formatUrl(sourceOptions.url, sourceOptions.subdomains, parent.z, parent.x, parent.y),
    );
    const u0 = (child.x % 2) / 2;
    const v0 = (child.y % 2) / 2;
    const expected = bilinear(
      parentPixels,
      texelCoord(px, rect.sx, rect.sw, u0, u0 + 0.5),
      texelCoord(py, rect.sy, rect.sh, v0, v0 + 0.5),
    );
    const got = await sample(px, py);
    probes.push({
      tile: `5/${child.x}/${child.y}`,
      parent: `${parent.z}/${parent.x}/${parent.y}`,
      at: [px, py],
      expected: expected.map((value) => Math.round(value)),
      got: got.slice(0, 3),
      alpha: got[3],
      delta: maxDelta(got, expected),
    });
  }
  return { view: '5/19/10', ready, probes, pass: ready && probes.every((entry) => entry.alpha >= 250 && entry.delta <= TOL) };
}

/**
 * Provider switch. `source.update()` swaps the template; the very next sample
 * must still show the previous provider's decoded texel (held frame), and once
 * the new tiles decode the pixel must match the new provider's bitmap.
 */
async function switchChecks() {
  const target = PROVIDERS['opentopomap'];
  const tile = COMPARE_TILE;
  map.setView({ center: tileCenter(tile.z, tile.x, tile.y), zoom: tile.z });
  const point = [OFFSET + 64, OFFSET + 64];
  await waitFor(async () => (await sample(point[0], point[1]))[3] >= 250);
  const before = await sample(point[0], point[1]);
  source.update({
    url: target.cached,
    subdomains: target.subdomains ?? [],
    attribution: target.attribution,
  });
  const during = await sample(point[0], point[1]);
  const targetUrl = formatUrl(target.cached, target.subdomains, tile.z, tile.x, tile.y);
  const pixels = await decodeTile(targetUrl);
  const index = (64 * TILE + 64) * 4;
  const expected = [pixels[index], pixels[index + 1], pixels[index + 2]];
  const swapped = await waitFor(async () => {
    const got = await sample(point[0], point[1]);
    return maxDelta(got, expected) <= TOL;
  });
  const after = await sample(point[0], point[1]);
  return {
    target: 'opentopomap',
    before: before.slice(0, 3),
    during: during.slice(0, 3),
    after: after.slice(0, 3),
    expected,
    holdPass: during[3] >= 250 && maxDelta(during, before) <= 1,
    swapPass: swapped && after[3] >= 250 && maxDelta(after, expected) <= TOL,
  };
}

async function seamChecks() {
  map.setView({ center: { lat: 0, lng: 0 }, zoom: 2.4 });
  const quadrants = [[112, 112], [400, 112], [112, 400], [400, 400]];
  const ready = await waitFor(async () => {
    for (const [x, y] of quadrants) {
      if ((await sample(x, y))[3] < 250) return false;
    }
    return true;
  });
  const points = [];
  for (let d = -6; d <= 6; d += 1) {
    points.push([256 + d, 120], [256 + d, 392], [120, 256 + d], [392, 256 + d]);
  }
  let transparent = 0;
  let minAlpha = 255;
  for (const [x, y] of points) {
    const alpha = (await sample(x, y))[3];
    minAlpha = Math.min(minAlpha, alpha);
    if (alpha < 250) transparent += 1;
  }
  return { ready, sampled: points.length, transparent, minAlpha, pass: ready && transparent === 0 };
}

async function run() {
  const started = performance.now();
  const result = {
    mode,
    live: effectiveLive,
    dpr: devicePixelRatio,
    size: SIZE,
    checks: null,
    errors,
    pass: false,
    ms: 0,
  };
  try {
    result.checks = mode === 'svg' ? await svgChecks() : await providerChecks();
    const checks = result.checks;
    const seam = checks.seam;
    const extras =
      mode === 'svg'
        ? checks.samplesPass && checks.text.orientationPass
        : checks.comparePass &&
          (checks.fallback?.pass ?? true) &&
          (checks.urlSwitch ? checks.urlSwitch.holdPass && checks.urlSwitch.swapPass : true);
    result.pass =
      checks.ready && result.errors.length === 0 && (seam === null || seam.pass) && extras;
  } catch (error) {
    errors.push(String(error));
  }
  result.ms = Math.round(performance.now() - started);
  result.resources = resourceSummary();
  window.__tileCheckResult = result;
  document.title = 'tiles-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${mode} · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
  return result;
}

window.__runTileChecks = run;
await run();
