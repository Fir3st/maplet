/**
 * Maplet demo.
 *
 * Uses the built package from `dist/`. The renderer is forced to WebGL 1 so the
 * page works everywhere; pass `?backend=webgpu` to request WebGPU first.
 * `window.__maplet` exposes { map, layers } for browser-console experiments and
 * for the automated browser checks.
 */
import { createMap, style as expr, crs } from '../dist/index.js';

const params = new URLSearchParams(location.search);
const forceBackend = params.get('backend');
const log = (line) => {
  const element = document.getElementById('log');
  element.textContent = `${new Date().toISOString().slice(11, 19)}  ${line}\n${element.textContent}`;
};

const map = await createMap('map', {
    projection: crs.webMercator(),
    renderer: forceBackend === 'webgpu' ? { primary: 'webgpu', fallback: 'webgl1' } : { primary: 'webgl1', fallback: false },
    center: { lat: 50.08, lng: 14.44 }, zoom: 8,
    interaction: { boxSelection: true }
});
log(`backend: ${map.capabilities().backend} ${map.capabilities().notes.join('; ')}`);

/* Tile backgrounds. The provider presets follow the OSM wiki list of raster
   tile providers; each is a plain XYZ URL template requested by the browser
   like any other tile layer, with its required attribution shown under the
   map. `osm-de-cache` is the optional offline copy fetched by demo/fetch-tiles.py. */
const TILE_MODES = {
  local: { url: './tiles/{z}/{x}/{y}.png', nativeZoom: 6, attribution: 'Local test tiles (Maplet)' },
  svg: { url: './tiles-svg/{z}/{x}/{y}.svg', nativeZoom: 6, attribution: 'Local SVG tiles (Maplet)' },
  // Live URLs, requested by the browser exactly like Leaflet's quick start
  // (`L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution })`).
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
  'osm-de': { url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors (openstreetmap.de style)' },
  opentopomap: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    attribution: '© OpenTopoMap (CC-BY-SA)',
  },
  'esri-imagery': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics',
  },
  // Offline copy of the OSM-DE style (see demo/fetch-tiles.py).
  'osm-de-cache': { url: './tiles-providers/osm-de/{z}/{x}/{y}.png', nativeZoom: 8, attribution: '© OpenStreetMap contributors (offline cache)' },
};

const background = map.data.rasterTiles({
  id: 'background',
  url: './tiles/{z}/{x}/{y}.png',
  minZoom: 0,
  nativeZoom: 6,
  attribution: 'Local test tiles',
});
map.addLayer({ id: 'background', type: 'raster', source: background, style: { opacity: 0.9 } });

let currentTileMode = null;
const setTileMode = (name) => {
  const mode = TILE_MODES[name];
  if (!mode) return;
  document.getElementById('attribution').textContent = mode.attribution;
  if (currentTileMode === name) return;
  currentTileMode = name;
  background.update({
    url: mode.url,
    nativeZoom: mode.nativeZoom ?? 19,
    subdomains: mode.subdomains ?? [],
    attribution: mode.attribution,
  });
  log(`basemap: ${name}`);
};
setTileMode(params.get('tiles') ?? 'local');

// Opt-in HTML controls: zoom honours the view limits, layers stay in sync with
// the API, attribution composes from the live sources and scale uses the CRS.
map.addControl({ kind: 'zoom', id: 'zoom' });
map.addControl({ kind: 'layers', id: 'layers' });
map.addControl({ kind: 'attribution', id: 'attribution' });
map.addControl({ kind: 'scale', id: 'scale' });

const stations = map.data.vector({ id: 'stations' });
await stations.features.replace([
  { id: 'a', geometry: { type: 'point', position: { lat: 50.08, lng: 14.44 } }, properties: { name: 'Praha', status: 'online', pop: 1300000 } },
  { id: 'b', geometry: { type: 'point', position: { lat: 49.19, lng: 16.61 } }, properties: { name: 'Brno', status: 'online', pop: 380000 } },
  { id: 'c', geometry: { type: 'point', position: { lat: 49.74, lng: 13.37 } }, properties: { name: 'Plzeň', status: 'offline', pop: 170000 } },
  { id: 'd', geometry: { type: 'point', position: { lat: 49.59, lng: 17.25 } }, properties: { name: 'Olomouc', status: 'offline', pop: 100000 } },
]);
const stationLayer = map.addLayer({
  id: 'station-points',
  type: 'points',
  source: stations,
  interactive: true, draggable: true ,
  style: {
    // Interaction style: hover/selection state sits above the property match.
    radiusPx: expr.when(
      expr.state('selected'),
      13,
      expr.when(expr.state('hovered'), 12, expr.match(expr.field('status'), { online: 9, offline: 6 }, 6)),
    ),
    color: expr.when(
      expr.state('selected'),
      '#f59e0b',
      expr.when(
        expr.state('hovered'),
        '#22c55e',
        expr.match(expr.field('status'), { online: '#16a34a', offline: '#dc2626' }, '#6b7280'),
      ),
    ),
    strokeColor: '#0f172a',
    strokeWidthPx: expr.when(expr.state('selected'), 3, expr.when(expr.state('hovered'), 2.5, 1.5)),
  },
});
// Feature events bubble layer -> group(s) -> map (EVENT-01); each level can
// call event.stopPropagation().
stationLayer.onFeature((event) => log(`layer: ${event.type} ${String(event.feature.id)}`));
const connections = map.data.vector({ id: 'connections' });
await connections.features.replace([
  { id: 'link-1', geometry: { type: 'lineString', positions: [{ lat: 50.08, lng: 14.44 }, { lat: 49.19, lng: 16.61 }] }, properties: {} },
]);
map.addLayer({
  id: 'connection-lines',
  type: 'lines',
  source: connections,
  style: { widthPx: 3, color: '#7c3aed' },
});

/* A derived link bound to two stations: moving a station redraws the link in
   the same revision. */
map.bindings.add({
  id: 'link-1-geometry',
  target: connections.features.ref('link-1'),
  geometry: { kind: 'lineBetween', from: stations.features.ref('b'), to: stations.features.ref('c') },
});

const shapes = map.data.vector({ id: 'shapes' });
await shapes.features.replace([
  {
    id: 'donut',
    geometry: {
      type: 'polygon',
      rings: [
        [
          { lat: 48.5, lng: 13.0 },
          { lat: 48.5, lng: 15.5 },
          { lat: 49.4, lng: 15.5 },
          { lat: 49.4, lng: 13.0 },
        ],
        [
          { lat: 48.75, lng: 13.6 },
          { lat: 48.75, lng: 14.9 },
          { lat: 49.15, lng: 14.9 },
          { lat: 49.15, lng: 13.6 },
        ],
      ],
    },
    properties: { name: 'Donut' },
  },
]);
map.addLayer({
  id: 'shape-fills',
  type: 'fills',
  source: shapes,
  style: { fillColor: '#f59e0b', fillOpacity: 0.35, strokeColor: '#b45309', strokeWidthPx: 2 },
});

// Draw order: background, shapes, links, then stations and their labels on top.
map.layers.move('station-points', { after: 'connection-lines' });
map.addLayer({
  id: 'station-labels',
  type: 'labels',
  source: stations,
  style: {
    text: expr.field('name'),
    sizePx: 13,
    offsetPx: { x: 0, y: -16 },
    color: expr.when(expr.state('selected'), '#b45309', '#1f2937'),
  },
});

map.on('commit', (event) => {
  log(`commit r${event.revision} (rendered r${map.stats().renderedRevision})`);
});
map.on('selectchange', (event) => log(`selection: ${event.selected.length}`));
map.onFeature((event) => {
  if (event.type === 'click') log(`clicked ${String(event.feature.id)} (${event.layerId})`);
  if (event.type === 'dragend') log(`moved ${String(event.feature.id)} → ${JSON.stringify(event.position)}`);
});
map.on('pointer', (event) => {
  if (event.type === 'click') log('clicked background');
});

const refreshStats = () => {
  const stats = map.stats();
  const capabilities = map.capabilities();
  document.getElementById('stats').textContent = [
    `backend:      ${capabilities.backend}`,
    `revision:     ${stats.revision} / ${stats.renderedRevision}`,
    `features:     ${stats.features}`,
    `instances:    ${stats.instances}`,
    `draw calls:   ${stats.drawCalls}`,
    `GPU bytes:    ${stats.gpuBytes}`,
    `frames:       ${stats.frames}`,
  ].join('\n');
};
map.on('commit', refreshStats);
setInterval(refreshStats, 500);
refreshStats();

document.getElementById('btn-points').onclick = () => {
  let i = 0;
  const add = () => {
    stations.features.add({
      id: `extra-${i}`,
      geometry: { type: 'point', position: { lat: 49 + Math.sin(i) * 1.2, lng: 13.5 + Math.cos(i * 1.7) * 2.2 } },
      properties: { name: `Point ${i}`, status: i % 3 === 0 ? 'offline' : 'online' },
    });
    if (++i < 500) requestAnimationFrame(add);
  };
  add();
  log('adding 500 points…');
};
document.getElementById('btn-lines').onclick = () => {
  const items = [];
  for (let i = 0; i < 200; i++) {
    items.push({
      id: `route-${i}`,
      geometry: {
        type: 'lineString',
        positions: [
          { lat: 48.8 + i * 0.004, lng: 13 },
          { lat: 48.9 + i * 0.004, lng: 13.4 },
          { lat: 48.85 + i * 0.004, lng: 14.2 },
        ],
      },
      properties: {},
    });
  }
  connections.features.append(items);
  log('adding 200 lines…');
};
document.getElementById('btn-fills').onclick = () => {
  log(`polygon instances: ${map.debug.layerInstances('shape-fills')}`);
};
document.getElementById('btn-bind').onclick = async () => {
  stations.features.update('b', { geometry: { type: 'point', position: { lat: 49.5, lng: 17.2 } } });
  await map.whenRendered(map.stats().revision);
  log('updated point b and its connected line in one revision');
};
document.getElementById('btn-move').onclick = () => {
  stations.features.update('a', { geometry: { type: 'point', position: { lat: 50.2, lng: 14.9 } } });
};
let hiddenC = false;
document.getElementById('btn-hide').onclick = () => {
  hiddenC = !hiddenC;
  const ref = stations.features.ref('c');
  if (hiddenC) stationLayer.setFeatureStyle(ref, { visible: false });
  else stationLayer.clearFeatureStyle(ref);
  log(`point c: ${hiddenC ? 'hidden (visibility override)' : 'visible'}`);
};
document.getElementById('btn-fit').onclick = () => {
  map.fitBounds(
    { southwest: { lat: 48.5, lng: 12.0 }, northeast: { lat: 51.1, lng: 18.9 } },
    { padding: 40, maxZoom: 9 },
  );
};
document.getElementById('btn-zoom').onclick = () => {
  const view = map.getView();
  map.setView({ zoom: view.zoom + 1 });
};
document.querySelectorAll('#tile-buttons button').forEach((button) => {
  button.addEventListener('click', () => setTileMode(button.dataset.tile));
});

window.__maplet = { map, stations, connections, shapes, background, setTileMode };

// Signal for automated browser checks.
window.__mapletReady = true;
