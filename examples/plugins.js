import { openExample, action, ready, report } from './shared.js';

const map = await openExample();
function pinsPlugin({ map, container, onCleanup }) {
  const layer = map.addLayer({ id: 'plugin-pins' });
  onCleanup(layer.remove);
  const pins = layer.addPoints([], {
    style: { minZoom: -1, color: '#bd573b', radiusPx: 11, strokeColor: '#fff', strokeWidthPx: 3 } });
  const badge = document.createElement('div');
  badge.className = 'plugin-badge'; badge.textContent = 'HTML owned by the plugin';
  container.append(badge);
  onCleanup(() => badge.remove());
  let id = 0;
  const add = () => {
    id++;
    pins.add({ id: `pin-${id}`, position: { x: Math.cos(id * 2.4) * 0.5, y: Math.sin(id * 2.4) * 0.35 } });
  };
  add(); add(); add();
  return { add };
}
let plugin = map.use(pinsPlugin);
action('Install / remove plugin', () => {
  if (plugin) { plugin.remove(); plugin = null; report('Removed the plugin: its badge, layer and source are gone.'); }
  else { plugin = map.use(pinsPlugin); report('Installed the plugin with three initial pins.'); }
});
action('Add a pin', () => {
  if (!plugin) { report('Install the plugin first.'); return; }
  plugin.api.add(); report('Called plugin.api.add() to create a pin.');
});
await ready(map);
