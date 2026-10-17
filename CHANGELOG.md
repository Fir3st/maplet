# Changelog

## 0.1.0-alpha.15

- Serve WMS as tiles (WMS-06..WMS-11). A WMS source requests one GetMap per
  256 px tile of the standard grid, the tile's own geographic extent at the
  declared CRS - so ancestor stand-ins, the tile cache, the re-request only when
  the integer zoom level changes and picking behave like any tile basemap, and a
  pan asks only for the tiles that entered the view. An undecoded tile is
  substituted by up to two coarser ancestors or by decoded children, never by a
  deeply magnified older view. `map.data.wmsCapabilities(url)` fetches and parses
  a GetCapabilities answer - 1.3.0 or 1.1.1, including namespace prefixes, CDATA
  and a DOCTYPE that is never processed - and returns the service title, the
  declared CRS list (URN and OGC URL forms normalized), the GetMap formats, the
  extent and the nested layer tree with inherited queryable flags, plus a
  `preferred` request the endpoint supports (CRS:84, then EPSG:4326, then
  EPSG:3857; `image/png` when declared). GetMap requests accept exactly those
  three CRS; anything else - a national grid, for example - is refused with
  `invalid-argument` instead of being sent with degree coordinates. Adds the
  `wms-endpoint` tutorial, which discovers IPR Praha's "Základní mapa" service
  behind a Czech INSPIRE record and requests only the layers you switch on.

## 0.1.0-alpha.14

- Add runtime URL changes on video sources (MEDIA-09). `video.update({ url })`
  enters the loading lifecycle: the descriptor revision bumps without touching
  the uploaded pixels, the last decoded frame stays on screen until the new
  source decodes, the requested playback state survives (a playing video
  resumes by itself, a `pause()` during the load keeps it paused), and a failed
  load reports `error` while the previous frame stays. Load listeners and frame
  callbacks belong to exactly one load, so an aborted load can never fail or
  repaint over its successor; both backends keep the previous texture while the
  video element has no decodable frame. Adds the deterministic
  `green-yellow.mp4` fixture and grows the media battery.

- Add a map switcher and labelled layer controls (UI-10).
  `createMapSwitcher({ container, maps })` hosts several independent maps in
  one container with accessible tabs: the initial map is created during the
  call, every other map on its first activation, switching only changes which
  panel is visible (so pan, zoom, layer visibility, selection and
  subscriptions survive), inactive panels stay laid out for correct lazy
  sizing, `show`/`get`/`activeId`/`onChange` drive the active view and
  `destroy()` releases every created map. Root layers and collections accept a
  `label` that the built-in layers control shows instead of the id. Adds the
  `views` tutorial with a network overview and a city detail, each with its own
  labelled layers control.

## 0.1.0-alpha.13

- Preserve line and polygon altitudes. The public normalization kernel, the
  binary worker kernel and `exportGeoJson` share one per-vertex altitude column
  (`NaN` = absent): GeoJSON, object and columnar imports keep the third
  coordinate on every line, multi-line, polygon and multi-polygon vertex, and
  `features.get()` and `exportGeoJson()` return it — a vertex without one
  exports two coordinates. Collapsing consecutive duplicate positions keeps the
  first vertex's altitude, an auto-closed ring repeats the first vertex's
  altitude, and a winding flip reverses the altitude column together with its
  ring. The prepared-parts worker trust boundary validates the column length and
  transfers the altitude buffer instead of cloning it; a geometry whose
  vertices carry no altitude stores no column. Adds the `elevation`
  tutorial/example, whose profile is drawn from `exportGeoJson()`.

## 0.1.0-alpha.12

- Add keyboard focus on pins (MARKER-15). One hidden focus stop inside the map
  is reached with Tab (and left with Tab); arrow keys and Home/End walk a ring
  cursor over the drawn pins in layer order, Enter or Space activates the
  focused pin exactly like a click through a new engine `dispatchFeature` seam
  (popups open, badges zoom their members apart, and `click` listeners see the
  KeyboardEvent as `originalEvent`), and Escape closes the popup before leaving
  the cursor back on the container. An open cursor announces `<name>, 2 of 12`
  through a polite live region, where the name is the new `MarkerOptions.alt`,
  then the tooltip text, then `Pin` (`N pins` on a badge). The arrow keys are
  consumed before the container's pan handler (`interaction.keyboard` keeps its
  own pan and zoom keys), and `MarkerOptions.keyboard: false` keeps a pin out of
  the cycle. The ring follows the focused pin and parks off-view; only pins
  inside the container are reachable, and a cluster badge is visited in the
  place of its first reachable member, so the cycle keeps the layer's order.

## 0.1.0-alpha.11

- Add marker clustering: `map.setMarkerClustering({ radiusPx, minCount,
  disableAtZoom })` replaces pins whose screen distance is within the radius with
  one count badge, and `getMarkerClustering()` reports the options with defaults
  applied (`null` shows every pin again). Grouping is resolved in screen space at
  the current zoom, so panning never re-clusters while a zoom or a pin change
  re-resolves. A badge carries the count in three size tiers (exact to 999, then
  `1.2k`), hovers a `N pins` tooltip and fits the member bounds on click so the
  pins separate. `cluster: false` keeps a pin individual, a grouped pin's
  permanent tooltip and open popup park and return with it, and a dragged pin
  joins or leaves a group at `dragend`.
- Fix pin visibility ownership: `handle.hide()` now survives later `setIcon` or
  `setDraggable` edits (the appearance rebuild used to clear it), and pins
  grouped in an earlier pass are revealed when clustering stops or
  `disableAtZoom` is reached.
- Add the "Cluster nearby pins" tutorial with a live example, bringing the
  documentation to seventeen tutorials. The Gist payload cap was raised
  deliberately from 1 MiB to 1.25 MiB because every tutorial carries its own
  copy of the shared files; the build now reports the measured size when it
  exceeds the cap.

## 0.1.0-alpha.10

- Fix permanent tooltip and popup tracking: both used to be clamped
  horizontally like a hover tooltip, so panning the map slid a permanent
  tooltip along the container edge away from its pin (a measured offset grew
  from 76 px to 116 px) and then left it on screen after the pin had gone. A
  permanent tooltip and a popup now sit exactly above their anchor — the arrow
  keeps pointing at the icon — a hover tooltip keeps its clamp so its text
  stays readable at an edge, and an overlay whose anchor leaves the container
  is parked with `visibility: hidden` until the pin returns.
- The markers example now advertises its draggable pin: the dock crane carries
  a permanent "drag me" tooltip instead of a hover one, so the gesture is
  visible without hovering, and both it and the depot sit clear of the
  container edges where a label would be clipped.

## 0.1.0-alpha.9

- Marker dragging: `map.addMarker({ draggable: true })` makes a pin follow the
  pointer without panning the map. The drag starts after four CSS pixels, emits
  `dragstart`/`drag`/`dragend` like any feature, keeps a press without movement
  a click, and `handle.setDraggable(false)` turns it off at runtime.
- Per-feature dragging override: `setStyle({ draggable: true | false })` (and
  `draggable` inside a `FeatureOverride`) opts a single feature in or out of a
  layer that is draggable with `interaction.draggable`, which is how one pin
  drags inside the shared marker layer.

## 0.1.0-alpha.8

- Redraw the built-in marker pin (MARKER-01): a slimmer flat teardrop with a
  white rim and an inner dot, so pins stay legible on a busy basemap and
  overlapping pins keep their edges. The marker layer also stops inheriting the
  data-layer style default `minZoom: 0`, so a pin stays visible at the negative
  zooms planar maps can use.
- Rename the fullscreen plugin module file to `dist/plugins/display-mode.js`.
  Some content filters and security suites block script URLs ending in
  `fullscreen.js`, which took every page loading the library down for those
  browsers; the exported `fullscreenMode` plugin and its API are unchanged.
- Add four real-world recipe tutorials to the documentation — a city guide,
  vehicle tracking, a filterable field explorer and a measuring tool — shown on
  live OpenStreetMap tiles with attribution, no prefetching and an offline
  fallback.

## 0.1.0-alpha.7

- Add the built-in `gestureGuard` plugin: touch gestures need two fingers,
  mouse/pen gestures need a modifier (default Alt), one-finger drags scroll the
  page instead of panning, a hint overlay explains blocked attempts, and
  `unlock()`/`lock()` override the gate from application UI. The interaction
  layer gains the public `setGestureGate()` hook behind it (INPUT-09).
- Add the built-in `fullscreenMode` plugin: a Fullscreen API toggle with state
  sync (including browser-initiated exits), an optional corner button, boolean
  results instead of throwing, a CSS viewport fallback reported as
  `mode: 'fallback'` when the API is denied, and cleanup that exits fullscreen.
- Add the built-in `heatmap` plugin (HEAT-10): weighted points render as a heat
  field on one overlay canvas through the after-frame hook, defined with
  `setPoints`/`addPoint`/`addPoints`/`clear` and tuned with `setOptions` (radius,
  blur, intensity peak, opacity bounds, gradient, `zIndex`) over a bounded
  per-frame field buffer.

## 0.1.0-alpha.6

- Add `map.addMarker(options)` / `map.addMarkers(options[])`: Leaflet-style pins
  drawn as GPU sprites with hover/permanent tooltips and one click popup per map
  (close button, background click, `autoPan`), custom icon assets, per-marker
  size/anchor/tint overrides, feature events and removal. Content strings stay
  text (UI-06); pass a `Node` for rich content.
- Add media placement rotation: `rotate` (degrees clockwise about the bounds
  centre) on image/video sources and through `update({ rotate })`. It is a
  descriptor change that rebuilds the plan without re-uploading pixels; picking
  and culling follow the turned quad.
- Add multi-line labels: a `\n` in the label text splits it into a vertically
  centred block with a fixed line height and no automatic wrapping. Single-line
  labels rasterize exactly as before; collision, rotation and picking use the
  whole block.
- Add `iconTint` for point icons: an RGBA multiplier over the icon texture
  (default white), available as a layer style expression and a per-feature
  override. Only the ready sprite is tinted; per-feature tint edits patch their
  quads without an atlas or layout rebuild.
- Replace the example gallery with a documentation website: overview, installation,
  thematic guides, declaration-generated API reference and nine tutorials with
  embedded live examples. Preserve existing example URLs and standalone Gist output.
- Reduce README to a package overview, installation and a short start; move project,
  development and architecture details into documentation.

## 0.1.0-alpha.5

- Fix the public `version` export to match the package version, and test it
  against the manifest to prevent release drift.

## 0.1.0-alpha.4

- **Breaking:** replace the source-first map facade with `createMap(container,
  options)`, direct map view methods, `addPoints`/`addLines`/`addPolygons` and
  one-step raster/media layers. Add lazy generation-bound objects, direct feature
  events, `style.by`, optional ids and initial control lists. Preserve advanced
  shared data/imports under `map.data`, rendering, transactions and bindings.
  Layers are heterogeneous recursive containers; direct map object helpers share
  a lazy base layer, replacing the separate groups API. Subtree visibility,
  ordering, event bubbling and cleanup use the same engine tree.
  Migrate demos and learning examples; see [migration guide](docs/api.md).
- Add a focused eight-example learning collection with a searchable directory,
  live maps, source code and GitHub Pages / public Gist publication workflow.

## 0.1.0-alpha.3

- Publish `@fir3st/maplet` to the GitHub Packages npm registry on version changes,
  using the same tested archive as the GitHub Release. Prereleases use the `next`
  dist-tag, stable versions use `latest`. Update consumer imports to the scoped name.

## 0.1.0-alpha.2

- Add automated builds and version-triggered GitHub Releases with installable
  package archives. Pin the TypeScript compiler and fix test discovery in Node.js 22 CI.
- Add plain-function plugins via `map.use()` and initial `plugins`, with typed
  APIs, DOM access, cancellation and reverse-order cleanup. Add shared render-plan
  transforms, after-frame drawing and removable custom renderers with picking.
- License original Maplet material under Apache-2.0, preserving third-party
  license terms and attribution.
- Add an opt-in, reproducible 500,000-point Leaflet comparison with recorded
  setup/pan results and pixel-verified single-point visibility, color and
  position updates. Document limitations without claiming a general GPU speedup.

## 0.1.0-alpha.1

Initial alpha of an independent GPU mapping library inspired by Leaflet, with
WebGPU rendering and a configurable WebGL 1 fallback. No runtime dependency on
Leaflet.

### Core

- Map creation, view management, pan/zoom/pinch and keyboard navigation.
- Feature events bubbling through layers, groups and the map, with `stopPropagation()`.
- Vector sources for points, lines, polygon fills with holes, metric circles,
  rectangles and multi-geometries; stable identities and generation-aware references.
- Point, line, fill, label and raster layers, image sprites, expression-based
  styles, feature overrides and interaction state.
- Relations, computed bindings, dependency-cycle validation, field ownership,
  atomic batches, rollback, snapshots and logical/rendered revisions.
- Shared frame planning across WebGPU and WebGL 1, measured picking stalls,
  device/context-loss recovery and CPU instance expansion when needed.

### Data and media

- XYZ/TMS/WMS raster loading, caching, parent/child fallback and retention of
  previous bitmaps while replacement data loads.
- Dependency-free MVT decoding, source-layer namespaces, identities shared
  across fragments, overzooming and attribution.
- GeoJSON and columnar imports with worker preparation, explicit copy/move
  semantics, cancellation, bounded queues and an inline fallback.
- GPU-rendered text, priority-based collisions, LRU atlas eviction, registered
  fonts, platform shaping and bidi directions.
- Image/video overlays, partial image updates, shared-texture sprites and
  rotation around declared anchors.

### UI

- Optional zoom, layer, attribution, scale and accessible list controls.
- Typed geolocation and generation-bound HTML feature details.
- Overlay hit testing and isolation from map gestures.

### Known alpha limitations

See [implementation status](docs/status.md). Reference-hardware benchmarks and
a custom glyph shaper are not included; timings from the 500,000-point example
describe the development machine, not a general performance guarantee.
