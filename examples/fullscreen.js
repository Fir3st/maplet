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
  onChange: () => {
    const mode = fullscreen.api.mode;
    report(mode === 'native'
      ? 'Fullscreen is on (Fullscreen API); the map resized itself.'
      : mode === 'fallback'
        ? 'Fullscreen is on (viewport fallback — the browser did not grant the API).'
        : 'Back to the page layout.');
  },
}));

action('Toggle fullscreen', async () => {
  const active = await fullscreen.api.toggle();
  report(active
    ? fullscreen.api.mode === 'native'
      ? 'Fullscreen is on (Fullscreen API).'
      : 'Fullscreen is on (viewport fallback — the browser denied the API).'
    : fullscreen.api.supported
      ? 'The browser denied fullscreen (a direct click or tap is required).'
      : 'Fullscreen is off.');
});
action('Exit fullscreen', async () => {
  await fullscreen.api.exit();
});
action('Remove the plugin', () => {
  fullscreen.remove();
  report('The plugin is removed: it left fullscreen and removed its button and listener.');
});
await ready(map, { fullscreen });
