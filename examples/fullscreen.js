import { openExample, action, ready, report, fullscreenMode } from './shared.js';

const map = await openExample();
map.addPoints([
  { id: 'p1', position: { x: -0.6, y: 0.4 }, properties: { name: 'Depot' } },
  { id: 'p2', position: { x: 0.2, y: -0.35 }, properties: { name: 'Market' } },
  { id: 'p3', position: { x: 0.8, y: 0.45 }, properties: { name: 'Harbour' } },
], { style: { minZoom: -1, radiusPx: 8, color: '#16724c', strokeColor: '#ffffff', strokeWidthPx: 2 } });

// `control: true` adds the corner button; Escape or the button leaves again.
// A real request needs a user gesture, so the buttons below are the way in.
const fullscreen = map.use(fullscreenMode({
  control: true,
  onChange: (active) => report(active ? 'Fullscreen is on; the map resized itself.' : 'Back to the page layout.'),
}));

action('Toggle fullscreen', async () => {
  const active = await fullscreen.api.toggle();
  report(active ? 'Fullscreen is on.' : fullscreen.api.supported ? 'The browser denied fullscreen (a direct click or tap is required).' : 'This browser has no Fullscreen API.');
});
action('Exit fullscreen', async () => {
  await fullscreen.api.exit();
});
action('Remove the plugin', () => {
  fullscreen.remove();
  report('The plugin is removed: it left fullscreen and removed its button and listener.');
});
await ready(map, { fullscreen });
