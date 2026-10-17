import { openExample, action, ready, report } from './shared.js';

const map = await openExample();
const site = map.addLayer({ id: 'site' });
const fills = site.addPolygons(
  [
    {
      id: 'courtyard',
      rings: [
        [
          { x: -0.65, y: -0.42 },
          { x: 0.65, y: -0.42 },
          { x: 0.65, y: 0.42 },
          { x: -0.65, y: 0.42 },
        ],
        [
          { x: -0.22, y: -0.16 },
          { x: 0.22, y: -0.16 },
          { x: 0.22, y: 0.16 },
          { x: -0.22, y: 0.16 },
        ],
      ],
    },
  ],
  {
    id: 'courtyard-fill',
    style: {
      minZoom: -1,
      fillColor: '#93bfa2',
      fillOpacity: 0.7,
      strokeColor: '#16724c',
      strokeWidthPx: 2,
    },
  },
);
const paths = site.addLayer({ id: 'paths' });
const route = paths.addLines(
  [
    {
      id: 'route',
      positions: [
        { x: -0.85, y: -0.55 },
        { x: -0.4, y: -0.2 },
        { x: -0.05, y: 0.03 },
        { x: 0.4, y: 0.06 },
        { x: 0.82, y: 0.55 },
      ],
    },
  ],
  { id: 'route', style: { minZoom: -1, color: '#bd573b', widthPx: 5 } },
);
let fillVisible = true,
  routeVisible = true,
  siteVisible = true;
action('Toggle polygon', () => {
  fillVisible = !fillVisible;
  fills.setVisible(fillVisible);
  report(`Polygon ${fillVisible ? 'visible' : 'hidden'}.`);
});
action('Toggle route', () => {
  routeVisible = !routeVisible;
  route.setVisible(routeVisible);
  report(`Route ${routeVisible ? 'visible' : 'hidden'}.`);
});
action('Toggle entire site', () => {
  siteVisible = !siteVisible;
  site.setVisible(siteVisible);
  report(`Site ${siteVisible ? 'visible' : 'hidden'}, including its nested route layer.`);
});
await ready(map, { site, paths, fills, route });
