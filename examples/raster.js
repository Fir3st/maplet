import { openExample, action, ready, report } from './shared.js';

const map = await openExample({ geographic: true });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf2ed"/><path d="M0 0H256V256H0Z M128 0V256 M0 128H256" fill="none" stroke="#bdcdbf" stroke-width="2"/><text x="20" y="34" font-family="sans-serif" font-size="15" fill="#4b6855">Maplet · demo tile</text></svg>';
const inlineTile = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const tiles = map.addTiles(inlineTile, { id: 'basemap', attribution: 'Maplet synthetic SVG tiles' });
map.addControl('attribution');
map.addPoints([{ id: 'prague', position: [50.08, 14.43] }], {
  style: { color: '#bd573b', radiusPx: 10, strokeColor: '#fff', strokeWidthPx: 3 },
});
action('Use demo tiles', () => {
  tiles.source.update({ url: inlineTile, attribution: 'Maplet synthetic SVG tiles' });
  report('Inline SVG tiles: no external network requests.');
});
action('Use OpenStreetMap', () => {
  tiles.source.update({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' });
  report('Requesting live OpenStreetMap tiles. Attribution is shown on the map; a network connection is required.');
});
await ready(map, { tiles });
