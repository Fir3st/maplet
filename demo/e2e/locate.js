/**
 * Locate-control scene for the e2e driver: a real map with the built-in locate
 * control and a deterministic geolocation provider. The scenario clicks the
 * button with real mouse input, answers the pending browser request and checks
 * the public view plus the control's accessible state.
 */
import { createMap } from '../../dist/index.js';

const backend = new URLSearchParams(location.search).get('backend');

const fake = { calls: [], watches: new Map(), cleared: [], nextId: 1 };
const provider = {
  getCurrentPosition(success, error, options) {
    fake.calls.push({ success, error, options });
  },
  watchPosition(success, error, options) {
    const id = fake.nextId++;
    fake.watches.set(id, { success, error, options });
    return id;
  },
  clearWatch(id) {
    fake.cleared.push(id);
  },
};
Object.defineProperty(Navigator.prototype, 'geolocation', {
  configurable: true,
  get: () => provider,
});

const map = await createMap('map', {
  renderer:
    backend === 'webgpu'
      ? { primary: 'webgpu', fallback: false }
      : { primary: 'webgl1', fallback: false },
  size: { width: 640, height: 480 },
  center: { lat: 50.08, lng: 14.44 },
  zoom: 8,
  minZoom: 2,
  maxZoom: 12,
  controls: [
    {
      kind: 'locate',
      id: 'locate',
      options: { label: 'Find me', zoom: 6, timeoutMs: 5000 },
    },
  ],
});
map.addMarker({ position: { lat: 50.08, lng: 14.44 }, tooltip: 'Start' });

const control = document.querySelector('[data-maplet-control="locate"]');
const button = control.querySelector('[data-action="locate"]');
const status = control.querySelector('[data-maplet-locate-status]');

function state() {
  const view = map.getView();
  const rect = button.getBoundingClientRect();
  return {
    state: button.dataset.state,
    busy: button.getAttribute('aria-busy'),
    label: button.getAttribute('aria-label'),
    title: button.title,
    status: status.textContent,
    color: getComputedStyle(button).color,
    calls: fake.calls.length,
    options: fake.calls.at(-1)?.options ?? null,
    center: view.center,
    zoom: view.zoom,
    focused: document.activeElement === button,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

window.__e2e = {
  ready: false,
  map,
  fake,
  state,
  respond(lat, lng, accuracy = 10) {
    const call = fake.calls.at(-1);
    if (!call) throw new Error('no pending geolocation request');
    call.success({ coords: { latitude: lat, longitude: lng, accuracy } });
  },
  fail(code = 1) {
    const call = fake.calls.at(-1);
    if (!call) throw new Error('no pending geolocation request');
    call.error({ code, message: 'denied by the fixture' });
  },
};

await map.whenRendered(map.stats().revision);
window.__e2e.ready = true;
