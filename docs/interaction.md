# Interaction and UI

## Feature events

```ts
const off = points.on('click', event => {
  console.log(event.feature.id, event.position);
});
places.on('dragend', event => console.log(event.feature));
off();
```

Objects, collections and logical layers accept `click`, `mouseover`, `mouseout`,
`mousemove`, `dragstart`, `drag` and `dragend`. Events bubble through the current
logical parents to the map. `stopPropagation()` stops that chain; it does not
change gesture handling. `event.layerId` names the hit collection/render pass.

`on()` and `once()` return unsubscribe functions and accept `{ signal }`.
Object listeners are released when the feature or collection disappears. For
dense datasets, prefer one collection listener to a listener per feature.

Map clicks also include background clicks, with `feature: null`:

```ts
map.on('click', event => {
  if (event.feature) console.log('Feature', event.feature.id);
  else console.log('Background', event.position);
});
```

Map lifecycle events include `commit`, `viewchange`, `viewstart`, `viewend`,
`selectchange`, `backend`, `rendererror` and `destroy`. `onFeature()` is the
aggregate feature-only stream; `pointer` observes map pointer events.

## Gestures and selection

Map interaction supports pan, wheel zoom, pinch and keyboard navigation. A draggable
feature starts dragging after four CSS pixels and does not also pan the map.
Set `interactive: false` on a map to disable interaction, or update individual
gesture options through `map.interaction?.setOptions()`. For accidental-gesture
protection use the built-in [gesture guard](plugins.md#built-in-plugins) plugin,
or install your own policy through `map.interaction?.setGestureGate(gate)`; a
blocked wheel is not prevented, so the page keeps scrolling.

Use `draggable: true` on a vector collection. Selection is shared feature state:
objects expose `select()`/`deselect()`, and `map.selection` provides
`get`, `set`, `add`, `remove`, `clear` and `subscribe`. `map.state.set(ref, patch)`
updates other state read by style expressions. Enable box selection through
`interaction: { boxSelection: true }`.

## Queries

| Method | Result |
| --- | --- |
| `map.query.at(position, options)` | Data snapshots near a canonical position; default tolerance 4 CSS px |
| `map.query.area(bounds, options)` | Bounded data results and a revision-bound pagination cursor |
| `map.query.rendered(screenPoint, options)` | Async rendered picks, respecting shape, holes and interaction flags |

Data queries and rendered picking are different: hidden data can remain in source
queries. Area cursors reject with `invalid-state` after a revision change. WebGL
readback blocks despite the async rendered-query signature; statistics report the
measured stall. See [picking contracts](decisions.md#picking-and-interaction).

## Controls

```ts
const map = await createMap('map', { controls: ['zoom', 'layers', 'scale', 'attribution'] });
const zoom = map.addControl({ kind: 'zoom', position: 'topright' });
zoom.remove();
```

Controls are opt-in. `map.controls.get/list/remove` manages them. Layer controls
list root entries in painter order; toggling a root affects its subtree. Attribution
follows active source membership and renders as text. Scale uses meters on geographic
maps and planar units on simple CRS.

The `list` control offers a bounded keyboard-operable feature list rather than a
DOM button for every source record. Headless maps reject DOM-only operations.

## Feature details

```ts
points.on('click', event => {
  map.detail.open(event.feature, { content: feature => String(feature.properties.name) });
});
```

One detail is open at a time. It follows the reference's generation and position;
removing the feature closes it by default. Strings render as text. Explicit DOM
nodes are caller-owned content, so handle untrusted content safely.
Use `map.detail.current()` or `close()` to inspect or close it.

## Geolocation

```ts
const result = await map.locate({ setView: true });
if (result.ok) console.log(result.position);
```

Geolocation needs browser support and permission. Success returns `ok: true` and
a position; failure returns `ok: false` with code `permission`, `timeout`,
`unavailable` or `unsupported`. `map.locate.watch()` returns
a cancellable watch; map destruction stops it and ignores late callbacks.
See [UI contracts](decisions.md#html-controls-detail-and-geolocation).
