import { openExample, action, ready, report, gestureGuard } from './shared.js';

const map = await openExample();
map.addPoints([
  { id: 'p1', position: { x: -0.7, y: 0.35 }, properties: { name: 'North yard' } },
  { id: 'p2', position: { x: 0.15, y: -0.4 }, properties: { name: 'Workshop' } },
  { id: 'p3', position: { x: 0.85, y: 0.5 }, properties: { name: 'Gate' } },
], { style: { minZoom: -1, radiusPx: 8, color: '#2563eb', strokeColor: '#ffffff', strokeWidthPx: 2 } });

// The guard blocks accidental gestures: hold Alt while dragging or scrolling,
// or unlock the map with the button below. Touch needs two fingers. Removal is
// reversible: toggling back on installs a fresh, guarded instance.
const options = {
  onChange: (state) => report(state.unlocked ? 'Every gesture is allowed now.' : 'Gestures are guarded again.'),
};
let guard = map.use(gestureGuard(options));
let ctrl = false;

const install = () => {
  guard = map.use(gestureGuard(options));
  ctrl = false;
  toggle.textContent = 'Toggle the guard off';
};

action('Unlock / lock the map', () => {
  if (!guard) {
    report('The guard is removed; "Toggle the guard on" installs it again.');
    return;
  }
  if (guard.api.unlocked) guard.api.lock();
  else guard.api.unlock();
  report(guard.api.unlocked ? 'Unlocked: pan, wheel zoom and double-click work without a modifier.' : 'Guarded: hold Alt to interact.');
});
action('Switch modifier', () => {
  if (!guard) {
    report('The guard is removed; "Toggle the guard on" installs it again.');
    return;
  }
  ctrl = !ctrl;
  guard.api.setModifier(ctrl ? 'control' : 'alt');
  report(ctrl ? 'Hold Ctrl (or ⌘ with meta) to interact.' : 'Hold Alt (⌥) to interact.');
});
const toggle = action('Toggle the guard off', () => {
  if (!guard) {
    install();
    report('The guard is installed again: hold Alt to interact, or unlock the map with the button.');
    return;
  }
  guard.remove();
  guard = null;
  toggle.textContent = 'Toggle the guard on';
  report('The plugin is removed; the map behaves as before and touch-action is restored.');
});
// Reset restores the whole demo, not only the view: a removed plugin would
// otherwise be a one-way door.
document.querySelector('#reset-view').addEventListener('click', () => {
  if (!guard) install();
  ctrl = false;
  guard.api.setModifier('alt');
  guard.api.lock();
  report('View reset; the guard is installed and guarded again (modifier Alt).');
});
await ready(map, { guard });
