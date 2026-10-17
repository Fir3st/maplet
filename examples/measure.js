import { openExample, action, ready, report, style, haversineMeters } from './shared.js';

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const map = await openExample({ geographic: true, center: [50.0905, 14.4195], zoom: 15 });
map.addTiles(OSM, { id: 'basemap', attribution: '© OpenStreetMap contributors' });
map.addControl('attribution');
map.addControl('scale');

// Empty point collections are fine; lines and polygons need real geometry, so
// the path appears with the second point and the fill when the ring closes.
const vertices = map.addPoints([], {
  id: 'vertices',
  interactive: false,
  style: { radiusPx: 5, color: '#2563eb', strokeColor: '#ffffff', strokeWidthPx: 2 },
});
map.addLabels(vertices.source, {
  style: {
    text: style.field('label'),
    sizePx: 11,
    color: '#1d4ed8',
    offsetPx: { x: 0, y: -14 },
    collision: true,
  },
});
const handles = [];
const legs = [];
let path = null;
let area = null;
let closed = false;

const formatDistance = (meters) =>
  meters < 950 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
const formatArea = (squareMeters) =>
  squareMeters < 10000
    ? `${Math.round(squareMeters)} m²`
    : `${(squareMeters / 10000).toFixed(2)} ha`;

/** Planar approximation at the ring's mean latitude: city-scale areas within ~1 %. */
function areaSquareMeters(ring) {
  const meanLat = ring.reduce((sum, point) => sum + point.lat, 0) / ring.length;
  const metersPerLng = 111320 * Math.cos((meanLat * Math.PI) / 180);
  const metersPerLat = 110574;
  let doubled = 0;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index],
      b = ring[(index + 1) % ring.length];
    doubled +=
      a.lng * metersPerLng * (b.lat * metersPerLat) - b.lng * metersPerLng * (a.lat * metersPerLat);
  }
  return Math.abs(doubled) / 2;
}

const extra = document.querySelector('#example-extra');
const panel = document.createElement('div');
panel.className = 'panel';
const heading = document.createElement('h3');
heading.textContent = 'Measurement';
const rows = document.createElement('dl');
rows.className = 'rows';
const pointsLabel = document.createElement('dt');
pointsLabel.textContent = 'Points';
const pointsCell = document.createElement('dd');
const distanceLabel = document.createElement('dt');
distanceLabel.textContent = 'Distance';
const distanceCell = document.createElement('dd');
const areaLabel = document.createElement('dt');
areaLabel.textContent = 'Area';
const areaCell = document.createElement('dd');
rows.append(pointsLabel, pointsCell, distanceLabel, distanceCell, areaLabel, areaCell);
const hint = document.createElement('p');
panel.append(heading, rows, hint);
extra.append(panel);

function update() {
  const total = legs.reduce((sum, leg) => sum + leg, 0);
  pointsCell.textContent = String(handles.length);
  distanceCell.textContent = handles.length > 1 ? formatDistance(total) : '—';
  areaCell.textContent = closed
    ? formatArea(areaSquareMeters(handles.map((handle) => handle.getPosition())))
    : '—';
  hint.textContent =
    handles.length === 0
      ? 'Click the map to add the first point.'
      : closed
        ? 'Click the map to start a new measurement.'
        : 'Click again to extend the path, or close the area.';
}

function clear() {
  for (const handle of handles) handle.remove();
  handles.length = 0;
  legs.length = 0;
  path?.remove();
  path = null;
  area?.remove();
  area = null;
  closed = false;
}

function addVertex(position) {
  const handle = vertices.add({
    id: `w${handles.length + 1}`,
    position,
    properties: { label: '' },
  });
  handles.push(handle);
  if (handles.length > 1) {
    const leg = haversineMeters(handles[handles.length - 2].getPosition(), handle.getPosition());
    legs.push(leg);
    handle.setProperties({ label: formatDistance(leg) });
  }
  // A line needs two distinct positions, so the path appears with the second
  // click; the label of the first point stays empty until then.
  if (handles.length === 2) {
    path = map
      .addLines([{ id: 'path', positions: handles.map((vertex) => vertex.getPosition()) }], {
        id: 'path',
        interactive: false,
        style: { color: '#2563eb', widthPx: 3, cap: 'round', join: 'round' },
      })
      .get('path');
  } else if (path) {
    path.setPositions(handles.map((vertex) => vertex.getPosition()));
  }
}

// Background clicks only: clicking an existing feature keeps its own behaviour.
map.on('click', (event) => {
  if (event.feature) return;
  if (closed) {
    clear();
    report('Started a new measurement.');
  }
  addVertex(event.position);
  update();
  const total = legs.reduce((sum, leg) => sum + leg, 0);
  report(
    handles.length < 2
      ? 'First point set: click again to measure a distance.'
      : `Point ${handles.length} added · total ${formatDistance(total)}.`,
  );
});

action('Undo the last point', () => {
  const handle = handles.pop();
  if (!handle) {
    report('Nothing to undo yet.');
    return;
  }
  handle.remove();
  legs.pop();
  if (closed) {
    area?.remove();
    area = null;
    closed = false;
  }
  if (handles.length < 2) {
    path?.remove();
    path = null;
  } else path.setPositions(handles.map((vertex) => vertex.getPosition()));
  update();
  report(
    handles.length === 0
      ? 'The measurement is empty again.'
      : `Back to ${handles.length} ${handles.length === 1 ? 'point' : 'points'}.`,
  );
});
action('Close the area', () => {
  if (handles.length < 3) {
    report('Three points are needed before an area can be closed.');
    return;
  }
  const ring = handles.map((handle) => handle.getPosition());
  if (area) area.setRings([ring]);
  else
    area = map
      .addPolygons([{ id: 'area', rings: [ring] }], {
        id: 'area',
        interactive: false,
        style: {
          fillColor: '#2563eb',
          fillOpacity: 0.18,
          strokeColor: '#1d4ed8',
          strokeWidthPx: 1,
          dash: [5, 5],
        },
      })
      .get('area');
  closed = true;
  update();
  report(`Area closed: ${formatArea(areaSquareMeters(ring))} over ${ring.length} points.`);
});
action('Clear the measurement', () => {
  clear();
  update();
  report('Everything cleared; click the map to measure again.');
});

update();
await ready(map, {
  vertices,
  measurement: {
    get path() {
      return path;
    },
    get area() {
      return area;
    },
  },
});
