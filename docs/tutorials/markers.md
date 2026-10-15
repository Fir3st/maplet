# Markers with tooltips and popups

`map.addMarker()` puts one Leaflet-style pin on the map: a GPU sprite at a
position with a hover tooltip and a click popup. `map.addMarkers()` adds several
at once and returns their handles.

## Create a marker

```ts
map.assets.addImage({ id: 'my-pin', src: '/images/pin.svg' });
const depot = map.addMarker({
  position: { lat: 50.08, lng: 14.43 },
  tooltip: 'Freight depot',
  popup: { content: 'Depot A — 12 platforms', autoPan: true },
});
map.addMarkers([
  { position: { lat: 50.09, lng: 14.44 }, iconTint: '#16724c' },
  { position: { lat: 50.1, lng: 14.45 }, icon: 'my-pin', iconSize: 24, iconAnchor: { x: 0, y: -12 } },
]);
```

The built-in pin needs no asset: it is a flat teardrop with a white rim and an
inner dot, so it stays legible on a busy basemap and overlapping pins keep their
edges. Per-marker `icon`, `iconSize`, `iconAnchor` and `iconTint` override the
layer defaults; `iconSize` is a square CSS size and the tint multiplies the
texture (default white) — a white-bodied asset with the same silhouette is what
makes category colours read, as the city guide recipe does.

## Live example

Hover a pin for its tooltip, click it for the popup, drag the purple crane pin
(a draggable pin — the map stays put), move a pin with the button and watch its
popup follow, and toggle the permanent tooltip.

<!-- example -->

## Drag a pin

`draggable: true` opts one pin into dragging; the pins around it keep panning
the map.

```ts
const crane = map.addMarker({
  position: { x: -0.42, y: 0.68 },
  draggable: true,
  tooltip: 'Dock crane — drag me',
});
crane.on('dragend', event => console.log(event.screen));
crane.setDraggable(false); // turn dragging off again at runtime
```

A drag starts after four CSS pixels, translates the position rigidly and
suppresses pan, so the pin and the map never move together. A press without
movement stays a click and a drag never opens the popup. `dragstart`, `drag` and
`dragend` arrive as ordinary feature events, so their `screen` and `position`
carry the pointer state and the overlays follow the pin for free.

## Tooltips and popups

- A tooltip shows on hover. `{ content, permanent: true }` keeps it visible and
  `offsetPx` moves it; `setTooltip(null)` unbinds it and `openTooltip()` opens a
  sticky tooltip that survives `mouseout` until `closeTooltip()`.
- One popup exists per map at a time. A marker click or `openPopup()` opens it;
  its × button, a background click, `closePopup()` or removing the marker closes
  it. `autoPan` (default true) moves the map by the minimum amount that keeps the
  popup and its pin inside the view.
- Content follows the detail contract: a **string renders as text** (never active
  HTML) and a caller-supplied `Node` is appended as-is.
- The handle moves the pin (`setPosition`), swaps the icon (`setIcon`), toggles
  visibility (`show`/`hide`), emits feature events (`on('click')`,
  `on('mouseover')`) and removes itself (`remove`).

Pins are canvas sprites — there is no DOM element per marker — and they are not
zoom-gated: unlike data layers, whose default `minZoom` is 0, a marker stays
visible at the negative zooms planar maps can use. Dragging is opt-in per pin
(`draggable: true`); clustering and DOM focus are not part of this alpha. See the
[marker contracts](../decisions.md#markers) and
[rendering guide](../rendering.md#markers).
