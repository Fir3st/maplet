import { openExample, action, ready, report, boundsFromPositions } from './shared.js';

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OFFLINE_TILE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf2ed"/>' +
      '<path d="M0 0H256V256H0Z M128 0V256 M0 128H256" fill="none" stroke="#bdcdbf" stroke-width="2"/>' +
      '<text x="20" y="34" font-family="sans-serif" font-size="15" fill="#4b6855">Maplet · demo tile</text></svg>',
  );

const map = await openExample({ geographic: true, center: [50.0875, 14.4213], zoom: 13.4 });
const basemap = map.addTiles(OSM, { id: 'basemap', attribution: '© OpenStreetMap contributors' });
map.addControl('attribution');

const KINDS = {
  sight: { label: 'Sight', tint: '#2563eb' },
  museum: { label: 'Museum', tint: '#7c3aed' },
  park: { label: 'Park', tint: '#16724c' },
};
// The built-in pin is blue and `iconTint` multiplies the texture, so category
// colours need a white-bodied asset with the same silhouette and a translucent
// dark rim and dot that survive tinting.
const PIN =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<path d="M16 31.2C13.9 27.1 6.7 20.6 6.7 12.2A9.3 9.3 0 1 1 25.3 12.2C25.3 20.6 18.1 27.1 16 31.2Z" fill="#ffffff" stroke="rgba(15,23,42,0.30)" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<circle cx="16" cy="12.2" r="3.7" fill="rgba(15,23,42,0.30)"/></svg>',
  );
map.assets.addImage({ id: 'guide-pin', src: PIN });
// Approximate coordinates of well-known places: enough for a guide, and the
// basemap underneath is real. An application would read them from its CMS.
const places = [
  { id: 'castle', name: 'Prague Castle', kind: 'sight', at: [50.091, 14.4016] },
  { id: 'charles', name: 'Charles Bridge', kind: 'sight', at: [50.0865, 14.4114] },
  { id: 'oldtown', name: 'Old Town Square', kind: 'sight', at: [50.0875, 14.4213] },
  { id: 'petrin', name: 'Petřín Tower', kind: 'sight', at: [50.0837, 14.395] },
  { id: 'museum', name: 'National Museum', kind: 'museum', at: [50.079, 14.4305] },
  { id: 'letna', name: 'Letná Park', kind: 'park', at: [50.0973, 14.4162] },
  { id: 'zoo', name: 'Prague Zoo', kind: 'park', at: [50.1172, 14.406] },
  { id: 'vysehrad', name: 'Vyšehrad', kind: 'park', at: [50.0647, 14.4179] },
];

// Popup content is a DOM node: string data renders as text and never becomes HTML.
function popupContent(place) {
  const box = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = place.name;
  const line = document.createElement('div');
  line.textContent = `${KINDS[place.kind].label} · ${place.at[0].toFixed(4)}, ${place.at[1].toFixed(4)}`;
  box.append(title, line);
  return box;
}

const markers = map.addMarkers(
  places.map((place) => ({
    id: place.id,
    position: place.at,
    icon: 'guide-pin',
    iconTint: KINDS[place.kind].tint,
    tooltip: `${place.name} · ${KINDS[place.kind].label}`,
    popup: { content: popupContent(place) },
  })),
);

const extra = document.querySelector('#example-extra');
const panel = (title) => {
  const section = document.createElement('div');
  section.className = 'panel';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);
  extra.append(section);
  return section;
};

// Category filter over the same records the markers were built from.
let kind = 'all';
const filterPanel = panel('Category');
const chips = document.createElement('div');
chips.className = 'chips';
const chipButtons = new Map();
for (const [key, meta] of [['all', { label: 'All' }], ...Object.entries(KINDS)]) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.textContent = meta.label;
  chip.setAttribute('aria-pressed', String(key === kind));
  chip.addEventListener('click', () => {
    kind = key;
    applyFilter();
    report(
      key === 'all'
        ? `Showing every category: ${places.length} places.`
        : `Showing ${KINDS[key].label.toLowerCase()} places only.`,
    );
  });
  chips.append(chip);
  chipButtons.set(key, chip);
}
filterPanel.append(chips);

// The list is the same data as the map, reachable by keyboard and by click.
const count = document.createElement('p');
const listPanel = panel('Places');
const list = document.createElement('ul');
list.className = 'place-list';
const listButtons = new Map();
for (const place of places) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = place.name;
  button.addEventListener('click', () => focusPlace(place.id));
  item.append(button);
  list.append(item);
  listButtons.set(place.id, button);
}
listPanel.append(list, count);

function applyFilter() {
  let visible = 0;
  for (const [key, chip] of chipButtons) chip.setAttribute('aria-pressed', String(key === kind));
  places.forEach((place, index) => {
    const match = kind === 'all' || place.kind === kind;
    if (match) {
      markers[index].show();
      visible++;
    } else markers[index].hide();
    listButtons.get(place.id).hidden = !match;
  });
  count.textContent = `${visible} of ${places.length} places shown`;
}

function select(place) {
  for (const [key, button] of listButtons)
    button.setAttribute('aria-current', String(key === place.id));
}

async function focusPlace(id) {
  const index = places.findIndex((place) => place.id === id);
  const place = places[index];
  select(place);
  await map.flyTo({ center: place.at, zoom: Math.max(map.getZoom(), 15) }, { duration: 600 });
  markers[index].openPopup();
  report(`${place.name} · ${KINDS[place.kind].label}. The popup follows the pin while you pan.`);
}

// A marker click keeps the list and the selection in sync with the map.
places.forEach((place, index) => {
  markers[index].on('click', () => {
    select(place);
    listButtons.get(place.id)?.scrollIntoView({ block: 'nearest' });
    report(`${place.name} · ${KINDS[place.kind].label}.`);
  });
});

action('Fit every place', () => {
  kind = 'all';
  applyFilter();
  map.fitBounds(boundsFromPositions(places.map((place) => place.at)), { padding: 60, maxZoom: 14 });
  report(`The view covers all ${places.length} places.`);
});
action('Where am I?', async () => {
  const result = await map.locate({ setView: true });
  report(
    result.ok
      ? `Your position: ${result.position.lat.toFixed(4)}, ${result.position.lng.toFixed(4)}.`
      : `Geolocation unavailable (${result.code}); the map stays where it was.`,
  );
});
let osm = true;
const tilesAction = action('Use offline demo tiles', () => {
  osm = !osm;
  basemap.source.update({
    url: osm ? OSM : OFFLINE_TILE,
    attribution: osm ? '© OpenStreetMap contributors' : 'Maplet synthetic SVG tiles',
  });
  tilesAction.textContent = osm ? 'Use offline demo tiles' : 'Use OpenStreetMap tiles';
  report(
    osm
      ? 'Live OpenStreetMap tiles; attribution follows the active source.'
      : 'Inline SVG tiles: the example works without a network connection.',
  );
});

applyFilter();
await ready(map, { places, markers, basemap });
