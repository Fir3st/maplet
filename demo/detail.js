/**
 * Detail and accessible list battery (UI-05/06/08): generation-bound detail
 * lifecycle, text-vs-DOM content contract, bounded result list with selection
 * sync and live announcements. Results: `window.__detailCheckResult`.
 */
import { createMap, crs } from '../dist/index.js';

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mercator = crs.webMercator();
const worldCenter = mercator.toWorld({ lat: 50.05, lng: 14.45 });
const geoAt = (dx, dy) => mercator.fromWorld({
  x: worldCenter.x + dx / 2 ** 12,
  y: worldCenter.y + dy / 2 ** 12,
});

const POINTS = {
  a: geoAt(0, -40),
  b: geoAt(60, -20),
  c: geoAt(-60, 20),
  d: geoAt(60, 40),
  e: geoAt(0, 60),
  f: geoAt(-30, -70),
};

const map = await createMap('map-main', {
    renderer: { primary: 'webgl1', fallback: false },
    size: { width: 520, height: 420 },
    center: { lat: 50.05, lng: 14.45 }, zoom: 12
});
const pois = map.data.vector({ id: 'pois' });
await pois.features.replace(
  Object.entries(POINTS).map(([id, position]) => ({
    id,
    geometry: { type: 'point', position },
    properties: { name: id.toUpperCase(), status: 'open' },
  })),
);
map.addLayer({ id: 'pois', type: 'points', source: pois, style: { radiusPx: 6, color: '#2563eb' } });
const listControl = map.addControl({
  kind: 'list',
  id: 'results',
  options: { sources: ['pois'], limit: 3 },
});

const live = await createMap('map-live', {
    renderer: { primary: 'webgl1', fallback: false },
    size: { width: 320, height: 240 },
    center: { lat: 50.05, lng: 14.45 }, zoom: 12
});
const liveSource = live.data.vector({ id: 'live' });
await liveSource.features.replace([
  { id: 'l1', geometry: { type: 'point', position: geoAt(0, 0) }, properties: { name: 'Live one' } },
  { id: 'l2', geometry: { type: 'point', position: geoAt(40, 30) }, properties: { name: 'Live two' } },
]);
live.addLayer({ id: 'live', type: 'points', source: liveSource, style: { radiusPx: 6, color: '#16a34a' } });
live.addControl({ kind: 'list', id: 'live-list', options: { sources: ['live'], limit: 10 } });

const containerMain = document.getElementById('map-main');
const detailElement = () => containerMain.querySelector('[data-maplet-detail="true"]');
const detailContent = () =>
  containerMain.querySelector('[data-detail-content="true"]')?.firstElementChild?.textContent ?? null;
const detailedText = () =>
  containerMain.querySelector('[data-detail-content="true"]')?.textContent ?? '';
const listButtons = () => [...containerMain.querySelectorAll('[data-maplet-control="list"] button')];
const liveListButtons = () => [...document.getElementById('map-live').querySelectorAll('[data-maplet-control="list"] button')];

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: !!outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.checks.push({ name, pass: false, detail: String(error) });
    result.errors.push(`${name}: ${String(error)}`);
  }
}

const started = performance.now();
await sleep(500);

await check('UI-05 detail opens, follows the feature and updates with data', async () => {
  const handle = map.detail.open(pois.features.ref('a'), {
    content: (feature) => `A:${String(feature.properties.name)}:${feature.properties.status}`,
  });
  const opened = detailElement() !== null && detailContent() === 'A:A:open';
  const anchor = map.positionToScreen(POINTS.a);
  const rect = detailElement().getBoundingClientRect();
  const mapRect = containerMain.getBoundingClientRect();
  const nearAnchor =
    Math.abs(rect.left + rect.width / 2 - (mapRect.left + anchor.x)) < 3 &&
    Math.abs(rect.bottom - (mapRect.top + anchor.y - 10)) < 3;

  // Data update re-renders from the current snapshot.
  pois.features.update('a', { properties: { name: 'A1', status: 'busy' } });
  await sleep(50);
  const afterUpdate = detailContent();
  // View change moves the anchored detail by the same delta.
  const beforeMove = detailElement().getBoundingClientRect();
  map.setView({ center: { lat: 50.051, lng: 14.451 } });
  await sleep(50);
  const afterMove = detailElement().getBoundingClientRect();
  const moved = Math.abs(afterMove.left - beforeMove.left) > 1;
  return {
    pass:
      opened && nearAnchor && afterUpdate === 'A:A1:busy' && moved && handle.open &&
      detailElement().getAttribute('role') === 'dialog',
    detail: { opened, nearAnchor, afterUpdate, moved, role: detailElement().getAttribute('role') },
  };
});

await check('UI-05 removing the feature closes the detail per policy', async () => {
  const handle = map.detail.current();
  pois.features.remove('a');
  await sleep(50);
  const closed = detailElement() === null && handle !== null && handle.open === false && map.detail.current() === null;
  return { pass: closed, detail: { open: handle?.open ?? null, element: detailElement() !== null } };
});

await check('UI-05 retain policy freezes content and never shows a new generation', async () => {
  map.detail.open(pois.features.ref('b'), {
    policy: { onRemoved: 'retain' },
    content: (feature) => `B:${String(feature.properties.name)}`,
  });
  const opened = detailContent() === 'B:B';
  pois.features.remove('b');
  await sleep(50);
  const retained = detailElement() !== null && detailElement().dataset.removed === 'true';
  const marker = detailElement()?.querySelector('[data-detail-removed="true"]') !== null &&
    detailElement()?.querySelector('[data-detail-removed="true"]') !== undefined;
  const frozen = detailContent() === 'B:B';
  // A new feature with the same id has a new generation: the detail must not show it.
  await pois.features.add({
    id: 'b',
    geometry: { type: 'point', position: POINTS.b },
    properties: { name: 'B-NEW' },
  });
  await sleep(50);
  const stillFrozen = detailContent() === 'B:B' && !detailedText().includes('B-NEW');
  map.detail.close();
  return { pass: opened && retained && marker && frozen && stillFrozen && detailElement() === null, detail: { opened, retained, marker, frozen, stillFrozen } };
});

await check('UI-06 text content is never parsed into active HTML', async () => {
  window.__xss = undefined;
  const payload = '<img src=x onerror="window.__xss=1"><b>bold</b>';
  map.detail.open(pois.features.ref('c'), { content: payload });
  await sleep(50);
  const element = detailElement();
  const isText = element.textContent.includes('<img src=x onerror="window.__xss=1">') &&
    element.querySelector('img') === null &&
    element.querySelector('b') === null;
  await sleep(120);
  const noExecution = window.__xss === undefined;
  map.detail.close();
  return { pass: isText && noExecution, detail: { isText, noExecution } };
});

await check('UI-06 explicit DOM content is appended as-is; a throwing factory is safe', async () => {
  const node = document.createElement('div');
  node.dataset.probe = 'dom';
  node.textContent = 'explicit DOM';
  map.detail.open(pois.features.ref('c'), { content: () => node });
  await sleep(50);
  const domOk = detailElement()?.querySelector('[data-probe="dom"]')?.textContent === 'explicit DOM';

  map.detail.open(pois.features.ref('c'), {
    content: () => {
      throw new Error('factory boom');
    },
  });
  await sleep(50);
  const errorShown = detailElement()?.querySelector('[data-detail-error="true"]')?.textContent.includes('factory boom');
  const mapAlive = !map.destroyed && map.debug.layerInstances('pois') > 0;
  map.detail.close();
  return { pass: !!domOk && !!errorShown && mapAlive, detail: { domOk, errorShown, mapAlive } };
});

await check('UI-08 result list stays bounded and mirrors the selection', async () => {
  const buttons = listButtons();
  const bounded = buttons.length === 3 && buttons.every((button) => button.tagName === 'BUTTON');
  const first = buttons[0];
  const firstLabel = first.textContent;
  first.click();
  await sleep(50);
  const selected = map.selection.get();
  // Features were added/removed above, so map the rendered labels to live refs.
  const labelToRef = new Map();
  for (const id of Object.keys(POINTS)) {
    const snapshot = pois.features.get(id);
    if (snapshot) labelToRef.set(String(snapshot.properties.name), snapshot.ref);
  }
  const expected = labelToRef.get(firstLabel);
  const clickedSelects =
    selected.length === 1 &&
    expected !== undefined &&
    String(selected[0].id) === String(expected.id) &&
    first.getAttribute('aria-pressed') === 'true';

  // API-driven selection syncs back into the list (no second model).
  const second = buttons[1];
  const secondRef = labelToRef.get(second.textContent);
  map.selection.set([secondRef]);
  await sleep(50);
  const pressed = listButtons().map((button) => button.getAttribute('aria-pressed'));
  const live = containerMain.querySelector('[data-maplet-announce="true"]')?.textContent ?? '';
  return {
    pass: bounded && clickedSelects && pressed.filter((value) => value === 'true').length === 1 &&
      live.includes('1 selected'),
    detail: { bounded, clickedSelects, pressed, live },
  };
});

await check('UI-08 controls are focusable, hit-testable and remove cleanly', async () => {
  const button = listButtons()[0];
  button.focus();
  const focused = document.activeElement === button;
  const rect = button.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const hitOk = hit === button || button.contains(hit);
  const detailButton = (() => {
    map.detail.open(pois.features.ref('d'), { content: 'D' });
    const element = detailElement();
    const close = element.querySelector('button[aria-label="Close detail"]');
    const closeRect = close.getBoundingClientRect();
    const closeHit = document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2);
    return { exists: close !== null, hitOk: close === closeHit || close.contains(closeHit) };
  })();
  const containerFocusable = containerMain.tabIndex === 0 && containerMain.getAttribute('aria-label') !== null;
  map.destroy();
  const cleanedUp =
    containerMain.querySelector('[data-maplet-detail]') === null &&
    containerMain.querySelector('.maplet-ui') === null;
  return {
    pass: focused && hitOk && detailButton.exists && detailButton.hitOk && containerFocusable && cleanedUp,
    detail: { focused, hitOk, detailButton, containerFocusable, cleanedUp },
  };
});

result.ms = Math.round(performance.now() - started);
result.pass = result.errors.length === 0 && result.checks.every((entry) => entry.pass) && result.checks.length === 7;
window.__detailCheckResult = result;
window.__detail = { map, pois, live, liveSource, liveListButtons };
document.title = 'detail-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
