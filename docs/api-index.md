# API reference

This reference follows the public package declarations. Signatures and member
tables are generated from the built version, including inherited methods and
overloads. Guides explain behavior; reference pages provide the exact types.

## Map

`await createMap(container, options)` returns a `MapHandle`. Pass an element,
its ID, or `null` with `renderer: 'none'` for a headless scene.

| Option | Default | Meaning |
| --- | --- | --- |
| `projection` | Web Mercator | Coordinate reference system |
| `renderer` | WebGPU → WebGL 1 | Built-in backend or explicit fallback policy |
| `controls` | `[]` | Optional HTML controls |
| `center` | Geographic `{ lat: 0, lng: 0 }` or planar `{ x: 0, y: 0 }` | Initial position |
| `zoom` | `2` | Initial scale, inside configured zoom limits |
| `minZoom`, `maxZoom` | `0`, `24` | Allowed view zoom range |
| `maxBounds` | `null` | Optional view bounds limit |
| `size` | `800 × 600` | Initial size; a sized DOM container takes precedence |
| `clock` | `defaultClock()` | Animation clock |
| `interactive` | `true` for DOM maps | Pointer, wheel and keyboard interaction |
| `interaction` | Per-gesture defaults | Gesture settings, including opt-in box selection |
| `plugins` | `[]` | Synchronous setup functions installed in order |

Gesture options `pan`, `wheelZoom`, `doubleClickZoom`, `pinchZoom`, `hover`,
`dragFeatures` and `keyboard` default to `true`; `boxSelection` defaults to `false`.

View: `getView`, `setView`, `getCenter`, `setCenter`, `getZoom`, `setZoom`,
`getBounds`, `fitBounds`, `flyTo`, `stop`, `zoomAround`, `resize`, `size`,
`positionToScreen`, `screenToPosition`.

Lifecycle: `batch`, `whenRendered`, `on`, `once`, `off`, `onFeature`,
`capabilities`, `stats`, `destroy`, `destroyed`.

## Layers and collections

`addLayer(options)` creates a heterogeneous container. The map and every container
expose `addPoints`, `addLines`, `addPolygons`, `addLabels`, `addTiles`, `addWms`,
`addImage`, `addVideo` and nested `addLayer`. Direct map additions share `map.base`.

| Handle | Main operations |
| --- | --- |
| Logical layer | `layers`, `show`, `hide`, `isVisible`, `setVisible`, `move`, `remove`, events |
| Styled collection | Layer operations plus `setStyle`, `setFilter`, `update`, per-feature style overrides |
| Vector collection | `source`, `get`, `add`, `addMany`, `updateFeature`, `setData`, `count`, `getBounds` |
| Object | `ref`, `get`, `setGeometry`, `setProperties`, `setStyle`, `clearStyle`, `show`, `hide`, `select`, `deselect`, `remove` |
| Point | `getPosition`, `setPosition` |
| Line | `setPositions` |
| Polygon | `setRings` |

Collection options are optional `id`, `visible`, `style`, `filter`, `namespace`,
`interactive`, `draggable` and `parent`. Containers use only `id`, `visible` and
`parent`; they have no single geometry style.

`layers.get(id)` searches descendants at map scope and direct children at layer
scope. `list()` uses painter order; `{ recursive: true }` includes descendants.
Moves accept `{ before }`, `{ after }`, `{ index }` or `{ into, index? }`; `into: null`
moves to root. See [layer and lifetime contracts](api.md).

## Data and services

| Property | Purpose |
| --- | --- |
| `data` | Explicit vector, raster, WMS, MVT, image and video sources |
| `assets` | Reusable image and font registration |
| `relations` | Connections, neighbors and bounded traversal |
| `bindings` | Derived geometry/properties and ownership |
| `state`, `selection` | Shared interaction state and selected references |
| `query` | Data queries and rendered picking |
| `controls`, `detail`, `locate` | HTML controls, feature details and geolocation |
| `render` | Plan transforms, frame hooks and custom renderers |
| `interaction`, `debug` | Gesture options and read-only diagnostics |

Explicit sources survive layer removal. Inline sources follow last-use ownership.
See [data and transactions](data.md), [interaction](interaction.md) and [plugins](plugins.md).

## Styles

Point, line, fill, label and raster style types define their supported fields.
`style.by`, `field`, `state`, `zoom`, `when`, `match` and interpolation helpers
build declarative expressions. Object overrides affect one render pass only.
See [styles and rendering](rendering.md).

## Events and errors

Feature events: `click`, `mouseover`, `mouseout`, `mousemove`, `dragstart`, `drag`,
`dragend`. They bubble through actual layer ancestors. Map clicks discriminate
between feature references and `feature: null` background clicks.

`on`/`once` return unsubscribe functions, with optional AbortSignal cancellation.
`MapletError` exposes a typed code; use `isMapletError(error)` to narrow it.
Validation, stale references, ownership, dependency conflicts and unavailable
capabilities reject explicitly. See [contracts](decisions.md) for rollback and recovery.

## Package exports

The root exports map/object types, style helpers, coordinate helpers, formats,
errors and advanced render hooks. `@fir3st/maplet/math` exposes pure coordinate,
bounds and geometry utilities; `@fir3st/maplet/formats` exposes GeoJSON helpers.
Importing modules does not initialize the DOM or GPU.

The following sections list every exported symbol from those entry points, plus
the option and service types reachable through public handles.
