import { openExample, action, ready, report, style, boundsFromPositions } from './shared.js';

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const map = await openExample({ geographic: true, center: [50.0805, 14.43], zoom: 12.2 });
map.addTiles(OSM, { id: 'basemap', attribution: '© OpenStreetMap contributors' });
map.addControl('attribution');

const KINDS = { charging: 'Charging', service: 'Service', retail: 'Retail' };
const STATUS = {
  open: { label: 'Open', color: '#16724c' },
  busy: { label: 'Busy', color: '#c98a1b' },
  closed: { label: 'Closed', color: '#8b9a91' },
};
const kindOrder = ['charging', 'service', 'retail'];
const statusOrder = ['open', 'open', 'busy', 'closed'];

// Seeded synthetic data: 48 field sites around Prague with a repeating mix of
// kinds and states. The positions are illustrative; the basemap is real.
let seed = 0x51f3a7;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const sites = Array.from({ length: 48 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return {
    id: `site-${number}`,
    position: { lat: 50.043 + random() * 0.078, lng: 14.33 + random() * 0.115 },
    properties: {
      code: `S${number}`,
      kind: kindOrder[index % kindOrder.length],
      status: statusOrder[index % statusOrder.length],
      capacity: 4 + ((index * 7) % 46),
    },
  };
});
const byId = new Map(sites.map((site) => [site.id, site]));

const layer = map.addLayer({ id: 'field' });
const points = layer.addPoints(sites, {
  id: 'sites',
  style: {
    radiusPx: style.when(style.state('selected'), 9, style.when(style.state('hovered'), 8, 6)),
    color: style.by(
      'status',
      {
        open: STATUS.open.color,
        busy: STATUS.busy.color,
        closed: STATUS.closed.color,
      },
      '#66776d',
    ),
    // Filtering flips this one shared flag: the dots and their labels both read
    // it, so a filtered-out site can never leave a floating code behind.
    opacity: style.when(style.state('disabled'), 0, 1),
    strokeColor: '#ffffff',
    strokeWidthPx: 2,
  },
});
// Codes stay readable without covering the map at city zoom: collision culling
// drops overlapping labels and `minZoom` keeps them out of the overview.
layer.addLabels(points.source, {
  style: {
    text: style.when(style.state('disabled'), '', style.field('code')),
    sizePx: 11,
    color: '#263e33',
    offsetPx: { x: 0, y: -15 },
    collision: true,
    minZoom: 12.5,
  },
});

function detailNode(feature) {
  const box = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = String(feature.properties.code);
  const rows = document.createElement('div');
  const site = byId.get(String(feature.ref.id));
  rows.textContent = site
    ? `${KINDS[site.properties.kind]} · ${STATUS[site.properties.status].label} · capacity ${site.properties.capacity}`
    : '';
  box.append(title, rows);
  return box;
}

points.on('click', (event) => {
  const site = byId.get(String(event.feature.id));
  if (!site || !matches(site)) return;
  map.selection.clear();
  points.get(site.id)?.select();
  map.detail.open(event.feature, { content: detailNode });
  report(
    `${site.properties.code} · ${KINDS[site.properties.kind]} · ${STATUS[site.properties.status].label} · capacity ${site.properties.capacity}.`,
  );
});

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

let kind = 'all';
let openOnly = false;
const matches = (site) =>
  (kind === 'all' || site.properties.kind === kind) &&
  (!openOnly || site.properties.status === 'open');

const filterPanel = panel('Filter');
const chips = document.createElement('div');
chips.className = 'chips';
const chipButtons = new Map();
for (const [key, label] of [['all', 'All'], ...Object.entries(KINDS)]) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.textContent = label;
  chip.setAttribute('aria-pressed', String(key === kind));
  chip.addEventListener('click', () => {
    kind = key;
    apply();
    report(`${label}: the map, the labels and the count update together.`);
  });
  chips.append(chip);
  chipButtons.set(key, chip);
}
const openLabel = document.createElement('label');
const openBox = document.createElement('input');
openBox.type = 'checkbox';
openLabel.append(openBox, 'Only sites open now');
openBox.addEventListener('change', () => {
  openOnly = openBox.checked;
  apply();
  report(
    openOnly ? 'Closed and busy sites are hidden, not deleted.' : 'Every state is shown again.',
  );
});
const count = document.createElement('p');
filterPanel.append(chips, openLabel, count);

const viewPanel = panel('Current view');
const inView = document.createElement('p');
const inViewDetail = document.createElement('p');
viewPanel.append(inView, inViewDetail);

const legendPanel = panel('State');
const legend = document.createElement('ul');
legend.className = 'legend';
for (const { label, color } of Object.values(STATUS)) {
  const item = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = color;
  item.append(dot, label);
  legend.append(item);
}
legendPanel.append(legend);

/**
 * Recomputed on every view change, but only when the bounds actually moved:
 * an in-progress animation emits many `viewchange` events for one view.
 */
let lastViewKey = '';
function updateInView() {
  // Disabled features stay in the data, so the query result is filtered here
  // with the same rule the styles use: the counter matches what is on screen.
  const bounds = map.getBounds();
  if (!bounds) return;
  const key = `${bounds.southwest.lat},${bounds.southwest.lng},${bounds.northeast.lat},${bounds.northeast.lng}`;
  if (key === lastViewKey) return;
  lastViewKey = key;
  const result = map.query.area(bounds, { sources: [points.source.id], limit: 200 });
  const matching = result.items
    .map((item) => byId.get(String(item.ref.id)))
    .filter((site) => site && matches(site));
  inView.textContent = `${matching.length} matching ${matching.length === 1 ? 'site' : 'sites'} in view`;
  inViewDetail.textContent = result.next
    ? 'More results than one page; pan closer for the rest.'
    : `Matching sites total ${sites.filter(matches).length}.`;
}

function apply() {
  let visible = 0;
  for (const [key, chip] of chipButtons) chip.setAttribute('aria-pressed', String(key === kind));
  for (const site of sites) {
    const match = matches(site);
    map.state.set(points.get(site.id).ref, { disabled: !match });
    if (match) visible++;
  }
  count.textContent = `${visible} of ${sites.length} sites match`;
  lastViewKey = '';
  updateInView();
}

map.on('viewchange', updateInView);
map.on('viewend', updateInView);

action('Fit the matching sites', () => {
  const matching = sites.filter(matches);
  const bounds = boundsFromPositions(matching.map((site) => site.position));
  if (!bounds) {
    report('No site matches the current filter.');
    return;
  }
  map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
  report(`The view now covers ${matching.length} matching sites.`);
});
action('Reset filters', () => {
  kind = 'all';
  openOnly = false;
  openBox.checked = false;
  apply();
  report(`Every site is shown again: ${sites.length} total.`);
});
action('Clear the selection', () => {
  map.selection.clear();
  map.detail.close();
  report('Selection and detail closed; the filters stay as they are.');
});

apply();
await ready(map, { sites, points, layer });
