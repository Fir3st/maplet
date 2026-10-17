/**
 * One WMS endpoint, discovered. The map asks the service for its capabilities,
 * builds the layer list from that answer and requests only the checked layers.
 * Switching a layer calls setParams(); the previous tiles stay on screen until
 * their replacements decode, so the map never flashes blank.
 */
import { openExample, action, report, ready } from './shared.js';

// The service behind the Czech INSPIRE record for Prague's "Základní mapa"
// (base map) published by IPR Praha.
const ENDPOINT = 'https://gs-pub.praha.eu/arcgis/services/map/zakladni_mapa/MapServer/WMSServer';
const RECORD = 'https://geoportal.gov.cz/php/micka/record/basic/%7B98D8056D-D9D4-4D1B-AEF5-187E7BF0A1DB%7D?dlang=cze';
// Layer names published by the service: parcels, buildings, street segments,
// cadastral areas, city districts and the Prague boundary. This base map only
// draws its detail layers at close zooms, so the example starts there. Every
// other layer stays off until you ask for it.
const DEFAULT_LAYERS = ['6', '8', '13', '17', '19', '20'];

const map = await openExample({ geographic: true, center: [50.0875, 14.4207], zoom: 16 });
map.addControl('attribution');

const panel = document.createElement('section');
panel.className = 'panel';
const heading = document.createElement('h3');
heading.textContent = 'Service layers';
panel.append(heading);
const summary = document.createElement('p');
summary.textContent = 'Reading GetCapabilities…';
panel.append(summary);
document.querySelector('#example-extra').append(panel);

const data = { capabilities: null, wms: null, source: null };
const capabilities = await map.data.wmsCapabilities(ENDPOINT).catch((error) => {
  summary.textContent = `The endpoint did not answer (${error.message}).`;
  report('The WMS endpoint is unreachable — the rest of the page still works.', true);
  return null;
});
data.capabilities = capabilities;

if (capabilities) {
  action('Show the declared extent', () => {
    if (capabilities.bounds) {
      map.fitBounds(capabilities.bounds, { padding: 12 });
      report('Fitted to the extent the service declares — this base map only draws its detail layers at close zooms, so zoom back in.');
    }
  });
  const preferred = capabilities.preferred;
  if (!preferred) {
    summary.textContent = 'This service declares no CRS this library can request (only CRS:84, EPSG:4326 and EPSG:3857 have BBOX support).';
  } else {
    // `preferred` names the version, CRS and format the endpoint itself
    // supports, so one spread plus a layer list is a valid GetMap request.
    const wms = map.addWms(ENDPOINT, {
      id: 'wms-service',
      layers: DEFAULT_LAYERS.join(','),
      ...preferred,
      attribution: '© IPR Praha · Základní mapa (Czech INSPIRE geoportal)',
    });
    data.wms = wms;
    data.source = wms.source;

    const rows = [];
    const collect = (layer) => {
      if (layer.name) {
        const row = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = DEFAULT_LAYERS.includes(layer.name);
        const text = document.createElement('span');
        text.textContent = layer.title ?? layer.name;
        row.append(box, text);
        panel.append(row);
        rows.push({ layer, box });
      }
      for (const child of layer.children) collect(child);
    };
    for (const layer of capabilities.layers) collect(layer);

    const applySelection = () => {
      const selected = rows.filter((row) => row.box.checked).map((row) => row.layer.name);
      if (selected.length === 0) {
        wms.hide();
        report('Every layer is off — check one to draw the service again.');
        return;
      }
      wms.show();
      wms.source.setParams({ layers: selected.join(',') });
      report(`Requesting ${selected.length} of ${rows.length} layers: ${preferred.version} · ${preferred.crs} · ${preferred.format}.`);
    };
    for (const row of rows) row.box.addEventListener('change', applySelection);

    summary.textContent = `${rows.length} layers · ${capabilities.crs.join(' / ')}`;
    const record = document.createElement('p');
    const link = document.createElement('a');
    link.href = RECORD;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'The catalog record behind this endpoint ↗';
    record.append(link);
    panel.append(record);
    data.applySelection = applySelection;
    report(`Endpoint discovered: ${rows.length} layers, requesting ${preferred.crs} as ${preferred.format}.`);
  }
}

await ready(map, data);
