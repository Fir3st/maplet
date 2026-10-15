import { openExample, action, ready, report, gestureGuard } from './shared.js';

const map = await openExample();
map.addPoints([
  { id: 'p1', position: { x: -0.7, y: 0.35 }, properties: { name: 'North yard' } },
  { id: 'p2', position: { x: 0.15, y: -0.4 }, properties: { name: 'Workshop' } },
  { id: 'p3', position: { x: 0.85, y: 0.5 }, properties: { name: 'Gate' } },
], { style: { minZoom: -1, radiusPx: 8, color: '#2563eb', strokeColor: '#ffffff', strokeWidthPx: 2 } });

// The guard blocks accidental gestures: hold Alt while dragging or scrolling,
// or unlock the map with the button below. Touch needs two fingers.
const guard = map.use(gestureGuard({
  onChange: (state) => report(state.unlocked ? 'Every gesture is allowed now.' : 'Gestures are guarded again.'),
}));

let ctrl = false;
action('Unlock / lock the map', () => {
  if (guard.api.unlocked) guard.api.lock();
  else guard.api.unlock();
  report(guard.api.unlocked ? 'Unlocked: pan, wheel zoom and double-click work without a modifier.' : 'Guarded: hold Alt to interact.');
});
action('Switch modifier', () => {
  ctrl = !ctrl;
  guard.api.setModifier(ctrl ? 'control' : 'alt');
  report(ctrl ? 'Hold Ctrl (or ⌘ with meta) to interact.' : 'Hold Alt (⌥) to interact.');
});
action('Toggle the guard off', () => {
  guard.remove();
  report('The plugin is removed; the map behaves as before and touch-action is restored.');
});
await ready(map, { guard });
