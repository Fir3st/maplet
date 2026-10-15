# Fullscreen mode

The `fullscreenMode` plugin toggles the map container through the browser's
Fullscreen API and keeps its state in sync, including exits started with Escape,
the corner button or `document.exitFullscreen()`.

## Install it

```ts
import { fullscreenMode } from '@fir3st/maplet';

const fullscreen = map.use(fullscreenMode({ control: true, onChange: (active) => report(active) }));
await fullscreen.api.toggle();   // a real request needs a user gesture
fullscreen.api.active;           // follows fullscreenchange, never guessed
fullscreen.remove();             // exits and removes the button and listener
```

- `enter()`, `exit()` and `toggle()` resolve a boolean instead of throwing:
  `false` means unsupported or denied, and `supported`/`active` describe the
  current state.
- `control: true` (or `{ position, label }`) adds a corner button that mirrors
  the state; `target` selects another element to make fullscreen.
- The map resizes through its own container observer, so no manual `resize()`
  call is needed after entering or leaving.
- Removing the plugin exits fullscreen, removes the button and stops listening.

## Live example

Use the corner button or the controls below. Escape or the browser's own exit
also updates the plugin state and the button.

<!-- example -->

## Notes

Fullscreen needs a browser that supports the API and a user gesture for each
request; a denied request resolves `false` instead of throwing. See the
[plugins guide](../plugins.md#built-in-plugins) and
[known limitations](../status.md#known-limitations).
