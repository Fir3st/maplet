import { openExample, action, ready, report, expr } from './shared.js';

const map = await openExample();
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40"><path d="M16 0C7 0 0 7 0 16c0 12 16 24 16 24s16-12 16-24C32 7 25 0 16 0" fill="#16724c"/><circle cx="16" cy="16" r="6" fill="white"/></svg>';
map.assets.addImage({ id: 'pin', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
const places = map.sources.vector({ id: 'places' });
places.features.add(['River walk', 'Příliš žluťoučký', 'Market square', 'Garden'].map((name, i) => ({
  id: `place-${i}`, properties: { name }, geometry: { type: 'point', position: { x: (i % 2 - 0.5) * 0.8, y: (Math.floor(i / 2) - 0.5) * 0.55 } },
})));
map.layers.add({ id: 'pins', type: 'points', source: places, interaction: { enabled: true, draggable: true },
  style: { icon: 'pin', iconSize: 32, iconAnchor: { x: 0, y: -16 }, color: '#16724c', radiusPx: 8 } });
const labels = map.layers.add({ id: 'labels', type: 'labels', source: places,
  style: { text: expr.field('name'), color: '#263e33', sizePx: 14, collision: true, offsetPx: { x: 0, y: -42 } } });
let visible = true, renamed = false;
action('Toggle labels', () => { visible = !visible; labels.setVisible(visible); report(`Labels ${visible ? 'visible' : 'hidden'}; the pins remain on the map.`); });
action('Rename first place', () => {
  renamed = !renamed;
  places.features.update('place-0', { properties: { name: renamed ? 'New riverside name' : 'River walk' } });
  report('The label reads the updated name from the same feature.');
});
await ready(map, { places });
