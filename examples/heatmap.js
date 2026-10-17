import { openExample, action, ready, report, heatmap } from './shared.js';

// Synthetic measurements: six weighted clusters around Prague, generated from a
// seeded generator so every reload shows the same field.
let seed = 0x2f6e2b1;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gaussian = () => {
  const first = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random());
};
const clusters = [
  {
    id: 'old-town',
    name: 'Old Town',
    lat: 50.084,
    lng: 14.418,
    spread: 0.005,
    count: 240,
    weight: 1,
  },
  {
    id: 'holesovice',
    name: 'Holešovice',
    lat: 50.102,
    lng: 14.438,
    spread: 0.0035,
    count: 130,
    weight: 0.85,
  },
  {
    id: 'vinohrady',
    name: 'Vinohrady',
    lat: 50.074,
    lng: 14.456,
    spread: 0.0042,
    count: 170,
    weight: 0.8,
  },
  {
    id: 'smichov',
    name: 'Smíchov',
    lat: 50.068,
    lng: 14.4,
    spread: 0.0038,
    count: 120,
    weight: 0.7,
  },
  {
    id: 'zizkov',
    name: 'Žižkov',
    lat: 50.088,
    lng: 14.46,
    spread: 0.0032,
    count: 110,
    weight: 0.6,
  },
  { id: 'letna', name: 'Letná', lat: 50.102, lng: 14.413, spread: 0.003, count: 80, weight: 0.5 },
];
// One sample is a small fraction of the ramp; the accumulation is what turns a
// dense cluster hot. The explicit `max: 1` keeps single samples faint instead of
// scaling the largest weight up to a saturated splat.
const generate = () =>
  clusters.flatMap((cluster) =>
    Array.from({ length: cluster.count }, () => ({
      position: [
        cluster.lat + gaussian() * cluster.spread,
        cluster.lng + gaussian() * cluster.spread * 1.7,
      ],
      weight: Math.max(0.02, cluster.weight * (0.03 + random() * 0.06)),
    })),
  );

const map = await openExample({
  geographic: true,
  center: { lat: 50.086, lng: 14.429 },
  zoom: 13.1,
});

// Plain points under the field: the overlay is drawn above the map canvas, so
// faint areas let them show through while hot cores cover them.
map.addPoints(
  clusters.map((cluster) => ({
    id: cluster.id,
    position: [cluster.lat, cluster.lng],
    properties: { name: cluster.name },
  })),
  { style: { radiusPx: 4, color: '#111827', strokeColor: '#ffffff', strokeWidthPx: 1.5 } },
);

// The plugin defines the field: setPoints/addPoint/addPoints/clear for data,
// setOptions for radius, blur, peak, opacity bounds and the color ramp.
const heat = map.use(heatmap({ points: generate(), radius: 28, max: 1 }));

action('New measurements', () => {
  heat.api.setPoints(generate());
  report(`Replaced every sample: ${heat.api.count} weighted points.`);
});
const ramps = [
  null,
  [
    [0, '#312e81'],
    [0.45, '#0ea5e9'],
    [1, '#f97316'],
  ],
  [
    [0, '#052e16'],
    [1, '#fde047'],
  ],
];
let ramp = 0;
action('Switch the ramp', () => {
  ramp = (ramp + 1) % ramps.length;
  heat.api.setOptions({ gradient: ramps[ramp] });
  report(
    ramp === 0
      ? 'Default ramp: blue through cyan and lime to red.'
      : `Ramp ${ramp} of ${ramps.length - 1}.`,
  );
});
let radius = 28;
action('Bigger splats', () => {
  radius = radius === 28 ? 40 : radius === 40 ? 56 : 28;
  heat.api.setOptions({ radius });
  report(`Splat radius ${radius} px; the soft edge stays 15 px.`);
});
action('Add a hotspot', () => {
  heat.api.addPoint([50.06 + random() * 0.06, 14.39 + random() * 0.07], 1);
  report(`Added one full-weight sample: ${heat.api.count} in total.`);
});
action('Clear the field', () => {
  heat.api.clear();
  report(`Cleared: ${heat.api.count} samples. "New measurements" brings them back.`);
});
action('Remove the plugin', () => {
  heat.remove();
  report('The plugin is removed; its overlay canvas is gone and the plain points remain.');
});
await ready(map, { heat });
