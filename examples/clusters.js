import { openExample, action, ready, report } from './shared.js';

const map = await openExample();

// Ninety-odd pins in five tight groups plus three lone landmarks: at the
// default zoom every group collapses into one count badge, and zooming in
// spreads the pins apart again.
const groups = [
  { name: 'Harbour', at: { x: -0.62, y: 0.36 }, spread: 0.075, count: 18, tint: '#2563eb' },
  { name: 'Old town', at: { x: 0.18, y: 0.52 }, spread: 0.06, count: 14, tint: '#16724c' },
  { name: 'Fairground', at: { x: 0.55, y: -0.18 }, spread: 0.08, count: 22, tint: '#b45309' },
  { name: 'Depot yard', at: { x: -0.3, y: -0.55 }, spread: 0.07, count: 16, tint: '#7c3aed' },
  { name: 'Campus', at: { x: -0.78, y: -0.12 }, spread: 0.05, count: 9, tint: '#0f766e' },
];
const singles = [
  { name: 'Lighthouse', at: { x: 0.84, y: 0.58 }, tint: '#b91c1c' },
  { name: 'Quarry', at: { x: 0.86, y: -0.6 }, tint: '#334155' },
  { name: 'Chapel', at: { x: -0.84, y: 0.62 }, tint: '#6d28d9' },
];
let serial = 0;
const pin = (name, at, tint) => ({
  id: `p${++serial}`,
  position: at,
  iconTint: tint,
  tooltip: name,
});
const spots = groups.flatMap((group) =>
  // A golden-angle spiral fills each group deterministically, with no random seed.
  Array.from({ length: group.count }, (_, index) => {
    const angle = index * 2.399963;
    const distance = group.spread * Math.sqrt((index + 1) / group.count);
    return pin(
      `${group.name} ${index + 1}`,
      {
        x: group.at.x + Math.cos(angle) * distance,
        y: group.at.y + Math.sin(angle) * distance,
      },
      group.tint,
    );
  }),
);
for (const single of singles) spots.push(pin(single.name, single.at, single.tint));

const pins = map.addMarkers(spots);
map.setMarkerClustering({ radiusPx: 64 });

const panel = document.createElement('div');
panel.className = 'panel';
const heading = document.createElement('h3');
heading.textContent = 'Clustering';
const rows = document.createElement('dl');
rows.className = 'rows';
const row = (label) => {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  rows.append(dt, dd);
  return dd;
};
const pinCount = row('Pins');
const radiusRow = row('Radius');
const zoomRow = row('Zoom');
panel.append(heading, rows);
const hint = document.createElement('p');
hint.textContent =
  'Hover a badge for its member count, click it to zoom those pins apart, and zoom back out to see them regroup.';
panel.append(hint);
document.querySelector('#example-extra').append(panel);

let added = 0;
let clusterRadius = 64;
const refresh = () => {
  pinCount.textContent = String(spots.length + added);
  const options = map.getMarkerClustering();
  radiusRow.textContent = options ? `${options.radiusPx} px · min ${options.minCount}` : 'off';
  zoomRow.textContent = map.getZoom().toFixed(2);
};
map.on('viewchange', refresh);
map.on('commit', refresh);
refresh();

action('Toggle clustering', () => {
  const on = map.getMarkerClustering() !== null;
  map.setMarkerClustering(on ? null : { radiusPx: clusterRadius });
  refresh();
  report(
    on
      ? 'Clustering off — every pin draws on its own.'
      : 'Clustering on — nearby pins collapse into count badges.',
  );
});
action('Cycle the radius', () => {
  clusterRadius = clusterRadius === 64 ? 36 : clusterRadius === 36 ? 96 : 64;
  if (map.getMarkerClustering() !== null) map.setMarkerClustering({ radiusPx: clusterRadius });
  refresh();
  report(`Cluster radius ${clusterRadius} px — a tighter radius keeps more pins apart.`);
});
action('Add a burst of 12 pins', () => {
  const at = groups[2].at;
  added += 12;
  for (let index = 0; index < 12; index++) {
    const angle = index * 2.399963;
    const distance = 0.02 * Math.sqrt((index + 1) / 12);
    map.addMarker(
      pin(
        `Fairground extra ${index + 1}`,
        {
          x: at.x + Math.cos(angle) * distance,
          y: at.y + Math.sin(angle) * distance,
        },
        groups[2].tint,
      ),
    );
  }
  refresh();
  report('Twelve more pins joined the fairground badge — hover it for the new count.');
});

await ready(map, { pins, groups, singles, spots });
