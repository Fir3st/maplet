/**
 * Two independent map views in one host. The switcher creates a map on its
 * first activation and keeps it, so panning, zooming and layer visibility
 * survive every switch. Each view carries its own labelled layer control; the
 * detail view is not even built until you open it.
 */
import { createMapSwitcher, action, report, rendererKind, style } from './shared.js';

const VIEWS = {
  overview: { label: 'Network overview', center: [49.8, 15.3], zoom: 7.1 },
  detail: { label: 'Prague detail', center: [50.08, 14.43], zoom: 12.4 },
};

// Illustrative positions, not surveyed depots.
const CITIES = [
  { id: 'prague', name: 'Prague', lat: 50.0755, lng: 14.4378 },
  { id: 'brno', name: 'Brno', lat: 49.1951, lng: 16.6068 },
  { id: 'ostrava', name: 'Ostrava', lat: 49.8209, lng: 18.2625 },
  { id: 'plzen', name: 'Plzeň', lat: 49.7384, lng: 13.3736 },
  { id: 'olomouc', name: 'Olomouc', lat: 49.5938, lng: 17.2509 },
  { id: 'liberec', name: 'Liberec', lat: 50.7663, lng: 15.0543 },
  { id: 'budejovice', name: 'České Budějovice', lat: 48.9745, lng: 14.4743 },
  { id: 'hradec', name: 'Hradec Králové', lat: 50.2092, lng: 15.8328 },
];
const CORRIDORS = [
  ['prague', 'brno'],
  ['brno', 'ostrava'],
  ['prague', 'plzen'],
  ['prague', 'liberec'],
  ['prague', 'budejovice'],
  ['prague', 'hradec'],
  ['hradec', 'olomouc'],
  ['olomouc', 'ostrava'],
];
const PRAGUE_HUBS = [
  { id: 'holesovice', name: 'Holešovice', lat: 50.104, lng: 14.436 },
  { id: 'karlin', name: 'Karlín', lat: 50.09, lng: 14.45 },
  { id: 'vinohrady', name: 'Vinohrady', lat: 50.078, lng: 14.44 },
  { id: 'smichov', name: 'Smíchov', lat: 50.07, lng: 14.405 },
  { id: 'stresovice', name: 'Střešovice', lat: 50.09, lng: 14.38 },
];
const LOCAL_ROUTES = [
  ['holesovice', 'karlin', 'vinohrady'],
  ['vinohrady', 'smichov', 'stresovice'],
  ['stresovice', 'holesovice'],
];

const point = (stop) => ({
  id: stop.id,
  position: { lat: stop.lat, lng: stop.lng },
  properties: { name: stop.name },
});
const path = (stops, ids) => ({
  id: ids.join('-'),
  positions: ids.map((id) => {
    const stop = stops.find((candidate) => candidate.id === id);
    return { lat: stop.lat, lng: stop.lng };
  }),
});

const switcher = await createMapSwitcher({
  container: 'map',
  label: 'Logistics map views',
  initial: 'overview',
  maps: [
    {
      id: 'overview',
      label: VIEWS.overview.label,
      options: {
        renderer: rendererKind,
        center: VIEWS.overview.center,
        zoom: VIEWS.overview.zoom,
        controls: ['zoom', 'layers'],
      },
    },
    {
      id: 'detail',
      label: VIEWS.detail.label,
      options: {
        renderer: rendererKind,
        center: VIEWS.detail.center,
        zoom: VIEWS.detail.zoom,
        controls: ['zoom', 'layers'],
      },
    },
  ],
});

// One root layer per category: the layer control lists root entries in painter
// order, so each row toggles its whole subtree and shows the `label`.
function buildNetwork(map) {
  const corridors = map.addLayer({ id: 'corridors', label: 'Corridors' });
  corridors.addLines(
    CORRIDORS.map((ids) => path(CITIES, ids)),
    {
      style: { color: '#bd573b', widthPx: 2.5, opacity: 0.9, cap: 'round' },
    },
  );
  const depots = map.addLayer({ id: 'depots', label: 'Depots' });
  const points = depots.addPoints(CITIES.map(point), {
    style: { radiusPx: 7, color: '#16724c', strokeColor: '#ffffff', strokeWidthPx: 2 },
  });
  const names = map.addLayer({ id: 'names', label: 'City names' });
  names.addLabels(points.source, {
    style: {
      text: style.field('name'),
      sizePx: 11,
      color: '#263e33',
      offsetPx: { x: 0, y: -16 },
      collision: true,
    },
  });
  points.on('click', (event) => report(`${event.feature.properties.name} · national depot`));
  return { corridors, depots, points, names };
}

function buildDetail(map) {
  const routes = map.addLayer({ id: 'routes', label: 'Routes' });
  routes.addLines(
    LOCAL_ROUTES.map((ids) => path(PRAGUE_HUBS, ids)),
    {
      style: { color: '#bd573b', widthPx: 4, opacity: 0.9, cap: 'round' },
    },
  );
  const hubs = map.addLayer({ id: 'hubs', label: 'Hubs' });
  const points = hubs.addPoints(PRAGUE_HUBS.map(point), {
    style: { radiusPx: 8, color: '#2563eb', strokeColor: '#ffffff', strokeWidthPx: 2 },
  });
  const names = map.addLayer({ id: 'names', label: 'Hub names' });
  names.addLabels(points.source, {
    style: {
      text: style.field('name'),
      sizePx: 12,
      color: '#263e33',
      offsetPx: { x: 0, y: -17 },
      collision: true,
    },
  });
  points.on('click', (event) => report(`${event.feature.properties.name} · Prague hub`));
  return { routes, hubs, points, names };
}

// The initial view is ready; every other view is built on its first activation
// (before readySwitcher's listener updates the page).
const overviewMap = switcher.get('overview');
const built = { overview: buildNetwork(overviewMap) };
// Fit the network to the host size instead of trusting one fixed zoom level,
// then remember the fitted view for the page's Reset button.
overviewMap.fitBounds(built.overview.points.getBounds(), { padding: 48, maxZoom: 7.6 });
VIEWS.overview.center = overviewMap.getCenter();
VIEWS.overview.zoom = overviewMap.getZoom();
switcher.onChange((id) => {
  if (id !== 'detail' || built.detail) return;
  const detailMap = switcher.get('detail');
  built.detail = buildDetail(detailMap);
  detailMap.fitBounds(built.detail.points.getBounds(), { padding: 56, maxZoom: 13.4 });
  VIEWS.detail.center = detailMap.getCenter();
  VIEWS.detail.zoom = detailMap.getZoom();
});

action('Toggle depots in this view', async () => {
  const id = switcher.activeId;
  await switcher.show(id);
  const view = built[id];
  if (!view) {
    report('The active view is still loading.', true);
    return;
  }
  const visible = !view.depots.isVisible();
  view.depots.setVisible(visible);
  report(
    `Depots ${visible ? 'shown' : 'hidden'} in ${VIEWS[id].label}. The other view is untouched.`,
  );
});

action('Fit this view to its depots', async () => {
  const id = switcher.activeId;
  const map = await switcher.show(id);
  const view = built[id];
  if (!view) {
    report('The active view is still loading.', true);
    return;
  }
  map.fitBounds(view.points.getBounds(), { padding: 56, maxZoom: 13 });
  report(`${VIEWS[id].label} now frames its own depots.`);
});

/* ------------------------------ page chrome ------------------------------- */

const statsLine = document.querySelector('#map-stats');
const watched = new Set();
const update = () => {
  const id = switcher.activeId;
  const map = switcher.get(id);
  if (!map) return;
  const stats = map.stats();
  statsLine.textContent = `${VIEWS[id].label} · ${map.capabilities().backend} · ${stats.features} features · revision ${stats.revision}`;
};
const watch = (id) => {
  const map = switcher.get(id);
  if (!map || watched.has(map)) return;
  watched.add(map);
  map.on('commit', update);
  map.on('viewchange', update);
  update();
};
switcher.onChange((id) => {
  watch(id);
  update();
});
watch('overview');
await switcher.get('overview').whenRendered();
for (const button of document.querySelectorAll('#example-tools button')) button.disabled = false;
const resetView = document.querySelector('#reset-view');
resetView.disabled = false;
resetView.addEventListener('click', () => {
  const id = switcher.activeId;
  const map = switcher.get(id);
  if (map) map.setView({ center: VIEWS[id].center, zoom: VIEWS[id].zoom });
});
update();
report('Ready — switch views or toggle layers in each one.');
window.__example = { switcher, built };
window.__exampleReady = true;
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) switcher.destroy();
});
