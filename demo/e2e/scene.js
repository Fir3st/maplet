/**
 * Controlled scene for the browser e2e driver scenarios.
 *
 * No tiles, fixed view and fixed colours, so a scenario can assert on the real
 * rendered pixels: blue points, purple binding link, orange fill plate, red
 * route line and a green target point. Everything is reachable through the
 * public handles on `window.__e2e`.
 */
import { createMap } from '../../dist/index.js';

const backend = new URLSearchParams(location.search).get('backend');

const map = await createMap('map', {
  renderer:
    backend === 'webgpu'
      ? { primary: 'webgpu', fallback: false }
      : { primary: 'webgl1', fallback: false },
  size: { width: 640, height: 480 },
  center: { lat: 50.0, lng: 14.05 },
  zoom: 10,
});

const backdrop = map.data.vector({ id: 'backdrop' });
await backdrop.features.replace([
  {
    id: 'white',
    geometry: {
      type: 'rectangle',
      southwest: { lat: 49.7, lng: 13.7 },
      northeast: { lat: 50.3, lng: 14.4 },
    },
  },
]);

const points = map.data.vector({ id: 'points' });
await points.features.replace([
  {
    id: 'p1',
    geometry: { type: 'point', position: { lat: 50.02, lng: 14.02 } },
    properties: { name: 'P1', status: 'ok' },
  },
  {
    id: 'p2',
    geometry: { type: 'point', position: { lat: 50.02, lng: 14.08 } },
    properties: { name: 'P2', status: 'ok' },
  },
  {
    id: 'p3',
    geometry: { type: 'point', position: { lat: 49.955, lng: 14.12 } },
    properties: { name: 'P3', status: 'warn' },
  },
]);

const links = map.data.vector({ id: 'links' });
await links.features.replace([
  {
    id: 'l1',
    geometry: {
      type: 'lineString',
      positions: [
        { lat: 50.02, lng: 14.02 },
        { lat: 50.02, lng: 14.08 },
      ],
    },
  },
]);

const shapes = map.data.vector({ id: 'shapes' });
await shapes.features.replace([
  {
    id: 'plate',
    geometry: {
      type: 'rectangle',
      southwest: { lat: 49.965, lng: 14.01 },
      northeast: { lat: 49.995, lng: 14.08 },
    },
  },
]);

const routes = map.data.vector({ id: 'routes' });
await routes.features.replace([
  {
    id: 'r1',
    geometry: {
      type: 'lineString',
      positions: [
        { lat: 49.94, lng: 14.0 },
        { lat: 49.94, lng: 14.1 },
      ],
    },
  },
]);

const targets = map.data.vector({ id: 'targets' });
await targets.features.replace([
  {
    id: 't1',
    geometry: { type: 'point', position: { lat: 50.0, lng: 14.04 } },
    properties: { name: 'T1' },
  },
]);

map.addLayer({
  id: 'backdrop',
  type: 'fills',
  source: backdrop,
  interactive: false,
  style: { fillColor: '#ffffff', fillOpacity: 1, strokeWidthPx: 0 },
});
map.addLayer({
  id: 'plate',
  type: 'fills',
  source: shapes,
  style: { fillColor: '#f97316', fillOpacity: 1, strokeWidthPx: 0 },
});
map.addLayer({
  id: 'route',
  type: 'lines',
  source: routes,
  style: { color: '#dc2626', widthPx: 4 },
});
map.addLayer({
  id: 'links',
  type: 'lines',
  source: links,
  style: { color: '#7c3aed', widthPx: 3 },
});
map.addLayer({
  id: 'target',
  type: 'points',
  source: targets,
  style: { radiusPx: 5, color: '#16a34a' },
});
map.addLayer({
  id: 'points',
  type: 'points',
  source: points,
  interactive: true,
  draggable: true,
  style: { radiusPx: 6, color: '#2563eb' },
});

map.bindings.add({
  id: 'link-1-geometry',
  target: links.features.ref('l1'),
  geometry: {
    kind: 'lineBetween',
    from: points.features.ref('p1'),
    to: points.features.ref('p2'),
  },
});

map.relations.add({
  id: 'p1-p2',
  type: 'near',
  from: points.features.ref('p1'),
  to: points.features.ref('p2'),
});

map.addControl({ id: 'zoom', kind: 'zoom', position: 'top-left' });

const COLORS = {
  point: [37, 99, 235],
  link: [124, 58, 237],
  plate: [249, 115, 22],
  route: [220, 38, 38],
  target: [22, 163, 74],
  background: [255, 255, 255],
};

window.__e2e = {
  ready: false,
  map,
  COLORS,
  points,
  links,
  shapes,
  routes,
  targets,
  ref: (source, id) => source.features.ref(id),
  positionOf: (source, id) => source.features.get(id).geometry.position,
  screenOf: (position) => map.positionToScreen(position),
  samplePixel: (x, y) => map.debug.samplePixel({ x, y }),
  pixel: (position) => {
    const screen = map.positionToScreen(position);
    return map.debug.samplePixel({ x: Math.round(screen.x), y: Math.round(screen.y) });
  },
  rendered: (revision) => map.whenRendered(revision),
  view: () => map.getView(),
  stats: () => map.stats(),
};

await map.whenRendered(map.stats().revision);
window.__e2e.ready = true;
