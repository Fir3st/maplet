import { openExample, action, ready, report } from './shared.js';

const map = await openExample();
function pinsPlugin({ map, container, onCleanup }) {
  const source = map.sources.vector({ id: 'plugin-pins' });
  onCleanup(() => map.sources.remove(source.id));
  const layer = map.layers.add({ id: 'plugin-pins', type: 'points', source,
    style: { color: '#bd573b', radiusPx: 11, strokeColor: '#fff', strokeWidthPx: 3 } });
  onCleanup(layer.remove);
  const badge = document.createElement('div');
  badge.className = 'plugin-badge'; badge.textContent = 'HTML owned by the plugin';
  container.append(badge);
  onCleanup(() => badge.remove());
  let id = 0;
  const add = () => {
    id++;
    source.features.add({ id: `pin-${id}`, properties: {}, geometry: { type: 'point', position: { x: Math.cos(id * 2.4) * 0.5, y: Math.sin(id * 2.4) * 0.35 } } });
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
