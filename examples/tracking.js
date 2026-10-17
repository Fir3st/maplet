import { openExample, action, ready, report, style, haversineMeters } from './shared.js';

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const map = await openExample({ geographic: true, center: [50.088, 14.42], zoom: 14 });
map.addTiles(OSM, { id: 'basemap', attribution: '© OpenStreetMap contributors' });
map.addControl('attribution');
map.addControl('scale');

// A simulated GPS feed along a real street route (approximate waypoints from
// Florenc through the Old Town to Malá Strana). Live tracking systems receive
// these updates from the vehicle and push them into the same calls below.
const route = [
  { lat: 50.0898, lng: 14.4388 },
  { lat: 50.0894, lng: 14.4331 },
  { lat: 50.0888, lng: 14.4281 },
  { lat: 50.0883, lng: 14.4244 },
  { lat: 50.0877, lng: 14.4207 },
  { lat: 50.0871, lng: 14.4173 },
  { lat: 50.0866, lng: 14.414 },
  { lat: 50.0864, lng: 14.4109 },
  { lat: 50.0869, lng: 14.4075 },
  { lat: 50.0878, lng: 14.404 },
];
const stops = [
  { id: 'pickup', name: 'Florenc depot', detail: 'Pickup · 24 parcels', at: route[0] },
  {
    id: 'checkpoint',
    name: 'Old Town checkpoint',
    detail: 'Checkpoint · scan the load',
    at: route[4],
  },
  {
    id: 'dropoff',
    name: 'Malá Strana drop-off',
    detail: 'Drop-off · 24 parcels',
    at: route[route.length - 1],
  },
];

const cumulative = [0];
for (let index = 1; index < route.length; index++) {
  cumulative.push(cumulative[index - 1] + haversineMeters(route[index - 1], route[index]));
}
const totalMeters = cumulative[cumulative.length - 1];

function headingDegrees(from, to) {
  const east = (to.lng - from.lng) * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  const north = to.lat - from.lat;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

function positionAt(meters) {
  let index = 1;
  while (index < route.length - 1 && cumulative[index] < meters) index++;
  const from = route[index - 1],
    to = route[index];
  const leg = cumulative[index] - cumulative[index - 1];
  const t = leg > 0 ? Math.min(1, Math.max(0, (meters - cumulative[index - 1]) / leg)) : 0;
  return {
    index,
    heading: headingDegrees(from, to),
    position: { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t },
  };
}

const planned = map.addLines([{ id: 'planned', positions: route }], {
  id: 'planned',
  interactive: false,
  style: { color: '#94a3b8', widthPx: 5, dash: [7, 6], cap: 'round' },
});
// A line needs two distinct positions; the first metre is the stand-in until
// the feed reports the first move (it is invisible at map scale).
const travelled = map.addLines(
  [{ id: 'travelled', positions: [route[0], positionAt(1).position] }],
  {
    id: 'travelled',
    interactive: false,
    style: { color: '#16724c', widthPx: 5, cap: 'round' },
  },
);
// The collection lists features; geometry edits go through the object handle.
const travelledLine = travelled.get('travelled');
const stopMarkers = map.addMarkers(
  stops.map((stop) => ({
    id: stop.id,
    position: stop.at,
    tooltip: stop.name,
    popup: `${stop.name} — ${stop.detail}`,
  })),
);

// The vehicle is one point with an icon; `heading` rotates the sprite along the
// segment it is driving, so no DOM element is created per update.
const ARROW =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
      '<path d="M14 2 24 25 14 19 4 25Z" fill="#1d4ed8" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>',
  );
map.assets.addImage({ id: 'vehicle-arrow', src: ARROW });
const vehicle = map.addPoints([{ id: 'vehicle', position: route[0], properties: { heading: 0 } }], {
  id: 'vehicle',
  interactive: false,
  style: { icon: 'vehicle-arrow', iconSize: 28, iconRotate: style.field('heading') },
});

const formatMeters = (meters) =>
  meters < 950 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
const SPEED_KMH = 26;
const UPDATE_MS = 80;
let travelledMeters = 0,
  playing = false,
  factor = 2,
  follow = true,
  frame = 0,
  lastTime = 0,
  lastDraw = 0;

const extra = document.querySelector('#example-extra');
const panel = document.createElement('div');
panel.className = 'panel';
const heading = document.createElement('h3');
heading.textContent = 'Simulated feed';
const playButton = document.createElement('button');
playButton.type = 'button';
const speed = document.createElement('select');
speed.setAttribute('aria-label', 'Simulation speed');
for (const value of [1, 2, 4]) {
  const option = document.createElement('option');
  option.value = String(value);
  option.textContent = `Simulated speed ×${value}`;
  speed.append(option);
}
speed.value = String(factor);
const followLabel = document.createElement('label');
const followBox = document.createElement('input');
followBox.type = 'checkbox';
followBox.checked = true;
followLabel.append(followBox, 'Follow the vehicle');
const progress = document.createElement('progress');
progress.setAttribute('aria-label', 'Route progress');
progress.max = 100;
progress.value = 0;
const rows = document.createElement('dl');
rows.className = 'rows';
const travelledLabel = document.createElement('dt');
travelledLabel.textContent = 'Travelled';
const travelledCell = document.createElement('dd');
const remainingLabel = document.createElement('dt');
remainingLabel.textContent = 'Remaining';
const remainingCell = document.createElement('dd');
rows.append(travelledLabel, travelledCell, remainingLabel, remainingCell);
panel.append(heading, playButton, speed, followLabel, progress, rows);
extra.append(panel);
function draw() {
  const { position, heading: bearing } = positionAt(travelledMeters);
  const handle = vehicle.get('vehicle');
  handle.setPosition(position);
  handle.setProperties({ heading: bearing });
  const lineHead = positionAt(Math.max(travelledMeters, 1));
  travelledLine.setPositions([...route.slice(0, lineHead.index), lineHead.position]);
  progress.value = Math.round((travelledMeters / totalMeters) * 100);
  travelledCell.textContent = formatMeters(travelledMeters);
  remainingCell.textContent = formatMeters(totalMeters - travelledMeters);
  if (follow) map.setView({ center: position });
}

function syncPlayButton() {
  playButton.textContent = playing
    ? 'Pause the feed'
    : travelledMeters >= totalMeters
      ? 'Drive the route again'
      : 'Play the feed';
}

function tick(now) {
  if (!playing) return;
  if (!lastTime) lastTime = now;
  travelledMeters = Math.min(
    totalMeters,
    travelledMeters + (SPEED_KMH / 3.6) * ((now - lastTime) / 1000) * factor,
  );
  lastTime = now;
  if (now - lastDraw >= UPDATE_MS || travelledMeters >= totalMeters) {
    lastDraw = now;
    draw();
  }
  if (travelledMeters >= totalMeters) {
    playing = false;
    syncPlayButton();
    report(`Arrived at the drop-off: ${formatMeters(totalMeters)} travelled.`);
    return;
  }
  frame = requestAnimationFrame(tick);
}

function play() {
  if (playing) return;
  if (travelledMeters >= totalMeters) travelledMeters = 0;
  playing = true;
  lastTime = 0;
  lastDraw = 0;
  syncPlayButton();
  report(`Driving at a simulated ${SPEED_KMH} km/h, ×${factor} speed.`);
  frame = requestAnimationFrame(tick);
}
function pause() {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(frame);
  syncPlayButton();
  report('Feed paused; the last position stays on the map.');
}

playButton.addEventListener('click', () => {
  if (playing) pause();
  else play();
});
speed.addEventListener('change', () => {
  factor = Number(speed.value);
  report(`Simulation speed ×${factor}.`);
});
followBox.addEventListener('change', () => {
  follow = followBox.checked;
  report(follow ? 'The map follows the vehicle.' : 'Follow mode off; pan freely.');
});

action('Skip ahead 30 seconds', () => {
  travelledMeters = Math.min(totalMeters, travelledMeters + (SPEED_KMH / 3.6) * 30 * factor);
  draw();
  syncPlayButton();
  report(
    travelledMeters >= totalMeters
      ? `Arrived at the drop-off: ${formatMeters(totalMeters)} travelled.`
      : `${formatMeters(travelledMeters)} travelled · ${formatMeters(totalMeters - travelledMeters)} remaining.`,
  );
});
action('Reset the route', () => {
  pause();
  travelledMeters = 0;
  draw();
  syncPlayButton();
  report('Back at the pickup; press play to drive the route again.');
});
let plannedVisible = true;
const plannedAction = action('Hide the planned path', () => {
  plannedVisible = !plannedVisible;
  planned.setVisible(plannedVisible);
  plannedAction.textContent = plannedVisible ? 'Hide the planned path' : 'Show the planned path';
  report(plannedVisible ? 'Planned path visible again.' : 'Only the travelled part stays visible.');
});

let wasPlaying = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    wasPlaying = playing;
    pause();
  } else if (wasPlaying) {
    wasPlaying = false;
    play();
  }
});
window.addEventListener('pagehide', () => {
  playing = false;
  cancelAnimationFrame(frame);
});

draw();
syncPlayButton();
await ready(map, { route, planned, travelled, vehicle, stops: stopMarkers });
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) play();
