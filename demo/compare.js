/**
 * Opt-in, matched workload for Maplet and Leaflet 1.9.4.
 * No clustering, aggregation, reduced point count or disabled interaction.
 * Fresh-process repetitions are driven by the existing E2E runner.
 */
import { createMap } from '../dist/index.js';
import * as L from './vendor/leaflet.esm.js';

const COUNT = 500000;
const SIDE = Math.ceil(Math.sqrt(COUNT));
const CENTER = { lat: 50, lng: 14.05 };
const PROBES = [CENTER, { lat: 49.85, lng: 14.25 }];
const ZOOM = 10;
const params = new URLSearchParams(location.search);
const engine = params.get('engine') ?? 'maplet';
const result = { pass: false, checks: [], errors: [] };
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heap = () => performance.memory?.usedJSHeapSize ?? null;
const mib = (bytes) => bytes === null ? null : Math.round(bytes / 1048576 * 10) / 10;
let map;
let source;
let renderer;
let points;
let renderFrames = 0;

function expectedScreen(position) {
  const unitY = (lat) => {
    const sin = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  };
  const scale = 256 * 2 ** ZOOM;
  return { x: 360 + (position.lng - CENTER.lng) / 360 * scale,
    y: 260 + (unitY(position.lat) - unitY(CENTER.lat)) * scale };
}

function publish() {
  window.__compareCheckResult = result;
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
  document.title = 'comparison-done';
}
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(String(event.reason));
  publish();
});

function generateBatch() {
  const positions = new Float64Array(COUNT * 2);
  const ids = new Array(COUNT);
  const properties = new Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 2] = CENTER.lng - 0.5 + (i % SIDE) / SIDE;
    positions[i * 2 + 1] = CENTER.lat - 0.5 + Math.floor(i / SIDE) / SIDE;
    ids[i] = `p:${i}`;
    properties[i] = { v: i % 8 };
  }
  return { kind: 'point', positions, ids, properties };
}

function countRenderedPoints() {
  if (engine === 'maplet') return map.stats().instances;
  if (engine === 'leaflet-dom') return document.querySelectorAll('.comparison-point').length;
  let count = 0;
  for (let order = renderer._drawFirst; order; order = order.next) {
    if (!order.layer._empty()) count++;
  }
  return count;
}

function frameCount() {
  return engine === 'maplet' ? map.stats().frames : renderFrames;
}

async function verifyOutput() {
  if (engine === 'leaflet-dom') {
    const rect = document.getElementById('map').getBoundingClientRect();
    return PROBES.map((position) => {
      const screen = map.latLngToContainerPoint(position);
      const element = document.elementFromPoint(rect.left + screen.x, rect.top + screen.y);
      return {
        pass: element?.classList.contains('comparison-point') === true &&
          getComputedStyle(element).backgroundColor === 'rgb(37, 99, 235)',
        element: element?.className,
      };
    });
  }
  const pixels = [];
  for (const position of PROBES) {
    let pixel;
    if (engine === 'maplet') {
      const screen = map.positionToScreen(position);
      pixel = await map.debug.samplePixel({ x: Math.round(screen.x), y: Math.round(screen.y) });
    } else {
      const screen = map.latLngToLayerPoint(position).subtract(renderer._bounds.min);
      const dpr = renderer._ctx.getTransform().a;
      const data = renderer._ctx.getImageData(Math.round(screen.x * dpr), Math.round(screen.y * dpr), 1, 1).data;
      pixel = { r: data[0], g: data[1], b: data[2], a: data[3] };
    }
    pixels.push({ pass: pixel.b > 180 && pixel.r < 90 && pixel.g < 160 && pixel.a > 0, pixel });
  }
  return pixels;
}

async function panTest(durationMs) {
  const samples = [];
  const beforeFrames = frameCount();
  const started = performance.now();
  while (performance.now() - started < durationMs) {
    const t0 = performance.now();
    const center = {
      lat: CENTER.lat + 0.0006 * Math.sin(samples.length / 9),
      lng: CENTER.lng + 0.0008 * Math.cos(samples.length / 7),
    };
    if (engine === 'maplet') map.setView({ center });
    else map.panTo(center, { animate: false });
    await frame();
    samples.push(performance.now() - t0);
  }
  const elapsedMs = performance.now() - started;
  samples.sort((a, b) => a - b);
  const percentile = (q) => Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] * 10) / 10;
  return {
    samples: samples.length,
    renderUpdates: frameCount() - beforeFrames,
    elapsedMs: Math.round(elapsedMs),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
  };
}

try {
  if (!['maplet', 'leaflet-canvas', 'leaflet-dom'].includes(engine)) throw new Error(`Unknown engine: ${engine}`);
  if (typeof gc === 'function') gc();
  const baseHeap = heap();
  const setupStart = performance.now();
  if (engine === 'maplet') {
    map = await createMap('map', {
    renderer: { primary: params.get('backend') === 'webgpu' ? 'webgpu' : 'webgl1', fallback: false },
    size: { width: 720, height: 520 },
    center: CENTER, zoom: ZOOM
});
    source = map.data.vector({ id: 'points' });
    map.addLayer({ id: 'points', type: 'points', source,
      style: { radiusPx: 2, color: '#2563eb' }, interactive: true  });
  } else {
    renderer = engine === 'leaflet-canvas' ? L.canvas({ padding: 0 }) : undefined;
    map = L.map('map', { renderer, zoomControl: false, attributionControl: false,
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false })
      .setView(CENTER, ZOOM);
    if (renderer) {
      // Count actual canvas redraws without changing their work or timing.
      const redraw = renderer._redraw;
      renderer._redraw = function () { renderFrames++; return redraw.call(this); };
    } else {
      map.on('move', () => renderFrames++);
    }
  }
  const mapCreateMs = performance.now() - setupStart;
  const generateStart = performance.now();
  let batch = generateBatch();
  const generateMs = performance.now() - generateStart;
  const loadStart = performance.now();
  if (engine === 'maplet') {
    await source.importColumnar(batch, { copy: false });
  } else {
    points = new Array(COUNT);
    const icon = engine === 'leaflet-dom'
      ? L.divIcon({ className: 'comparison-point', html: '', iconSize: [4, 4], iconAnchor: [2, 2] })
      : null;
    for (let i = 0; i < COUNT; i++) {
      const position = [batch.positions[i * 2 + 1], batch.positions[i * 2]];
      const point = icon
        ? L.marker(position, { icon, keyboard: false, interactive: true })
        : L.circleMarker(position, { renderer, radius: 2, stroke: false,
          fillColor: '#2563eb', fillOpacity: 1, interactive: true });
      point.feature = { id: batch.ids[i], properties: batch.properties[i] };
      points[i] = point;
    }
    L.layerGroup(points).addTo(map);
  }
  const loadMs = performance.now() - loadStart;
  batch = null;
  const paintStart = performance.now();
  // The same paint opportunity fence for every engine, not a GPU timer.
  await frame();
  await frame();
  await sleep(20);
  const paintWaitMs = performance.now() - paintStart;
  const setupToPaintMs = performance.now() - setupStart;
  const output = await verifyOutput();
  const projections = PROBES.map((position) => {
    const expected = expectedScreen(position);
    const actual = engine === 'maplet' ? map.positionToScreen(position) : map.latLngToContainerPoint(position);
    return { expected, actual, pass: Math.abs(expected.x - actual.x) <= 1 && Math.abs(expected.y - actual.y) <= 1 };
  });
  const drawn = countRenderedPoints();
  if (typeof gc === 'function') gc();
  const heapAfter = heap();
  result.checks.push({ name: 'same workload and visible output',
    pass: (engine === 'maplet' ? source.features.count() : points.length) === COUNT &&
      drawn > 50000 && output.every((probe) => probe.pass) && projections.every((probe) => probe.pass),
    detail: {
      engine, backend: engine === 'maplet' ? map.capabilities().backend : L.version,
      userAgent: navigator.userAgent, dpr: devicePixelRatio,
      count: COUNT, renderedPointsOrDomMarkers: drawn,
      markerDomElements: document.querySelectorAll('.comparison-point').length,
      mapCreateMs: Math.round(mapCreateMs), generateMs: Math.round(generateMs),
      loadMs: Math.round(loadMs), paintWaitMs: Math.round(paintWaitMs),
      setupToPaintMs: Math.round(setupToPaintMs),
      gcAvailable: typeof gc === 'function', heapDeltaMiB: heapAfter === null || baseHeap === null ? null : mib(heapAfter - baseHeap),
      drawCalls: engine === 'maplet' ? map.stats().drawCalls : null,
      gpuMiB: engine === 'maplet' ? mib(map.stats().gpuBytes) : null,
      output, projections,
    } });
  const coldPan = await panTest(2500);
  // Do not attribute the initial compositor cadence to steady-state cost.
  await panTest(5000);
  const warmPan = await panTest(10000);
  if (engine === 'maplet') {
    map.setView({ center: CENTER, zoom: ZOOM });
    await map.whenRendered();
  } else map.panTo(CENTER, { animate: false });
  await frame();
  await frame();
  const afterPan = await verifyOutput();
  result.checks.push({ name: 'cold and warmed pan with output validation',
    pass: coldPan.samples >= 2 && warmPan.samples >= 2 &&
      afterPan.every((probe) => probe.pass),
    detail: { coldPan, warmupMs: 5000, warmPan, afterPan } });
  result.pass = result.errors.length === 0 && result.checks.every((check) => check.pass);
  // Keep the map available for independent browser inspection.
  window.__comparison = { map, engine, result, source, points };
  publish();
} catch (error) {
  result.errors.push(String(error));
  publish();
}
