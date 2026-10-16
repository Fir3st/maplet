# Changelog

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
