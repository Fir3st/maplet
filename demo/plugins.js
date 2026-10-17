import {
  createMap,
  crs,
  POINT_STRIDE,
  LINE_STRIDE,
  FLAG_HIDDEN,
  FLAG_INTERACTIVE,
} from '../dist/index.js';

const status = document.querySelector('#status');
const tools = document.querySelector('#tools');
const addButton = document.querySelector('#add-pin');
const toggles = new Map(
  ['html', 'pins', 'color', 'canvas'].map((id) => [id, document.querySelector(`#${id}-plugin`)]),
);
const installed = new Map();

// HTML can be added, and existing controls can be modified without subclassing.
function htmlPlugin({ map, container, signal, onCleanup }) {
  const badge = container.ownerDocument.createElement('div');
  badge.className = 'plugin-badge';
  const title = document.createElement('strong');
  title.textContent = 'HTML from a plugin';
  const value = document.createElement('span');
  badge.append(title, value);
  container.append(badge);
  onCleanup(() => badge.remove());

  const zoom = map.controls.get('zoom').element();
  const previousTitle = zoom.title;
  zoom.title = 'Zoom control — modified by the HTML plugin';
  onCleanup(() => {
    zoom.title = previousTitle;
  });

  const update = () => {
    const pins = map.data.get('plugin-pins')?.features.count() ?? 0;
    value.textContent = `Zoom ${map.getView().zoom.toFixed(1)} · ${pins} pins`;
  };
  map.on('viewchange', update, { signal });
  map.on('commit', update, { signal });
  update();
  return { element: badge };
}

// The public API is whatever the plugin returns. Cleanup follows ownership order.
function pinsPlugin({ map, onCleanup }) {
  const source = map.data.vector({ id: 'plugin-pins' });
  onCleanup(() => map.data.remove(source.id));
  const layer = map.addLayer({
    id: 'plugin-pins',
    type: 'points',
    source,
    style: { color: '#ea580c', radiusPx: 10, strokeColor: '#ffffff', strokeWidthPx: 2 },
  });
  onCleanup(layer.remove);
  let nextId = 1;
  const add = () => {
    const id = nextId++;
    const angle = id * 2.4;
    source.features.add({
      id: `pin-${id}`,
      geometry: {
        type: 'point',
        position: { x: Math.cos(angle) * 0.28, y: Math.sin(angle) * 0.22 },
      },
      properties: { name: `Demo pin ${id}` },
    });
  };
  add();
  add();
  add();
  return { add };
}

// Packed buffers are borrowed read-only. Replace only the draw being changed.
function colorPlugin({ render }) {
  render.transform((plan) => ({
    ...plan,
    draws: plan.draws.map((draw) => {
      if (draw.type !== 'batch' || draw.batch.layerId !== 'plugin-pins') return draw;
      const data = new Float32Array(draw.batch.data);
      for (let i = 0; i < data.length; i += POINT_STRIDE) {
        data[i + 4] = 0.145;
        data[i + 5] = 0.388;
        data[i + 6] = 0.922;
      }
      return { ...draw, batch: { ...draw.batch, data } };
    }),
  }));
}

const rgba = (data, i) =>
  `rgba(${data[i] * 255},${data[i + 1] * 255},${data[i + 2] * 255},${data[i + 3]})`;

// A small renderer for this example's circle/solid-line scene, not a complete
// Canvas implementation of every Maplet draw kind. Its surface and picking are its own.
function canvasPlugin({ container, render, onCleanup }) {
  const canvas = container.ownerDocument.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  onCleanup(() => canvas.remove());
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  let hits = [];
  let stats = { instances: 0, drawCalls: 0, gpuBytes: 0 };

  render.use({
    render({ plan }) {
      canvas.width = plan.deviceWidth;
      canvas.height = plan.deviceHeight;
      canvas.style.width = `${plan.view.width}px`;
      canvas.style.height = `${plan.view.height}px`;
      ctx.setTransform(plan.dpr, 0, 0, plan.dpr, 0, 0);
      hits = [];
      stats = { instances: 0, drawCalls: 0, gpuBytes: 0 };
      for (const draw of plan.draws) {
        if (draw.type !== 'batch') continue;
        const batch = draw.batch,
          data = batch.data;
        const dx = batch.offsetX ?? 0,
          dy = batch.offsetY ?? 0;
        if (batch.kind === 'lines') {
          for (let n = 0; n < batch.count; n++) {
            const i = n * LINE_STRIDE;
            if (data[i + 7] & FLAG_HIDDEN) continue;
            ctx.beginPath();
            ctx.moveTo(data[i] + dx, data[i + 1] + dy);
            ctx.lineTo(data[i + 2] + dx, data[i + 3] + dy);
            ctx.strokeStyle = rgba(data, i + 8);
            ctx.lineWidth = data[i + 4];
            ctx.lineCap = data[i + 5] === 1 ? 'round' : 'butt';
            ctx.stroke();
            stats.instances++;
            stats.drawCalls++;
          }
        } else if (batch.kind === 'points') {
          for (let n = 0; n < batch.count; n++) {
            const i = n * POINT_STRIDE;
            if (data[i + 15] & FLAG_HIDDEN) continue;
            const x = data[i] + dx,
              y = data[i + 1] + dy,
              rx = data[i + 2],
              ry = data[i + 3];
            ctx.beginPath();
            ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
            ctx.fillStyle = rgba(data, i + 4);
            ctx.fill();
            if (data[i + 13] > 0) {
              ctx.strokeStyle = rgba(data, i + 8);
              ctx.lineWidth = data[i + 13];
              ctx.stroke();
            }
            const entry = plan.pickTable.get(data[i + 14] + (batch.pickBase ?? 0));
            if (entry && data[i + 15] & FLAG_INTERACTIVE) {
              hits.push({ x, y, rx, ry, entry, revision: plan.revision });
            }
            stats.instances++;
            stats.drawCalls++;
          }
        }
      }
    },
    async pick(point, { limit }) {
      const results = [];
      for (let i = hits.length - 1; i >= 0 && results.length < limit; i--) {
        const hit = hits[i];
        if (((point.x - hit.x) / hit.rx) ** 2 + ((point.y - hit.y) / hit.ry) ** 2 > 1) continue;
        results.push({
          feature: hit.entry.feature,
          layerId: hit.entry.layerId,
          sourceId: hit.entry.feature.sourceId,
          screen: point,
          revision: hit.revision,
        });
      }
      return results;
    },
    stats: () => stats,
    destroy() {
      hits = [];
    },
  });
}

const factories = new Map([
  ['html', htmlPlugin],
  ['pins', pinsPlugin],
  ['color', colorPlugin],
  ['canvas', canvasPlugin],
]);
let map = null;

try {
  const requested = new URLSearchParams(location.search).get('backend');
  const primary = requested === 'webgpu' ? 'webgpu' : requested === 'none' ? 'none' : 'webgl1';
  map = await createMap('map', {
    projection: crs.simple(),
    renderer: { primary, fallback: primary === 'none' ? false : 'webgl1' },
    center: { x: 0, y: 0 },
    zoom: 1,
    minZoom: 0,
    maxZoom: 5,
  });
  map.addControl({ id: 'zoom', kind: 'zoom' });
  const grid = map.data.vector({ id: 'demo-grid' });
  const lines = [];
  for (let i = -8; i <= 8; i++) {
    lines.push({
      id: `h${i}`,
      geometry: {
        type: 'lineString',
        positions: [
          { x: -2, y: i / 4 },
          { x: 2, y: i / 4 },
        ],
      },
    });
    lines.push({
      id: `v${i}`,
      geometry: {
        type: 'lineString',
        positions: [
          { x: i / 4, y: -2 },
          { x: i / 4, y: 2 },
        ],
      },
    });
  }
  grid.features.add(lines);
  map.addLayer({
    id: 'demo-grid',
    type: 'lines',
    source: grid,
    style: { color: '#cbd5e1', widthPx: 1 },
    interactive: false,
  });
  const route = map.data.vector({ id: 'demo-route' });
  route.features.add({
    id: 'route',
    geometry: {
      type: 'lineString',
      positions: [
        { x: -1, y: -0.35 },
        { x: -0.28, y: 0.1 },
        { x: 0.18, y: -0.05 },
        { x: 0.7, y: 0.4 },
        { x: 1, y: 0.3 },
      ],
    },
  });
  map.addLayer({
    id: 'demo-route',
    type: 'lines',
    source: route,
    style: { color: '#94a3b8', widthPx: 4 },
    interactive: false,
  });

  const updateStatus = (message = '') => {
    addButton.disabled = !installed.has('pins');
    status.classList.remove('error');
    const pins = map.data.get('plugin-pins')?.features.count() ?? 0;
    status.textContent = `${map.capabilities().backend} · ${installed.size} plugins · ${pins} pins${message ? ` · ${message}` : ''}`;
  };
  const showError = (error) => {
    status.classList.add('error');
    status.textContent = error.message;
  };
  const setPlugin = (id, enabled) => {
    if (enabled) installed.set(id, map.use(factories.get(id)));
    else {
      installed.get(id)?.remove();
      installed.delete(id);
    }
  };
  for (const [id, toggle] of toggles) {
    if (id === 'canvas' && primary === 'none') toggle.checked = true;
    if (toggle.checked) setPlugin(id, true);
    toggle.addEventListener('change', async () => {
      try {
        setPlugin(id, toggle.checked);
        await map.whenRendered();
        updateStatus();
      } catch (error) {
        toggle.checked = installed.has(id);
        showError(error);
      }
    });
  }
  addButton.addEventListener('click', async () => {
    try {
      installed.get('pins').api.add();
      await map.whenRendered();
      updateStatus();
    } catch (error) {
      showError(error);
    }
  });
  document.querySelector('#reset-view').addEventListener('click', async () => {
    try {
      map.setView({ center: { x: 0, y: 0 }, zoom: 1 });
      await map.whenRendered();
      updateStatus('View reset');
    } catch (error) {
      showError(error);
    }
  });
  document.querySelector('#remove-all').addEventListener('click', async () => {
    try {
      for (const id of [...installed.keys()].reverse()) {
        setPlugin(id, false);
        toggles.get(id).checked = false;
      }
      await map.whenRendered();
      updateStatus('Plugins removed; base scene retained');
    } catch (error) {
      showError(error);
    }
  });
  map.onFeature((event) => {
    if (event.type === 'click') updateStatus(`Selected ${event.feature.id}`);
  });
  map.on('rendererror', ({ error }) => showError(error));
  window.addEventListener('pagehide', () => map.destroy(), { once: true });
  await map.whenRendered();
  updateStatus();
  tools.disabled = false;
} catch (error) {
  map?.destroy();
  status.classList.add('error');
  status.textContent = `${error.message}. For the Canvas-only example, open plugins.html?backend=none.`;
}
