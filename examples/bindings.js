import { openExample, action, ready, report } from './shared.js';

const map = await openExample();
const network = map.addLayer({ id: 'network' });
const stations = network.addPoints(
  [
    { id: 'a', position: { x: -0.5, y: -0.15 }, properties: { name: 'Station A' } },
    { id: 'b', position: { x: 0.5, y: 0.15 }, properties: { name: 'Station B' } },
  ],
  {
    id: 'stations',
    draggable: true,
    style: { minZoom: -1, color: '#bd573b', radiusPx: 13, strokeColor: '#fff', strokeWidthPx: 3 },
  },
);
const connections = network.addLines(
  [
    {
      id: 'a-b',
      positions: [
        { x: -0.5, y: -0.15 },
        { x: 0.5, y: 0.15 },
      ],
    },
  ],
  {
    id: 'connections',
    style: { minZoom: -1, color: '#16724c', widthPx: 5 },
  },
);
connections.move({ before: stations.id });
network.addLabels(stations.source, {
  style: { minZoom: -1, offsetPx: { x: 0, y: -26 }, sizePx: 14 },
});
const a = stations.get('a'),
  b = stations.get('b');
map.bindings.add({
  id: 'route-geometry',
  target: connections.get('a-b').ref,
  geometry: { kind: 'lineBetween', from: a.ref, to: b.ref },
});
map.relations.add({ id: 'station-connection', type: 'connects', from: a.ref, to: b.ref });
let moved = false;
action('Move endpoint', async () => {
  moved = !moved;
  b.setPosition({ x: moved ? 0.3 : 0.5, y: moved ? -0.45 : 0.15 });
  await map.whenRendered();
  report('The endpoint and its derived line were updated in the same revision.');
});
stations.on('dragend', (event) =>
  report(`Moved ${event.feature.id}; the binding has already updated the line.`),
);
await ready(map, { network, stations, connections });
