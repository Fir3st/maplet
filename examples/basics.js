import { openExample, action, ready, report } from './shared.js';

const map = await openExample({ geographic: true, center: [49.7, 15.2], zoom: 7 });
const placesLayer = map.addLayer({ id: 'places' });
const places = placesLayer.addPoints(
  [
    { id: 'praha', position: [50.08, 14.44], properties: { name: 'Praha' } },
    { id: 'brno', position: [49.19, 16.61], properties: { name: 'Brno' } },
    { id: 'plzen', position: [49.74, 13.37], properties: { name: 'Plzeň' } },
  ],
  { style: { color: '#16724c', radiusPx: 10, strokeColor: '#ffffff', strokeWidthPx: 3 } },
);
placesLayer.addLabels(places.source, {
  style: { sizePx: 15, color: '#263e33', offsetPx: { x: 0, y: -23 } },
});
places.on('click', (event) => {
  map.detail.open(event.feature, { content: (feature) => String(feature.properties.name) });
  report(`Selected ${event.feature.id}. Its details are anchored to the feature.`);
});
action('Fit all places', () => {
  map.fitBounds(places.getBounds(), { padding: 60, maxZoom: 8 });
  report('The view now contains all three places.');
});
action('Inspect Praha', () => {
  map.detail.open(places.get('praha').ref, {
    content: (feature) => String(feature.properties.name),
  });
  report('Opened the Praha detail through the same API used by map clicks.');
});
await ready(map, { places, placesLayer });
