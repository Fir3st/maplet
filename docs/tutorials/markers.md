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

The built-in pin needs no asset. Per-marker `icon`, `iconSize`, `iconAnchor` and
`iconTint` override the layer defaults; `iconSize` is a square CSS size and the
tint multiplies the texture (default white).

## Live example

Hover a pin for its tooltip, click it for the popup, move a pin and watch its
popup follow, and toggle the permanent tooltip.

<!-- example -->

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

Pins are canvas sprites — there is no DOM element per marker — so marker
dragging, clustering and DOM focus are not part of this alpha. See the
[marker contracts](../decisions.md#markers) and
[rendering guide](../rendering.md#markers).
