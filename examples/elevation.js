import { openExample, action, ready, report, haversineMeters } from './shared.js';

// A ridge trail as GeoJSON: each coordinate carries its altitude as the third
// value, the convention GPS exports and elevation APIs use. Maplet keeps it
// through the import and returns it from `exportGeoJson` — the profile below
// is drawn from that exported data, not from this input.
const trail = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'ridge-trail',
      properties: { name: 'Ridge trail' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [15.712, 50.723, 769],
          [15.7168, 50.7252, 842],
          [15.7201, 50.7279, 897],
          [15.7238, 50.7293, 968],
          [15.7274, 50.7301, 1054],
          [15.7312, 50.7297, 1148],
          [15.7349, 50.7308, 1236],
          [15.7388, 50.7326, 1329],
          [15.7421, 50.7347, 1408],
          [15.7448, 50.7368, 1469],
          [15.7469, 50.7386, 1541],
          [15.7483, 50.7395, 1602],
        ],
      },
    },
  ],
};

const map = await openExample({ geographic: true, center: [50.7305, 15.73], zoom: 14 });
const trails = map.data.vector({ id: 'trails' });
await trails.importGeoJson(trail);
map.addLayer({
  id: 'ridge-trail',
  type: 'lines',
  source: trails,
  interactive: false,
  style: { color: '#bd573b', widthPx: 5, cap: 'round' },
});

// Read the route back from the map: the import accepted the third coordinate,
// and the export hands it back on every vertex that has one.
const coordinates = trails.exportGeoJson().features[0].geometry.coordinates;
const profile = coordinates.map(([lng, lat, altitude], index) => ({
  index,
  lng,
  lat,
  altitude,
  at: { lat, lng },
}));
const lowest = Math.min(...profile.map((point) => point.altitude));
const highest = Math.max(...profile.map((point) => point.altitude));
const summit = profile.reduce(
  (best, point) => (point.altitude > best.altitude ? point : best),
  profile[0],
);
let distance = 0,
  ascent = 0;
for (let i = 1; i < profile.length; i++) {
  distance += haversineMeters(profile[i - 1].at, profile[i].at);
  ascent += Math.max(0, profile[i].altitude - profile[i - 1].altitude);
}

const panel = document.createElement('div');
panel.className = 'panel';
const heading = document.createElement('h3');
heading.textContent = 'Elevation profile';
const rows = document.createElement('dl');
rows.className = 'rows';
const row = (label) => {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  rows.append(dt, dd);
  return dd;
};
const routeCell = row('Route');
const ascentCell = row('Ascent');
const altitudeCell = row('At the cursor');
const positionCell = row('Coordinates');
routeCell.textContent = `${(distance / 1000).toFixed(2)} km`;
ascentCell.textContent = `${Math.round(ascent)} m`;

const SVG = 'http://www.w3.org/2000/svg';
const PAD = { left: 6, right: 6, top: 16, bottom: 22 };
const chartX = (index) => PAD.left + (index / (profile.length - 1)) * (300 - PAD.left - PAD.right);
const chartY = (altitude) =>
  132 - PAD.bottom - ((altitude - lowest) / (highest - lowest)) * (132 - PAD.top - PAD.bottom);
const chart = document.createElementNS(SVG, 'svg');
chart.setAttribute('viewBox', '0 0 300 132');
chart.setAttribute('role', 'img');
chart.setAttribute(
  'aria-label',
  `Elevation profile of the ridge trail, ${lowest} to ${highest} metres`,
);
chart.style.width = '100%';
chart.style.height = 'auto';
chart.style.display = 'block';
const points = profile.map(
  (point) => `${chartX(point.index).toFixed(1)} ${chartY(point.altitude).toFixed(1)}`,
);
const area = document.createElementNS(SVG, 'path');
area.setAttribute(
  'd',
  `M ${chartX(0).toFixed(1)} ${132 - PAD.bottom} L ${points.join(' L ')} ` +
    `L ${chartX(profile.length - 1).toFixed(1)} ${132 - PAD.bottom} Z`,
);
area.setAttribute('fill', 'rgba(189, 87, 59, 0.16)');
const line = document.createElementNS(SVG, 'polyline');
line.setAttribute('points', points.join(' '));
line.setAttribute('fill', 'none');
line.setAttribute('stroke', '#bd573b');
line.setAttribute('stroke-width', '2');
line.setAttribute('stroke-linejoin', 'round');
const dots = document.createElementNS(SVG, 'g');
for (const point of profile) {
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', chartX(point.index).toFixed(1));
  dot.setAttribute('cy', chartY(point.altitude).toFixed(1));
  dot.setAttribute('r', '2.4');
  dot.setAttribute('fill', '#fff');
  dot.setAttribute('stroke', '#bd573b');
  dot.setAttribute('stroke-width', '1.4');
  dots.append(dot);
}
const crosshair = document.createElementNS(SVG, 'line');
crosshair.setAttribute('y1', String(PAD.top - 6));
crosshair.setAttribute('y2', String(132 - PAD.bottom + 3));
crosshair.setAttribute('stroke', '#2563eb');
crosshair.setAttribute('stroke-width', '1.2');
crosshair.setAttribute('stroke-dasharray', '3 3');
const activeDot = document.createElementNS(SVG, 'circle');
activeDot.setAttribute('r', '4.6');
activeDot.setAttribute('fill', '#2563eb');
activeDot.setAttribute('stroke', '#fff');
activeDot.setAttribute('stroke-width', '1.6');
const topLabel = document.createElementNS(SVG, 'text');
topLabel.setAttribute('x', '8');
topLabel.setAttribute('y', '11');
topLabel.setAttribute('font-size', '9');
topLabel.setAttribute('fill', '#65756c');
topLabel.textContent = `${highest} m`;
const bottomLabel = topLabel.cloneNode(true);
bottomLabel.setAttribute('y', '130');
bottomLabel.textContent = `${lowest} m`;
chart.append(area, line, dots, crosshair, activeDot, topLabel, bottomLabel);

const slider = document.createElement('input');
slider.type = 'range';
slider.min = '0';
slider.max = String(profile.length - 1);
slider.step = '1';
slider.setAttribute('aria-label', 'Position on the profile');
const hint = document.createElement('p');
hint.textContent =
  'Move over the profile or scrub the slider: the pin follows the route. ' +
  'The chart is drawn from exportGeoJson(), so it proves every altitude survived the import.';
panel.append(heading, chart, slider, rows, hint);

const marker = map.addMarker({
  id: 'profile-cursor',
  position: summit.at,
  iconTint: '#2563eb',
  tooltip: { content: `${Math.round(summit.altitude)} m`, permanent: true },
});
let active = summit;
function setActive(point, { announce = false } = {}) {
  active = point;
  marker.setPosition(point.at);
  marker.setTooltip({ content: `${Math.round(point.altitude)} m`, permanent: true });
  crosshair.setAttribute('x1', chartX(point.index).toFixed(1));
  crosshair.setAttribute('x2', chartX(point.index).toFixed(1));
  activeDot.setAttribute('cx', chartX(point.index).toFixed(1));
  activeDot.setAttribute('cy', chartY(point.altitude).toFixed(1));
  altitudeCell.textContent = `${Math.round(point.altitude)} m`;
  positionCell.textContent = `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;
  if (slider.value !== String(point.index)) slider.value = String(point.index);
  if (announce) report(`${point.altitude} m at ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}.`);
}

chart.addEventListener('pointermove', (event) => {
  const rect = chart.getBoundingClientRect();
  const chartPosition = ((event.clientX - rect.left) / rect.width) * 300;
  let nearest = profile[0];
  for (const point of profile) {
    if (
      Math.abs(chartX(point.index) - chartPosition) <
      Math.abs(chartX(nearest.index) - chartPosition)
    )
      nearest = point;
  }
  if (nearest !== active) setActive(nearest);
});
slider.addEventListener('input', () => setActive(profile[Number(slider.value)]));
slider.addEventListener('change', () => setActive(active, { announce: true }));

const exportBox = document.createElement('textarea');
exportBox.readOnly = true;
exportBox.hidden = true;
exportBox.rows = 8;
exportBox.setAttribute('aria-label', 'Exported GeoJSON');
panel.append(exportBox);
const exportAction = action('Show exported GeoJSON', () => {
  if (exportBox.hidden) {
    exportBox.value = JSON.stringify(trails.exportGeoJson(), null, 2);
    exportBox.hidden = false;
    exportAction.textContent = 'Hide exported GeoJSON';
    report('Exported from the store: every vertex keeps [lng, lat, altitude].');
  } else {
    exportBox.hidden = true;
    exportAction.textContent = 'Show exported GeoJSON';
    report('Exported view hidden.');
  }
});

document.querySelector('#example-extra').append(panel);
setActive(summit);
await ready(map, { trails, profile, marker });
