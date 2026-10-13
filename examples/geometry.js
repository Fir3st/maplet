import { openExample, action, ready, report } from './shared.js';

const map = await openExample();
const shapes = map.sources.vector({ id: 'shapes' });
shapes.features.add({ id: 'courtyard', properties: {}, geometry: { type: 'polygon', rings: [
  [{ x: -0.65, y: -0.42 }, { x: 0.65, y: -0.42 }, { x: 0.65, y: 0.42 }, { x: -0.65, y: 0.42 }],
  [{ x: -0.22, y: -0.16 }, { x: 0.22, y: -0.16 }, { x: 0.22, y: 0.16 }, { x: -0.22, y: 0.16 }],
] } });
const fills = map.layers.add({ id: 'site', type: 'fills', source: shapes,
  style: { fillColor: '#93bfa2', fillOpacity: 0.7, strokeColor: '#16724c', strokeWidthPx: 2 } });
const routes = map.sources.vector({ id: 'routes' });
routes.features.add({ id: 'route', properties: {}, geometry: { type: 'lineString', positions: [
  { x: -0.85, y: -0.55 }, { x: -0.4, y: -0.2 }, { x: -0.05, y: 0.03 }, { x: 0.4, y: 0.06 }, { x: 0.82, y: 0.55 },
] } });
const route = map.layers.add({ id: 'route', type: 'lines', source: routes, style: { color: '#bd573b', widthPx: 5 } });
let fillVisible = true, routeVisible = true;
action('Toggle polygon', () => { fillVisible = !fillVisible; fills.setVisible(fillVisible); report(`Polygon ${fillVisible ? 'visible' : 'hidden'}.`); });
action('Toggle route', () => { routeVisible = !routeVisible; route.setVisible(routeVisible); report(`Route ${routeVisible ? 'visible' : 'hidden'}.`); });
await ready(map, { shapes, routes });
