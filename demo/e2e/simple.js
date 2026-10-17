/**
 * Planar (Simple CRS) scene for the e2e driver: positions are `{ x, y }` map
 * units, never lat/lng. The scenarios move points through the public API and
 * through real pointer drags and assert the rendered pixels.
 */
import { createMap, crs } from '../../dist/index.js';

const backend = new URLSearchParams(location.search).get('backend');

const map = await createMap('map', {
  projection: crs.simple(),
  renderer:
    backend === 'webgpu'
      ? { primary: 'webgpu', fallback: false }
      : { primary: 'webgl1', fallback: false },
  size: { width: 640, height: 480 },
  center: { x: 0, y: 0 },
  zoom: 6,
  minZoom: 0,
  maxZoom: 12,
});

const floor = map.data.vector({ id: 'floor' });
await floor.features.replace([
  {
    id: 'white',
    geometry: {
      type: 'rectangle',
      southwest: { x: -0.05, y: 0.04 },
      northeast: { x: 0.05, y: -0.04 },
    },
  },
]);

const marks = map.data.vector({ id: 'marks' });
await marks.features.replace([
  {
    id: 'm1',
    geometry: { type: 'point', position: { x: -0.006, y: 0.003 } },
    properties: { name: 'M1' },
  },
  {
    id: 'm2',
    geometry: { type: 'point', position: { x: 0.009, y: -0.005 } },
    properties: { name: 'M2' },
  },
]);

map.addLayer({
  id: 'floor',
  type: 'fills',
  source: floor,
  interactive: false,
  style: { fillColor: '#ffffff', fillOpacity: 1, strokeWidthPx: 0 },
});
map.addLayer({
  id: 'marks',
  type: 'points',
  source: marks,
  interactive: true,
  draggable: true,
  style: { radiusPx: 8, color: '#db2777' },
});

window.__e2e = {
  ready: false,
  map,
  marks,
  COLORS: { mark: [219, 39, 119], background: [255, 255, 255] },
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
