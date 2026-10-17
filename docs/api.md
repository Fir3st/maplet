# Layers and objects

Organize content in heterogeneous layers, nest other layers, and edit individual
objects through generation-bound handles. Ordinary datasets do not require
separate source/render-pass setup; shared sources remain available when needed.

## Creating and moving a map

```ts
const map = await createMap('map', {
  center: [50.08, 14.44],
  zoom: 8,
  controls: ['zoom', 'scale', 'attribution'],
});
map.setView({ center: [49.2, 16.6], zoom: 10 });
map.setZoom(11);
```

Web Mercator and WebGPU with WebGL 1 fallback are the defaults. `renderer:
'webgl1'` requests WebGL; an options object still supports explicit fallback
policy. `createMap(null, { renderer: 'none' })` creates a DOM-free scene. A real
container can also be supplied with `renderer: 'none'` for a custom renderer.
Creation remains async because GPU acquisition is async; ordinary object edits
are synchronous commits, not fire-and-forget work.

Geographic inputs accept `[lat, lng]` or `{ lat, lng, altitude? }`; the optional
altitude is metadata kept on every vertex — points, line vertices and polygon
ring vertices alike. Planar maps
use `projection: crs.simple()` and `{ x, y }`; tuples are rejected rather than
silently interpreted in a different order. GeoJSON and columnar imports keep
their existing **longitude/latitude** order. Read methods return canonical
object coordinates, not tuples. Pixel style names retain the `Px` suffix so
pixels are not confused with metric geometry.

## Layers form a tree

```ts
map.addPoints([{ position: [50.08, 14.44] }]); // belongs to map.base
map.addLines([
  {
    positions: [
      [50.08, 14.44],
      [49.2, 16.6],
    ],
  },
]); // same base

const places = map.addLayer({ id: 'places' });
const stations = places.addPoints([
  { id: 'prague', position: [50.08, 14.44], properties: { name: 'Prague' } },
]);
places.addLabels(stations.source);

const routes = places.addLayer({ id: 'routes' });
routes.addLines([
  {
    positions: [
      [50.08, 14.44],
      [49.2, 16.6],
    ],
  },
]);
routes.addPolygons([
  {
    rings: [
      [
        [50, 14],
        [51, 14],
        [50, 15],
      ],
    ],
  },
]);

places.hide(); // stations, labels, routes and all nested content
places.show();
places.remove(); // the complete current subtree
```

Every logical layer exposes the same construction methods: `addPoints`,
`addLines`, `addPolygons`, `addLabels`, raster/media helpers and `addLayer`.
It can mix all kinds of content and nest other layers. `map.addLayer()` creates
a root layer; `places.addLayer()` creates a child of `places`.

Ordinary `map.addPoints/addLines/...` calls add collections to **one shared base
layer**, not new root layers. `map.base` is lazy, has the reserved id `base` and
initially sits below explicit root layers, even if those were created earlier.
It can be hidden, reordered or removed like a layer, but cannot leave the map
root. Removing it invalidates its old handles; the next direct map addition
creates a fresh base layer.

`addPoints()` returns a typed **object collection** within the receiver. Each
call retains its own style, source and mutable collection handle; it does not
silently merge unrelated datasets or create one handle per feature. The same
distinction applies to lines, polygons, labels and raster/media collections.
Styles and filters belong to those typed collections or individual objects:
a heterogeneous layer has no ambiguous single-geometry `setStyle()`.

`map.layers.get(id)` discovers any entry by its map-local id. `map.layers.list()`
returns root entries in painter order; `layer.layers.get/list` discovers its
direct children. `list({ recursive: true })` lists the full subtree depth-first.
Entries discriminate on `kind`: `layer` is a container, while `points`, `lines`,
`fills`, `labels` and `raster` identify styled collections/render passes.
`parentId` tracks the current parent (`null` at the root).

`move({ before/after: id })` uses the anchor's parent; `move({ index })` reorders
within the current siblings. `move({ into: layerId, index? })` reparents an entry,
and `{ into: null }` moves it to the map root. Cycles are rejected without
changing the tree. Visibility is the entry's flag AND every ancestor flag;
showing a parent does not reset independently hidden children. Layer controls
show root entries in that same order, not internal geometry collections.

Container and collection options accept `label`, a human-readable name that the
layer control shows instead of the id; `label` is also settable through
`layer.update`. See [multiple map views](maps.md#multiple-map-views) for hosting
several maps next to each other.

## Collections and objects

```ts
const places = map.addLayer({ id: 'stations' });
const stations = places.addPoints(
  [{ id: 'prague', position: [50.08, 14.44], properties: { status: 'online' } }],
  { draggable: true, style: { radiusPx: 9, color: '#16a34a' } },
);

const prague = stations.get('prague'); // undefined if the id does not exist
if (prague) {
  prague.setPosition([50.1, 14.5]);
  prague.setProperties({ status: 'offline' });
  prague.setStyle({ color: '#dc2626' });
  prague.hide(); // keeps data, identity and style; show() restores visibility
}

const added = stations.add({ position: [49.2, 16.6] }); // automatic id
added.on('click', (event) => console.log(event.feature.id));
places.addLabels(stations.source); // shares the same features; defaults to name
```

`addLines([{ positions: [...] }])` and `addPolygons([{ rings: [...] }])` follow
the same pattern. Their objects expose `setPositions()` and `setRings()`.
Polygon rings are outer ring first, then holes. `addTiles(url, options)`,
`addWms(url, options)`, `addImage(options)` and `addVideo(options)` create both
the source and display layer and return a layer with `.source` access. A WMS
endpoint can be inspected before it is added:

```ts
const capabilities = await map.data.wmsCapabilities('https://example/ows');
// { version, title, crs, formats, bounds, layers, preferred? }
map.addWms('https://example/ows', { id: 'service', layers: 'roads', ...capabilities.preferred });
```

`wmsCapabilities()` returns the parsed GetCapabilities answer; `preferred`
carries the version, CRS and format the endpoint supports (absent when it
declares no CRS this library can request). An unsupported CRS fails with
`invalid-argument`.

Layer, collection and feature ids are optional. Layer/collection ids are map-local
and generated without collisions with existing entries or sources; `base` is
reserved for the default layer. Feature ids retain
the numeric/string distinction and source-local `auto:<n>` generation.
Source ids and collection/render-pass ids are separate identities, not duplicated setup.

`get()` creates a small handle only when requested; it does not retain a handle
or listener per feature. A feature handle's `.ref` is a stable generation-bound
reference usable in selection, relations, details and bindings. Removing and
recreating the same id does **not** revive the old handle; writes fail with
`stale-reference`. Removing its layer/source makes the handle unusable.
Transparent proxies and detached methods remain supported. `.get()` returns a
readonly snapshot with copied geometry and top-level properties. Nested property
values are shared and must be treated as immutable; use the write methods to edit.

`addMany()` performs one bulk commit and returns references, not an eagerly
allocated handle array. `setData()` atomically replaces **source data**, retaining
identities that remain. It returns a Promise/commit; validation failure leaves
the previous data unchanged. A shared source edit is visible in all its layers.
`count()` and `getBounds()` describe source data, not current screen visibility.
`updateFeature(id, patch)` provides explicit canonical-geometry editing when
needed. Collection `setStyle()` replaces its base style; object `setStyle()` patches
that object's collection-local override. `clearStyle()` restores the collection style.

## Styling and events

```ts
import { style } from '@fir3st/maplet';
const colors = style.by('status', { online: '#16a34a', offline: '#dc2626' }, '#6b7280');
stations.setStyle({ radiusPx: 9, color: colors });
stations.on('click', (event) => console.log(event.feature.id, event.position));
stations.once('dragend', (event) => console.log(event.position));
```

`style.by(property, cases, fallback)` handles the common property mapping without
nested expressions. Dotted fields work; missing, null and unmapped values use
the explicit fallback. The full declarative expression system is retained under
`style.field`, `style.when`, `style.state`, `style.interpolate`, etc.; these are
not callbacks evaluated over the entire dataset every animation frame.

Layers, collections and objects accept `click`, `mouseover`, `mouseout`, `mousemove`,
`dragstart`, `drag` and `dragend` directly. `on()`/`once()` return an idempotent
unsubscribe function and accept `{ signal }`. `once()` waits for the requested
event, not the first event of another type. Events bubble from the object/collection
through each logical parent to the map, preserving `stopPropagation()`.
`event.layerId` identifies the styled collection/render pass that was hit.
`map.on('click', ...)` includes background clicks:
`event.feature` is `null` for background, a reference for a feature hit.
`onFeature(fn)` is an advanced aggregate stream of feature interactions only.
Map view/backend/commit events remain available with `on`/`once`/`off`.
Object-scoped subscriptions are released when their feature or collection is removed,
including removal through shared data. For dense datasets, prefer one layer
listener rather than registering an individual listener for every row.

## Shared data, transactions and cleanup

```ts
const data = map.data.vector<PointGeometry, StationProperties>({ id: 'stations' });
await data.importColumnar(batch); // original worker/copy/move/cancellation path
const stations = map.addPoints(data, { draggable: true });
map.addLabels(data);
map.batch(() => {
  stations.get('a')!.setPosition([50, 14]);
  stations.get('b')!.setPosition([51, 15]);
});
await map.whenRendered();
```

Explicit `map.data` sources are caller-owned: layer removal does not delete them.
Sources created from inline layer data are released when their last display
layer is removed, unless relations/bindings still use them. Such graph-owned data
remains accessible through `.source` or `map.data`; remove graph dependencies and
then remove it explicitly. Removing a layer never cascades into unrelated layers
or graph dependencies. Logical layer removal removes its current descendants and
follows the same ownership rule. Moved-out children survive their former parent's
removal. Map destruction releases all resources and plugins.

The existing atomic write, ownership, rollback, import, renderer recovery and
render-fence contracts still apply. A source from another map is rejected even
if an identically named local source exists. `map.addLayer({ type, source, ... })`
is the explicit advanced path for rendering shared sources and read-only MVT
namespaces; it returns a typed render-pass handle, not a heterogeneous container.
`places.addLayer({ type, source, ... })` attaches that pass to `places`; the map
form creates an explicit root pass. Mutable object operations are not invented
for tiles. Public layer registries discover, move and remove entries; construction
uses the receiver's methods. The separate `map.groups` API has been removed.

Controls are opt-in through initial `controls` or `map.addControl('zoom')` (a full
control descriptor works too). `map.controls.get/list/remove` are non-nullable;
headless maps list no controls and reject DOM operations with
`unsupported-capability`, rather than silently pretending to add a control.
Plugins and render callbacks receive the **new public map**, not the old engine.

## Migration table

The alpha.4 redesign replaces the previous facade without compatibility aliases,
including the separate groups API and root `expr` export.

| Before                                                | Now                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `createMap({ container, view: { center, zoom } })`    | `createMap(container, { center, zoom })`                                  |
| `map.view.set/get/fit/...`                            | `map.setView/getView/fitBounds/...`                                       |
| `sources.rasterTiles` + `layers.add`                  | `map.addTiles(url, options)`                                              |
| vector source + point layer for ordinary data         | `map.addPoints([{ position, properties }], options)`                      |
| `source.features.update(id, { geometry: ... })`       | `points.get(id)?.setPosition(...)`                                        |
| `layer.features.setOverride/clearOverride`            | `layer.setFeatureStyle/clearFeatureStyle` or object `setStyle/clearStyle` |
| `map.layers.update(id, patch)`                        | `collection.update(patch)` (narrow a registry entry by `kind` first)      |
| `interaction: { enabled, draggable }` on a layer      | `interactive, draggable` directly on collection options                   |
| `layer.getVisible()`                                  | `layer.isVisible()` (or `show`/`hide`)                                    |
| `on('feature', e => { if (e.type === 'click') ... })` | `on('click', ...)` on the relevant layer/object                           |
| `expr.match(expr.field('status'), cases, fallback)`   | `style.by('status', cases, fallback)`                                     |
| `map.controls.add({ kind: 'zoom' })`                  | `map.addControl('zoom')`                                                  |
| explicit advanced `map.sources`                       | `map.data`                                                                |
| `map.groups.add({ id })`                              | `map.addLayer({ id })`                                                    |
| `map.groups.add({ parent })`                          | `parentLayer.addLayer()`                                                  |
| layer option `group: id`                              | create through the receiving layer, or `parent: id`                       |
| each `map.addPoints()` creates a root layer           | each call creates a collection inside `map.base`                          |

Historical benchmark reports describe their original API revisions; they are not
rewritten as evidence for this API change.
