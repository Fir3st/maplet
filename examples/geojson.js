import { openExample, action, ready, report } from './shared.js';

const map = await openExample({ geographic: true });
const places = map.sources.vector({ id: 'imported-places' });
map.layers.add({ id: 'places', type: 'points', source: places, style: { radiusPx: 10, color: '#16724c', strokeColor: '#fff', strokeWidthPx: 3 } });
const label = document.createElement('label');
label.htmlFor = 'geojson-input'; label.textContent = 'GeoJSON FeatureCollection';
const input = document.createElement('textarea');
input.id = 'geojson-input'; input.rows = 9; input.spellcheck = false;
input.value = JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'a', properties: { name: 'West' }, geometry: { type: 'Point', coordinates: [14.415, 50.08] } },
  { type: 'Feature', id: 'b', properties: { name: 'East' }, geometry: { type: 'Point', coordinates: [14.445, 50.082] } },
] }, null, 2);
document.querySelector('#example-extra').append(label, input);
async function importInput() {
  if (new TextEncoder().encode(input.value).length > 65536) throw new Error('Keep the example input below 64 KiB.');
  const data = JSON.parse(input.value);
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > 100 ||
      data.features.some(feature => feature.geometry?.type !== 'Point')) {
    throw new Error('Use a FeatureCollection with at most 100 Point features.');
  }
  await places.importGeoJson(data);
  await map.whenRendered();
  report(`Imported ${places.features.count()} places. Coordinates are [longitude, latitude].`);
}
action('Import GeoJSON', importInput);
action('Export current data', () => { input.value = JSON.stringify(places.exportGeoJson(), null, 2); report('The editor now contains an export of the accepted source data.'); });
await importInput();
await ready(map, { places });
