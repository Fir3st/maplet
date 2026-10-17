/**
 * UI control battery (UI-01..UI-04, UI-07, UI-10): zoom limits, layer list sync
 * and labels, attribution dedup/shared notices, geographic vs planar scale,
 * typed geolocation with cancel/destroy semantics, and a multi-map switcher that
 * keeps independent views and layer state across accessible tabs.
 * Results: `window.__uiCheckResult`.
 */
import { createMap, createMapSwitcher, crs } from '../dist/index.js';

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const oracle = await (await fetch('./tiles-svg/checks.json')).json();
const { z, x, y } = oracle.tile;
const mercator = crs.webMercator();
const viewCenter = mercator.fromWorld({
  x: ((x + 0.5) * 256) / 2 ** z,
  y: ((y + 0.5) * 256) / 2 ** z,
});
const forceBackend = new URLSearchParams(location.search).get('backend');
const rendererOptions =
  forceBackend === 'webgpu'
    ? { primary: 'webgpu', fallback: false }
    : { primary: 'webgl1', fallback: false };

/* ------------------------------ fake geolocation -------------------------- */

const originalGeolocation = Object.getOwnPropertyDescriptor(Navigator.prototype, 'geolocation');
function installGeolocation(impl) {
  Object.defineProperty(Navigator.prototype, 'geolocation', {
    configurable: true,
    get: () => impl,
  });
}
function fakeGeolocation() {
  const state = { current: [], watches: new Map(), cleared: [], nextId: 1 };
  const impl = {
    getCurrentPosition(success, error, options) {
      state.current.push({ success, error, options });
    },
    watchPosition(success, error, options) {
      const id = state.nextId++;
      state.watches.set(id, { success, error, options });
      return id;
    },
    clearWatch(id) {
      state.cleared.push(id);
    },
  };
  return { state, impl };
}
const fix = (lat, lng, accuracy = 10) => ({ coords: { latitude: lat, longitude: lng, accuracy } });

/* ----------------------------- scale oracle ------------------------------- */

function expectedGeographicScale(zoom, lat, maxPx = 100) {
  const mpp = ((40075016.686 / 256) * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const raw = mpp * maxPx;
  const exp = Math.floor(Math.log10(raw));
  let step = 0;
  for (const e of [exp - 1, exp]) {
    for (const f of [1, 2, 5]) {
      const candidate = f * 10 ** e;
      if (candidate <= raw + 1e-9 && candidate > step) step = candidate;
    }
  }
  return {
    step,
    label: step >= 1000 ? `${step / 1000} km` : `${step} m`,
    widthPx: step / mpp,
  };
}

/* --------------------------------- scene ---------------------------------- */

const main = {};
const map = await createMap('map-main', {
  renderer: rendererOptions,
  size: { width: 560, height: 420 },
  center: viewCenter,
  zoom: z,
  minZoom: 1,
  maxZoom: 4,
});
main.map = map;
const sourceOptions = (id, attribution) => ({
  id,
  url: './tiles-svg/{z}/{x}/{y}.svg',
  minZoom: 0,
  maxZoom: z,
  attribution,
});
map.data.rasterTiles(sourceOptions('src-a', '© A'));
map.data.rasterTiles(sourceOptions('src-b', '© B'));
main.layerA = map.addLayer({ id: 'layer-a', type: 'raster', source: 'src-a' });
main.layerB = map.addLayer({ id: 'layer-b', type: 'raster', source: 'src-b' });
const group = map.addLayer({ id: 'grp' });
main.layerG = group.addLayer({ id: 'layer-g', type: 'raster', source: 'src-b' });
main.zoomControl = map.addControl({ kind: 'zoom', id: 'zoom' });
main.layersControl = map.addControl({ kind: 'layers', id: 'layers' });
main.attributionControl = map.addControl({ kind: 'attribution', id: 'attribution' });
main.scaleControl = map.addControl({ kind: 'scale', id: 'scale' });

const planar = {};
planar.map = await createMap('map-planar', {
  projection: crs.simple(),
  renderer: rendererOptions,
  size: { width: 240, height: 160 },
  center: { x: 0, y: 0 },
  zoom: 3,
  minZoom: 0,
  maxZoom: 8,
});
planar.scaleControl = planar.map.addControl({ kind: 'scale', id: 'scale' });

/* ------------------------------ map switcher ------------------------------ */

const views = {};
views.host = await createMapSwitcher({
  container: 'map-switcher',
  label: 'Demo map views',
  initial: 'red',
  maps: [
    {
      id: 'red',
      label: 'Red view',
      options: { renderer: rendererOptions, center: viewCenter, zoom: z },
    },
    {
      id: 'green',
      label: 'Green view',
      options: { renderer: rendererOptions, center: viewCenter, zoom: z },
    },
  ],
});
views.red = views.host.get('red');
views.redLayer = views.red.addLayer({ id: 'red-view', label: 'Red points' });
views.redLayer.addPoints([{ id: 'center', position: views.red.getCenter() }], {
  style: { radiusPx: 64, color: '#dc2626' },
});
views.red.addControl('layers');
await views.red.whenRendered();

/* -------------------------------- helpers --------------------------------- */

const containerMain = document.getElementById('map-main');
const containerPlanar = document.getElementById('map-planar');
const controlIn = (container, kind) => container.querySelector(`[data-maplet-control="${kind}"]`);
const zoomButton = (container, action) =>
  controlIn(container, 'zoom').querySelector(`[data-action="${action}"]`);
const layerCheckbox = (container, id) =>
  controlIn(container, 'layers').querySelector(`input[data-layer-id="${id}"]`);
const attributionText = (container) => controlIn(container, 'attribution').textContent;
const scaleLabel = (container) => controlIn(container, 'scale').children[0].textContent;
const scaleWidth = (container) => parseFloat(controlIn(container, 'scale').children[1].style.width);
const pixelText = (pixel) => `rgba(${pixel.r},${pixel.g},${pixel.b},${pixel.a})`;
const switcherHost = document.getElementById('map-switcher');
const switcherTabs = () => [...switcherHost.querySelectorAll('[role="tab"]')];
const switcherPanel = (id) => switcherHost.querySelector(`[data-maplet-switcher-panel="${id}"]`);

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
await sleep(400);

await check('UI-01 zoom buttons honour limits and stay in sync with the API', async () => {
  map.setView({ zoom: 4 });
  const atMax = {
    inDisabled: zoomButton(containerMain, 'in').disabled,
    outDisabled: zoomButton(containerMain, 'out').disabled,
  };
  zoomButton(containerMain, 'out').click();
  const afterOut = map.getView().zoom;
  const afterOutState = zoomButton(containerMain, 'in').disabled;
  // Climb down to the lower limit and try to go past it.
  map.setView({ zoom: 2 });
  zoomButton(containerMain, 'out').click();
  zoomButton(containerMain, 'out').click();
  const atMin = {
    zoom: map.getView().zoom,
    outDisabled: zoomButton(containerMain, 'out').disabled,
  };
  zoomButton(containerMain, 'out').click();
  const stuck = map.getView().zoom;
  zoomButton(containerMain, 'in').click();
  const afterIn = map.getView().zoom;
  return {
    pass:
      atMax.inDisabled === true &&
      atMax.outDisabled === false &&
      afterOut === 3 &&
      afterOutState === false &&
      atMin.zoom === 1 &&
      atMin.outDisabled === true &&
      stuck === 1 &&
      afterIn === 2,
    detail: { atMax, afterOut, atMin, stuck, afterIn },
  };
});

await check('UI-02 layer list matches the layer API in both directions', async () => {
  const before = {
    visible: main.layerA.isVisible(),
    checked: layerCheckbox(containerMain, 'layer-a').checked,
  };
  layerCheckbox(containerMain, 'layer-a').click();
  const afterClick = {
    visible: main.layerA.isVisible(),
    checked: layerCheckbox(containerMain, 'layer-a').checked,
  };
  main.layerA.setVisible(true);
  const afterApi = {
    visible: main.layerA.isVisible(),
    checked: layerCheckbox(containerMain, 'layer-a').checked,
  };
  const listed = [...controlIn(containerMain, 'layers').querySelectorAll('input')].map(
    (input) => input.dataset.layerId,
  );
  return {
    pass:
      before.visible === true &&
      before.checked === true &&
      afterClick.visible === false &&
      afterClick.checked === false &&
      afterApi.visible === true &&
      afterApi.checked === true &&
      // Top-level entries only: nested content is managed through its layer.
      listed.includes('layer-a') &&
      listed.includes('layer-b') &&
      listed.includes('grp') &&
      !listed.includes('layer-g'),
    detail: { before, afterClick, afterApi, listed },
  };
});

await check('UI-02b layer row toggles nested content through the API', async () => {
  layerCheckbox(containerMain, 'grp').click();
  const afterClick = {
    visible: group.isVisible(),
    checked: layerCheckbox(containerMain, 'grp').checked,
  };
  group.setVisible(true);
  const afterApi = {
    visible: group.isVisible(),
    checked: layerCheckbox(containerMain, 'grp').checked,
  };
  return {
    pass:
      afterClick.visible === false &&
      afterClick.checked === false &&
      afterApi.visible === true &&
      afterApi.checked === true,
    detail: { afterClick, afterApi },
  };
});

await check('UI-03 attribution notice dedupes and survives sharing', async () => {
  const seen = [];
  const record = () => seen.push(attributionText(containerMain));
  record();
  const sourceC = map.data.rasterTiles(sourceOptions('src-c', '© A'));
  map.addLayer({ id: 'layer-c', type: 'raster', source: 'src-c' });
  record();
  // Remove the first source carrying © A; © A must stay because src-c shares it.
  map.layers.remove('layer-a');
  map.data.remove('src-a');
  record();
  map.layers.remove('layer-c');
  map.data.remove('src-c');
  record();
  map.layers.remove('layer-b');
  map.layers.remove('layer-g');
  map.data.remove('src-b');
  record();
  const countA = (text) => text.split('© A').length - 1;
  return {
    pass:
      seen[0] === '© A | © B' &&
      seen[1] === '© A | © B' &&
      countA(seen[1]) === 1 &&
      // Order follows source registration: src-a was removed, so © B (src-b) leads.
      seen[2] === '© B | © A' &&
      seen[3] === '© B' &&
      seen[4] === '' &&
      sourceC !== undefined,
    detail: { seen },
  };
});

await check('UI-04 geographic scale matches the independent oracle', async () => {
  map.setView({ zoom: 3 });
  const lat = map.getView().center.lat;
  const atThree = {
    expected: expectedGeographicScale(3, lat),
    label: scaleLabel(containerMain),
    widthPx: scaleWidth(containerMain),
  };
  map.setView({ zoom: 4 });
  const atFour = {
    expected: expectedGeographicScale(4, lat),
    label: scaleLabel(containerMain),
    widthPx: scaleWidth(containerMain),
  };
  const matches = (entry) =>
    entry.label === entry.expected.label &&
    Math.abs(entry.widthPx - entry.expected.widthPx) <= 0.05;
  return {
    pass:
      matches(atThree) &&
      matches(atFour) &&
      (atThree.label !== atFour.label || Math.abs(atThree.widthPx - atFour.widthPx) > 0.1),
    detail: { atThree, atFour },
  };
});

await check('UI-04b planar scale uses CRS units, never earth meters', async () => {
  const atThree = { label: scaleLabel(containerPlanar), widthPx: scaleWidth(containerPlanar) };
  planar.map.setView({ zoom: 4 });
  const atFour = { label: scaleLabel(containerPlanar), widthPx: scaleWidth(containerPlanar) };
  return {
    pass:
      atThree.label.endsWith(' u') &&
      atThree.label === '10 u' &&
      Math.abs(atThree.widthPx - 80) <= 0.05 &&
      atFour.label === '5 u' &&
      Math.abs(atFour.widthPx - 80) <= 0.05 &&
      !atFour.label.includes('km') &&
      !atFour.label.includes(' m'),
    detail: { atThree, atFour },
  };
});

await check('UI-07 locate success, typed errors and unsupported', async () => {
  const fake = fakeGeolocation();
  installGeolocation(fake.impl);
  const pending = map.locate({ setView: true, timeoutMs: 2000 });
  fake.state.current.at(-1).success(fix(50.5, 15.5, 8));
  const success = await pending;
  const center = map.getView().center;
  const setViewOk =
    success.ok &&
    success.position.lat === 50.5 &&
    success.position.accuracy === 8 &&
    Math.abs(center.lat - 50.5) < 1e-9 &&
    Math.abs(center.lng - 15.5) < 1e-9;
  const optionsForwarded = fake.state.current.at(-1).options;

  const denied = map.locate();
  fake.state.current.at(-1).error({ code: 1, message: 'denied' });
  const deniedResult = await denied;

  const timedOut = map.locate();
  fake.state.current.at(-1).error({ code: 3 });
  const timeoutResult = await timedOut;

  installGeolocation(undefined);
  const unsupported = await map.locate();
  installGeolocation(fake.impl);
  return {
    pass:
      success.ok &&
      setViewOk &&
      optionsForwarded.timeout === 2000 &&
      deniedResult.ok === false &&
      deniedResult.code === 'permission' &&
      timeoutResult.ok === false &&
      timeoutResult.code === 'timeout' &&
      unsupported.ok === false &&
      unsupported.code === 'unsupported',
    detail: { success, setViewOk, optionsForwarded, deniedResult, timeoutResult, unsupported },
  };
});

await check('UI-07 watch delivers updates and cancel stops them', async () => {
  const fake = fakeGeolocation();
  installGeolocation(fake.impl);
  const updates = [];
  const watch = map.locate.watch({ onUpdate: (entry) => updates.push(entry) });
  const id = [...fake.state.watches.keys()].at(-1);
  const call = fake.state.watches.get(id);
  call.success(fix(50.1, 14.4));
  call.success(fix(50.2, 14.5));
  const beforeCancel = updates.length;
  watch.cancel();
  call.success(fix(50.3, 14.6));
  const stopped = updates.length === beforeCancel;
  const clearedOnce = fake.state.cleared.filter((entry) => entry === id).length === 1;
  return {
    pass:
      watch.active === false &&
      beforeCancel === 2 &&
      stopped &&
      clearedOnce &&
      updates[0].ok === true &&
      updates[0].position.lat === 50.1,
    detail: { beforeCancel, updates: updates.length, cleared: fake.state.cleared, stopped },
  };
});

await check('UI-09 controls are hit-testable and capture their own gestures', async () => {
  // UI-03 removed all earlier layers; add one back to probe a live checkbox.
  map.data.rasterTiles(sourceOptions('src-hit', '© HIT'));
  map.addLayer({ id: 'layer-hit', type: 'raster', source: 'src-hit' });
  const centerOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  const probes = [
    zoomButton(containerMain, 'in'),
    zoomButton(containerMain, 'out'),
    layerCheckbox(containerMain, 'layer-hit'),
  ];
  const hitTargets = probes.map((element) => {
    const at = centerOf(element);
    const hit = document.elementFromPoint(at.x, at.y);
    return {
      tag: hit ? hit.tagName : null,
      data: hit && hit.dataset ? (hit.dataset.mapletControl ?? null) : null,
      ok: hit === element || element.contains(hit) || (hit ? hit.contains(element) : false),
    };
  });
  const hitOk = hitTargets.every((entry) => entry.ok);

  // A pointerdown that starts on a control must not begin a map gesture.
  map.setView({ zoom: 2 });
  const zoomBefore = map.getView().zoom;
  const centerBefore = map.getView().center;
  const rect = zoomButton(containerMain, 'in').getBoundingClientRect();
  zoomButton(containerMain, 'in').dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      pointerId: 99,
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: rect.x + 4,
      clientY: rect.y + 4,
    }),
  );
  await sleep(80);
  containerMain.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 99,
      isPrimary: true,
      buttons: 1,
      clientX: rect.x + 90,
      clientY: rect.y + 70,
    }),
  );
  containerMain.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 99,
      isPrimary: true,
      buttons: 0,
      clientX: rect.x + 90,
      clientY: rect.y + 70,
    }),
  );
  await sleep(350);
  const blocked =
    map.getView().zoom === zoomBefore &&
    Math.abs(map.getView().center.lat - centerBefore.lat) < 1e-12 &&
    Math.abs(map.getView().center.lng - centerBefore.lng) < 1e-12;

  // Sanity: the same sequence started on the map itself does pan. The pan starts
  // asynchronously (feature-drag pick resolves first), so the move needs a beat.
  const mapRect = containerMain.getBoundingClientRect();
  const at = (x, y) => ({ clientX: mapRect.left + x, clientY: mapRect.top + y });
  containerMain.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      pointerId: 98,
      isPrimary: true,
      button: 0,
      buttons: 1,
      ...at(300, 300),
    }),
  );
  await sleep(80);
  containerMain.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 98,
      isPrimary: true,
      buttons: 1,
      ...at(250, 270),
    }),
  );
  await sleep(40);
  containerMain.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 98,
      isPrimary: true,
      buttons: 0,
      ...at(250, 270),
    }),
  );
  await sleep(350);
  const panWorks = Math.abs(map.getView().center.lng - centerBefore.lng) > 1e-9;

  // Wheel over a control must not zoom; wheel over the map must.
  const zoomAfterPan = map.getView().zoom;
  zoomButton(containerMain, 'in').dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -300,
    }),
  );
  await sleep(450);
  const wheelBlocked = map.getView().zoom === zoomAfterPan;
  containerMain.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -300,
      ...at(300, 300),
    }),
  );
  await sleep(700);
  const wheelWorks = map.getView().zoom > zoomAfterPan;

  return {
    pass: hitOk && blocked && panWorks && wheelBlocked && wheelWorks,
    detail: { hitTargets, blocked, panWorks, wheelBlocked, wheelWorks },
  };
});

await check(
  'UI-10 the switcher creates only the initial map and exposes accessible tabs',
  async () => {
    const tabs = switcherTabs();
    const redPanel = switcherPanel('red');
    const greenPanel = switcherPanel('green');
    const pixel = await views.red.debug.samplePixel({ x: 280, y: 120 });
    return {
      pass:
        views.host.activeId === 'red' &&
        views.host.get('green') === undefined &&
        views.host.ids.join(',') === 'red,green' &&
        tabs.length === 2 &&
        tabs[0].textContent === 'Red view' &&
        tabs[1].textContent === 'Green view' &&
        tabs[0].getAttribute('aria-selected') === 'true' &&
        tabs[0].tabIndex === 0 &&
        tabs[1].getAttribute('aria-selected') === 'false' &&
        tabs[1].tabIndex === -1 &&
        switcherHost.querySelector('[role="tablist"]').getAttribute('aria-label') ===
          'Demo map views' &&
        getComputedStyle(redPanel).visibility === 'visible' &&
        getComputedStyle(greenPanel).visibility === 'hidden' &&
        pixel.r > 180 &&
        pixel.g < 80 &&
        pixel.b < 80 &&
        pixel.a > 200,
      detail: {
        active: views.host.activeId,
        ids: views.host.ids,
        tabs: tabs.map((tab) => tab.textContent),
        pixel: pixelText(pixel),
      },
    };
  },
);

await check('UI-10 switching keeps each map view and layer state independent', async () => {
  const red = views.red;
  const center = red.getCenter();
  red.setCenter({ lat: center.lat + 0.002, lng: center.lng + 0.002 });
  const changedCenter = red.getCenter();
  const redControl = controlIn(red.container, 'layers');
  const redBox = redControl.querySelector('input[data-layer-id="red-view"]');
  redBox.click();
  const redHidden = !views.redLayer.isVisible();
  await sleep(150);
  const redWhileHidden = await red.debug.samplePixel({ x: 280, y: 120 });

  const green = await views.host.show('green');
  const greenLayer = green.addLayer({ id: 'green-view', label: 'Green points' });
  greenLayer.addPoints([{ id: 'center', position: green.getCenter() }], {
    style: { radiusPx: 64, color: '#16a34a' },
  });
  green.addControl('layers');
  await green.whenRendered();
  await sleep(120);
  const greenPixel = await green.debug.samplePixel({ x: 280, y: 120 });
  const greenControl = controlIn(green.container, 'layers');
  const greenLabel = greenControl.textContent;
  const redLabel = redControl.textContent;

  await views.host.show('red');
  await sleep(120);
  const redBack = views.host.get('red');
  const centerPreserved =
    Math.abs(red.getCenter().lat - changedCenter.lat) < 1e-12 &&
    Math.abs(red.getCenter().lng - changedCenter.lng) < 1e-12;
  const redStillHidden = !views.redLayer.isVisible();
  redBox.click();
  await sleep(150);
  const redRestored = await red.debug.samplePixel({ x: 280, y: 120 });

  views.green = green;
  return {
    pass:
      redHidden &&
      redWhileHidden.a < 10 &&
      views.host.activeId === 'red' &&
      greenPixel.g > 120 &&
      greenPixel.r < 80 &&
      greenPixel.b < 80 &&
      greenLabel.includes('Green points') &&
      redLabel.includes('Red points') &&
      redBack === red &&
      centerPreserved &&
      redStillHidden &&
      redRestored.r > 180 &&
      redRestored.g < 80 &&
      redRestored.a > 200,
    detail: {
      redHidden,
      redWhileHidden: pixelText(redWhileHidden),
      greenPixel: pixelText(greenPixel),
      greenLabel,
      redLabel,
      sameMap: redBack === red,
      centerPreserved,
      redStillHidden,
      redRestored: pixelText(redRestored),
    },
  };
});

await check('UI-10 tabs switch with the keyboard and report active changes', async () => {
  const tabs = switcherTabs();
  const seen = [];
  const off = views.host.onChange((id) => seen.push(id));
  tabs[0].focus();
  tabs[0].dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
  );
  await sleep(150);
  const afterRight = {
    active: views.host.activeId,
    selected: tabs[1].getAttribute('aria-selected'),
    tabIndex: tabs[1].tabIndex,
    focused: document.activeElement === tabs[1],
  };
  tabs[1].dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
  );
  await sleep(150);
  const afterHome = {
    active: views.host.activeId,
    selected: tabs[0].getAttribute('aria-selected'),
    focused: document.activeElement === tabs[0],
  };
  off();
  const notified = seen.length;
  tabs[1].click();
  await sleep(150);
  const afterOff = { active: views.host.activeId, seen: seen.length };
  return {
    pass:
      afterRight.active === 'green' &&
      afterRight.selected === 'true' &&
      afterRight.tabIndex === 0 &&
      afterRight.focused &&
      afterHome.active === 'red' &&
      afterHome.selected === 'true' &&
      afterHome.focused &&
      seen.includes('green') &&
      seen.includes('red') &&
      afterOff.active === 'green' &&
      afterOff.seen === notified,
    detail: { afterRight, afterHome, seen, afterOff },
  };
});

await check('UI-10 destroy releases both maps and the switcher DOM', async () => {
  const red = views.red;
  const green = views.green;
  views.host.destroy();
  let afterDestroy = null;
  try {
    await views.host.show('red');
  } catch (error) {
    afterDestroy = error?.code ?? String(error);
  }
  return {
    pass:
      switcherHost.querySelector('[data-maplet-switcher]') === null &&
      red.destroyed &&
      green.destroyed &&
      views.host.get('red') === undefined &&
      afterDestroy === 'destroyed',
    detail: {
      childCount: switcherHost.childElementCount,
      redDestroyed: red.destroyed,
      greenDestroyed: green.destroyed,
      afterDestroy,
    },
  };
});

await check('UI-07 destroy cancels watches and removes control DOM', async () => {
  const fake = fakeGeolocation();
  installGeolocation(fake.impl);
  const updates = [];
  const watch = map.locate.watch({ onUpdate: (entry) => updates.push(entry) });
  const id = [...fake.state.watches.keys()].at(-1);
  map.destroy();
  fake.state.watches.get(id).success(fix(50.9, 14.9));
  const stopped = updates.length === 0;
  const domGone =
    containerMain.querySelector('[data-maplet-control]') === null &&
    containerMain.querySelector('.maplet-ui') === null;
  let locateAfterDestroy = null;
  try {
    await map.locate();
  } catch (error) {
    locateAfterDestroy = error?.code ?? String(error);
  }
  planar.map.destroy();
  const planarDomGone = containerPlanar.querySelector('.maplet-ui') === null;
  if (originalGeolocation)
    Object.defineProperty(Navigator.prototype, 'geolocation', originalGeolocation);
  return {
    pass:
      stopped &&
      domGone &&
      planarDomGone &&
      locateAfterDestroy === 'destroyed' &&
      watch.active === false,
    detail: { stopped, domGone, planarDomGone, locateAfterDestroy, destroyed: map.destroyed },
  };
});

result.ms = Math.round(performance.now() - started);
result.pass =
  result.errors.length === 0 &&
  result.checks.every((entry) => entry.pass) &&
  result.checks.length === 14;
window.__uiCheckResult = result;
window.__ui = { main, planar, views };
document.title = 'ui-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
