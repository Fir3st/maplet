# Styles and rendering

## Collection and object styles

Styles belong to typed collections, not heterogeneous containers. Collection
`setStyle()` replaces its base style; object `setStyle()` patches a local override.
`clearStyle()` restores the collection style. Hiding never deletes source data.

```ts
import { style } from '@fir3st/maplet';

points.setStyle({
  radiusPx: style.when(style.state('selected'), 14, 9),
  color: style.by('status', { online: '#16724c', offline: '#bd573b' }, '#66776d'),
});
points.get('prague')?.setStyle({ radiusPx: 12 });
```

`style.by()` maps properties with an explicit fallback. Expressions also support
fields, state, zoom, comparisons, arithmetic, conditionals and interpolation.
Filters use the same declarative system. Pixel sizes stay constant during zoom;
metric circles are geometry, not a pixel-radius style.

Style zoom visibility defaults to `[0, 24]`. Set `style.minZoom` explicitly when a
planar map needs negative zoom levels. The planar tutorials use `minZoom: -1` so
their complete scene remains visible at the smaller initial scale on narrow screens.

## Geometry

Points support circle, square, diamond and triangle shapes. Lines have width,
color, dash, cap and join styles. Polygon rings are exterior first, then holes;
fills can have independent stroke and fill appearance. Earlier sibling layers
draw beneath later ones. `move()` changes tree order; `zIndex` orders features
within a render pass, with stable slot order for ties.

## Images and labels

```ts
map.assets.addImage({ id: 'pin', src: '/images/pin.svg' });
points.setStyle({ icon: 'pin', iconSize: 32, iconAnchor: { x: 0, y: -16 } });
places.addLabels(points.source, { style: { sizePx: 14, offsetPx: { x: 0, y: -32 } } });
```

Register an image once and reuse it by ID. Loading or failed icons draw their
declared shape fallback. Icon size is square CSS pixels, and rotation is clockwise
around the feature anchor. `iconTint` multiplies the icon's colors (default white,
no tint), so one monochrome or light asset can serve several colored markers:

```ts
points.setStyle({ icon: 'pin', iconSize: 32, iconTint: '#bd573b' });
points.get('prague')?.setStyle({ iconTint: '#16724c' }); // per-feature override
```

Tint alpha combines with `opacity`. Only the ready sprite is tinted; the shape
fallback of a loading or failed icon keeps its `color`.

Labels default to `properties.name`. Empty text is skipped. Font registration uses
`map.assets.addFont({ id, family, src })`; fallback fonts render while loading.
`\n` splits a label into a vertically centred multi-line block (fixed line
height, no automatic wrapping), with platform shaping and optional collision
suppression: higher priority wins, ties use stable order.
See [labels and pins](tutorials/labels.md).

## Markers

```ts
const pin = map.addMarker({
  position: { lat: 50.08, lng: 14.43 },
  tooltip: 'Depot',
  popup: { content: 'Depot A', autoPan: true },
});
map.addMarkers([
  { position: { lat: 50.09, lng: 14.44 } },
  { position: { lat: 50.1, lng: 14.45 }, icon: 'pin', iconSize: 16 },
]);
pin.setPosition({ lat: 50.081, lng: 14.431 });
pin.openPopup();
```

A marker is a GPU sprite in one shared layer — no DOM element per marker. The
tooltip is a DOM overlay (hover by default, `permanent` supported) and the popup
is one dialog per map: a marker click or `openPopup()` opens it, its button, a
background click or `closePopup()` closes it, and `autoPan` keeps it inside the
container. Strings render as text (UI-06); pass a `Node` for rich content. Pass
`draggable: true` to drag a single pin; the map does not pan while it is dragged.
The handle also exposes `setIcon`, `setDraggable`, `setTooltip`, `setPopup`,
`openTooltip`, `show`, `hide` and `remove`. See
[marker contracts](decisions.md#markers) and the
[markers tutorial](tutorials/markers.md).

## Raster tiles and WMS

```ts
map.addTiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap contributors',
});
map.addControl('attribution');
```

Tiles support XYZ/TMS, retina and parent/child fallback. PNG, JPEG and SVG images
are decoded by the browser and drawn as textures. Display the provider's required
attribution and follow its usage policy.

`addWms(url, options)` supplies layers and service parameters in one step. WMS
version and CRS determine BBOX axis order; EPSG:3857 uses projected meters.
Parameter changes keep the previous bitmap until its replacement loads.

## Vector tiles

```ts
const source = map.data.vectorTiles({ id: 'basemap-data', url: '/tiles/{z}/{x}/{y}.pbf' });
map.addLayer({ id: 'roads', type: 'lines', source, namespace: 'roads',
  style: { color: '#66776d', widthPx: 2 } });
```

MVT sources are viewport-driven and read-only. `namespace` selects a source-layer
name. Loaded fragments share feature identity and state; reloaded records get
new generations. Above the source zoom limit, loaded geometry scales without
deeper requests. Mutable edits belong in a separate overlay source.
See [vector-tile contracts](decisions.md#vector-tiles-mvt).

## Media overlays

`addImage({ url, bounds })` and `addVideo({ url, bounds, loop })` create source-backed
overlays. Bounds use `southwest` and `northeast` object coordinates. `rotate`
(degrees clockwise about the bounds centre, also settable with
`update({ rotate })`) turns the placement; opacity and painter order apply.
Skew and color filters are not supported.

Image sources also accept copied RGBA pixels and `updateRegion()` for partial
updates. Videos expose play/pause; the frame pump stops while paused and releases
resources on removal. Image URLs can change at runtime; video URLs cannot.

## Backend recovery

WebGPU and WebGL 1 consume the same frame plan. Set `renderer: 'webgl1'` for WebGL,
or `{ primary: 'webgpu', fallback: false }` to disallow fallback. A renderer of
`'none'` supports headless data or an explicitly installed custom renderer.

Device/context loss first tries the same backend, then the configured fallback.
The public map, identity, view, selection and bindings remain intact. If both
attempts fail, capabilities report `unavailable` and GPU queries reject rather
than pretending to render. Observe `backend` and `rendererror` events.

`capabilities()`, `stats()` and `debug` inspect the current renderer. GPU submission
counts are not frame-rate guarantees. See [rendering contracts](decisions.md#gpu-backends),
[custom rendering](plugins.md#change-rendering) and [known limitations](status.md#known-limitations).
