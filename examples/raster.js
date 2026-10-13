import { openExample, action, ready, report } from './shared.js';

const map = await openExample({ geographic: true });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf2ed"/><path d="M0 0H256V256H0Z M128 0V256 M0 128H256" fill="none" stroke="#bdcdbf" stroke-width="2"/><text x="20" y="34" font-family="sans-serif" font-size="15" fill="#4b6855">Maplet · demo tile</text></svg>';
const inlineTile = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const tiles = map.sources.rasterTiles({ id: 'basemap', url: inlineTile, attribution: 'Maplet synthetic SVG tiles' });
map.layers.add({ id: 'basemap', type: 'raster', source: tiles });
map.controls.add({ id: 'attribution', kind: 'attribution' });
const places = map.sources.vector({ id: 'places' });
places.features.add({ id: 'prague', properties: {}, geometry: { type: 'point', position: { lat: 50.08, lng: 14.43 } } });
map.layers.add({ id: 'places', type: 'points', source: places, style: { color: '#bd573b', radiusPx: 10, strokeColor: '#fff', strokeWidthPx: 3 } });
action('Use demo tiles', () => {
  tiles.update({ url: inlineTile, attribution: 'Maplet synthetic SVG tiles' });
  report('Inline SVG tiles: no external network requests.');
});
action('Use OpenStreetMap', () => {
  tiles.update({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' });
  report('Requesting live OpenStreetMap tiles. Attribution is shown on the map; a network connection is required.');
});
await ready(map, { tiles });
