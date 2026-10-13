import { openExample, action, ready, report, expr } from './shared.js';

const map = await openExample({ geographic: true, center: { lat: 49.7, lng: 15.2 }, zoom: 7 });
const places = map.sources.vector({ id: 'places' });
places.features.add([
  { id: 'praha', geometry: { type: 'point', position: { lat: 50.08, lng: 14.44 } }, properties: { name: 'Praha' } },
  { id: 'brno', geometry: { type: 'point', position: { lat: 49.19, lng: 16.61 } }, properties: { name: 'Brno' } },
  { id: 'plzen', geometry: { type: 'point', position: { lat: 49.74, lng: 13.37 } }, properties: { name: 'Plzeň' } },
]);
map.layers.add({ id: 'places', type: 'points', source: places,
  style: { color: '#16724c', radiusPx: 10, strokeColor: '#ffffff', strokeWidthPx: 3 } });
map.layers.add({ id: 'names', type: 'labels', source: places,
  style: { text: expr.field('name'), sizePx: 15, color: '#263e33', offsetPx: { x: 0, y: -23 } } });
map.on('feature', event => {
  if (event.type === 'click') {
    map.detail.open(event.feature, { content: feature => String(feature.properties.name) });
    report(`Selected ${event.feature.id}. Its details are anchored to the feature.`);
  }
});
action('Fit all places', () => {
  map.view.fit({ southwest: { lat: 49.19, lng: 13.37 }, northeast: { lat: 50.08, lng: 16.61 } }, { padding: 60, maxZoom: 8 });
  report('The view now contains all three places.');
});
action('Inspect Praha', () => {
  map.detail.open(places.features.ref('praha'), { content: feature => String(feature.properties.name) });
  report('Opened the Praha detail through the same API used by map clicks.');
});
await ready(map, { places });
