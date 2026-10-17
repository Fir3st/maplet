import { openExample, action, ready, report, style } from './shared.js';

const map = await openExample();
const stations = map.addPoints(
  Array.from({ length: 12 }, (_, i) => ({
    id: `station-${i}`,
    position: { x: ((i % 4) - 1.5) * 0.35, y: (Math.floor(i / 4) - 1) * 0.3 },
    properties: { status: i % 3 === 0 ? 'offline' : 'online' },
  })),
  {
    id: 'stations',
    draggable: true,
    style: {
      minZoom: -1,
      radiusPx: style.when(style.state('selected'), 14, 10),
      color: style.by('status', { online: '#16724c', offline: '#c65b3b' }, '#66776d'),
      strokeColor: '#ffffff',
      strokeWidthPx: 3,
    },
  },
);
const first = stations.get('station-0');
stations.on('click', (event) => report(`Clicked ${event.feature.id}.`));
let online = false,
  hidden = false,
  moved = false;
action('Change first status', () => {
  online = !online;
  first.setProperties({ status: online ? 'online' : 'offline' });
  report(`station-0 is ${online ? 'online (green)' : 'offline (orange)'}.`);
});
action('Move first point', () => {
  moved = !moved;
  first.setPosition({ x: moved ? -0.75 : -0.525, y: -0.3 });
  report('Moved station-0; its identity and properties are unchanged.');
});
action('Hide / show first point', () => {
  hidden = !hidden;
  if (hidden) first.hide();
  else first.show();
  report(
    `station-0 is ${hidden ? 'hidden' : 'visible'}; the layer still contains ${stations.count()} points.`,
  );
});
await ready(map, { stations });
