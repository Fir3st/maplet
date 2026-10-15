# Gesture guard

The `gestureGuard` plugin keeps a map embedded in a page from panning or zooming
by accident: touch gestures need two fingers, mouse gestures need a modifier key,
and a one-finger drag scrolls the page instead of moving the map.

## Install it

```ts
import { gestureGuard } from '@fir3st/maplet';

const guard = map.use(gestureGuard({ modifier: 'alt', touchPointers: 2 }));
guard.api.unlock();            // allow everything until lock(), e.g. from a button
guard.api.setModifier('control');
guard.remove();                // restores touch-action and clears the gate
map.use(gestureGuard());       // installing again starts a fresh, guarded instance
```

| Option | Default | Meaning |
| --- | --- | --- |
| `modifier` | `'alt'` | `alt`, `control`, `shift`, `meta` or `none` for mouse/pen gestures |
| `touchPointers` | `2` | Fingers required before a touch gesture applies |
| `touchAction` | `'pan-y'` | Container `touch-action` while the plugin is installed |
| `unlocked` | `false` | Start with every gesture allowed; `lock()` still applies |
| `overlay` | on | Explain blocked attempts with a hint overlay, or `false` to stay silent |
| `onChange` | — | Notified whenever `unlock()`/`lock()` change the state |

A blocked attempt shows a short hint over the map — *Use 2 fingers to move the
map*, *Hold Alt and scroll to zoom the map* — following the same pattern as
Leaflet's gesture-handling plugins. It disappears on its own (default after
2.2 s), on the next allowed gesture, or on `unlock()`; `overlay: { durationMs,
message }` changes the timing or the wording.

## Live example

Hold Alt (or ⌥) while dragging or scrolling, unlock the map with the button, or
switch the modifier. **Toggle the guard off** removes the plugin and toggling it
back on installs a fresh instance; **Reset view** restores the view together with
the guarded state. A blocked attempt shows the hint overlay over the map; on a
touch device one finger scrolls the page and two fingers pan and pinch.

<!-- example -->

## What stays available

- Wheel and double-click zoom need the modifier; a blocked wheel is not
  prevented, so the page keeps scrolling normally.
- Keyboard panning and zooming (arrow keys, `+`/`-`) are never gated, and box
  selection keeps its explicit Shift requirement.
- On touch, a two-finger drag pans, a two-finger pinch zooms, and dragging a
  feature needs the same two-finger rule.
- `map.interaction?.setGestureGate(gate)` is the underlying hook if you need a
  custom policy without this plugin.

See [interaction](../interaction.md#gestures-and-selection) and the
[plugins guide](../plugins.md#built-in-plugins).
