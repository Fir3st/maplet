import { openExample, action, ready, report, expr } from './shared.js';

const map = await openExample();
const stations = map.sources.vector({ id: 'stations' });
stations.features.add(Array.from({ length: 12 }, (_, i) => ({
  id: `station-${i}`, geometry: { type: 'point', position: { x: (i % 4 - 1.5) * 0.35, y: (Math.floor(i / 4) - 1) * 0.3 } },
  properties: { status: i % 3 === 0 ? 'offline' : 'online' },
})));
const layer = map.layers.add({
  id: 'stations', type: 'points', source: stations, interaction: { enabled: true, draggable: true },
  style: {
    radiusPx: expr.when(expr.state('selected'), 14, 10),
    color: expr.match(expr.field('status'), { online: '#16724c', offline: '#c65b3b' }, '#66776d'),
    strokeColor: '#ffffff', strokeWidthPx: 3,
  },
});
let online = false, hidden = false, moved = false;
action('Change first status', () => {
  online = !online;
  stations.features.update('station-0', { properties: { status: online ? 'online' : 'offline' } });
  report(`station-0 is ${online ? 'online (green)' : 'offline (orange)'}.`);
});
action('Move first point', () => {
  moved = !moved;
  stations.features.update('station-0', { geometry: { type: 'point', position: { x: moved ? -0.75 : -0.525, y: -0.3 } } });
  report('Moved station-0; its identity and properties are unchanged.');
});
action('Hide / show first point', () => {
  hidden = !hidden;
  const ref = stations.features.ref('station-0');
  if (hidden) layer.features.setOverride(ref, { visible: false });
  else layer.features.clearOverride(ref);
  report(`station-0 is ${hidden ? 'hidden' : 'visible'}; the source still contains ${stations.features.count()} features.`);
});
await ready(map, { stations, layer });
