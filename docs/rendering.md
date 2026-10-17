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
tooltip is a DOM overlay (hover by default, `permanent` supported, tracking its
pin exactly) and the popup
is one dialog per map: a marker click or `openPopup()` opens it, its button, a
background click or `closePopup()` closes it, and `autoPan` keeps it inside the
container. Strings render as text (UI-06); pass a `Node` for rich content. Pass
`draggable: true` to drag a single pin; the map does not pan while it is dragged.
The handle also exposes `setIcon`, `setDraggable`, `setTooltip`, `setPopup`,
`openTooltip`, `show`, `hide` and `remove`.

`setMarkerClustering(options)` groups pins whose screen distance is within
`radiusPx` (default 64) into one count badge; `null` shows every pin again.
A badge is an internal sprite (reserved `maplet-cluster:` id prefix) that hovers
a `N pins` tooltip and fits the member bounds on click, so the pins separate.
Keyboard users reach the pins through one hidden focus stop inside the
container: Tab enters it, arrows move a ring cursor (announced through a polite
live region), Enter activates the focused pin like a click, and Escape closes
the popup then leaves the cursor.
See [marker contracts](decisions.md#markers), the
[markers tutorial](tutorials/markers.md) and the
[clustering tutorial](tutorials/clusters.md).

## Raster tiles and WMS

```ts
map.addTiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
});
map.addControl('attribution');
```

Tiles support XYZ/TMS, retina and parent/child fallback. PNG, JPEG and SVG images
are decoded by the browser and drawn as textures. Display the provider's required
attribution and follow its usage policy.

`addWms(url, options)` supplies layers and service parameters in one step.
Every GetMap request is one 256 px tile of the standard grid, so ancestor
stand-ins, caching and picking work like any tile layer; WMS version and CRS
determine BBOX axis order and EPSG:3857 uses projected meters. Parameter
changes keep the previous tiles until their replacements load. Only
`CRS:84`, `EPSG:4326` and `EPSG:3857` can be requested; any other CRS fails
instead of sending degree coordinates to a projected service.

```ts
const capabilities = await map.data.wmsCapabilities('https://example/ows');
map.addWms('https://example/ows', {
  id: 'service',
  layers: 'roads,buildings',
  ...capabilities.preferred, // { version, crs, format } the endpoint supports
  attribution: '© the provider',
});
```

`wmsCapabilities(url)` reads the service's GetCapabilities answer (1.3.0 or
1.1.1): the layer tree with titles and queryable flags, every declared CRS,
GetMap formats and the service extent. `preferred` is absent when the endpoint
declares no requestable CRS. See [Discover a WMS endpoint](tutorials/wms-endpoint.md).

## Vector tiles

```ts
const source = map.data.vectorTiles({ id: 'basemap-data', url: '/tiles/{z}/{x}/{y}.pbf' });
map.addLayer({
  id: 'roads',
  type: 'lines',
  source,
  namespace: 'roads',
  style: { color: '#66776d', widthPx: 2 },
});
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
resources on removal. Image and video URLs can change at runtime: a video
reloads its element, a requested playback resumes when the new source is ready,
and the last decoded frame stays on screen until then (a failed load reports
`error` and keeps it).

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
