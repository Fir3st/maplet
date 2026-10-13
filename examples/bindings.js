import { openExample, action, ready, report, expr } from './shared.js';

const map = await openExample();
const stations = map.sources.vector({ id: 'stations' });
stations.features.add([
  { id: 'a', geometry: { type: 'point', position: { x: -0.5, y: -0.15 } }, properties: { name: 'Station A' } },
  { id: 'b', geometry: { type: 'point', position: { x: 0.5, y: 0.15 } }, properties: { name: 'Station B' } },
]);
const connections = map.sources.vector({ id: 'connections' });
connections.features.add({ id: 'a-b', geometry: { type: 'lineString', positions: [{ x: -0.5, y: -0.15 }, { x: 0.5, y: 0.15 }] }, properties: {} });
map.layers.add({ id: 'connections', type: 'lines', source: connections, style: { color: '#16724c', widthPx: 5 } });
map.layers.add({ id: 'stations', type: 'points', source: stations, interaction: { enabled: true, draggable: true },
  style: { color: '#bd573b', radiusPx: 13, strokeColor: '#fff', strokeWidthPx: 3 } });
map.layers.add({ id: 'names', type: 'labels', source: stations, style: { text: expr.field('name'), offsetPx: { x: 0, y: -26 }, sizePx: 14 } });
map.bindings.add({ id: 'route-geometry', target: connections.features.ref('a-b'),
  geometry: { kind: 'lineBetween', from: stations.features.ref('a'), to: stations.features.ref('b') } });
map.relations.add({ id: 'station-connection', type: 'connects', from: stations.features.ref('a'), to: stations.features.ref('b') });
let moved = false;
action('Move endpoint', async () => {
  moved = !moved;
  stations.features.update('b', { geometry: { type: 'point', position: { x: moved ? 0.3 : 0.5, y: moved ? -0.45 : 0.15 } } });
  await map.whenRendered();
  report('The endpoint and its derived line were updated in the same revision.');
});
map.on('feature', event => { if (event.type === 'dragend') report(`Moved ${event.feature.id}; the binding has already updated the line.`); });
await ready(map, { stations, connections });
