import { createMap, crs, style } from '../../dist/index.js';
export { style };

const status = document.querySelector('#status');
const tools = document.querySelector('#example-tools');
const initialBackend = new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1';
const backend = document.querySelector('#backend');
backend.value = initialBackend;
backend.addEventListener('change', () => {
  const url = new URL(location.href);
  url.searchParams.set('backend', backend.value);
  location.href = url.href;
});

export function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

export function action(label, run) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.disabled = true;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await run(); } catch (error) { report(error.message, true); }
    finally { button.disabled = false; }
  });
  tools.append(button);
  return button;
}

export async function openExample({ geographic = false, center, zoom } = {}) {
  const initialView = {
    center: center ?? (geographic ? { lat: 50.08, lng: 14.43 } : { x: 0, y: 0 }),
    zoom: zoom ?? (geographic ? 12 : 0),
  };
  const map = await createMap('map', {
    projection: geographic ? crs.webMercator() : crs.simple(),
    renderer: initialBackend,
    ...initialView,
    minZoom: geographic ? 2 : -1, maxZoom: geographic ? 18 : 6,
    interaction: { boxSelection: true },
    controls: ['zoom'],
  });
  if (!geographic) {
    const lines = [];
    for (let i = -12; i <= 12; i++) {
      lines.push({ id: `h${i}`, positions: [{ x: -3, y: i / 4 }, { x: 3, y: i / 4 }] });
      lines.push({ id: `v${i}`, positions: [{ x: i / 4, y: -3 }, { x: i / 4, y: 3 }] });
    }
    map.addLines(lines, { id: 'guide-grid', style: { color: '#dce5df', widthPx: 1 }, interactive: false });
  }
  document.querySelector('#reset-view').addEventListener('click', () => map.setView(initialView));
  map.on('rendererror', event => report(`Rendering failed: ${event.error?.message ?? 'GPU unavailable'}`, true));
  return map;
}

export async function ready(map, data = {}) {
  await map.whenRendered();
  for (const button of tools.querySelectorAll('button')) button.disabled = false;
  document.querySelector('#reset-view').disabled = false;
  const update = () => {
    const stats = map.stats();
    document.querySelector('#map-stats').textContent = `${map.capabilities().backend} · ${stats.features} features · revision ${stats.revision}`;
  };
  map.on('commit', update);
  update();
  report('Ready — try the controls or interact with the map.');
  window.__example = { map, ...data };
  window.__exampleReady = true;
  window.addEventListener('pagehide', event => { if (!event.persisted) map.destroy(); });
}

window.addEventListener('error', event => report(`Example failed: ${event.message}`, true));
window.addEventListener('unhandledrejection', event => report(`Example failed: ${event.reason?.message ?? event.reason}`, true));

const code = document.querySelector('#source-code');
const copy = document.querySelector('#copy-source');
copy.disabled = !navigator.clipboard?.writeText;
copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(code.textContent); report('Example source copied.'); }
  catch { report('Clipboard access was denied. Select and copy the source below instead.', true); }
});

const gallery = document.body.dataset.gallery;
if (gallery) {
  fetch(new URL('gists.json', new URL(gallery, location.href)))
    .then(response => { if (!response.ok) throw new Error('Gist links unavailable'); return response.json(); })
    .then(links => {
      const url = links[document.body.dataset.example];
      if (!url || !/^https:\/\/gist\.github\.com\/[A-Za-z0-9-]+\/[0-9a-f]+$/.test(url)) return;
      const link = document.querySelector('#gist-link');
      link.href = url; link.textContent = 'Open source Gist ↗'; link.removeAttribute('aria-disabled');
    })
    .catch(() => { document.querySelector('#gist-link').textContent = 'Gist links unavailable'; });
}
