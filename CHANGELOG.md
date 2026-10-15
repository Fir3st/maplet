# Changelog

## Unreleased

- Add the built-in `gestureGuard` plugin: touch gestures need two fingers,
  mouse/pen gestures need a modifier (default Alt), one-finger drags scroll the
  page instead of panning, a hint overlay explains blocked attempts, and
  `unlock()`/`lock()` override the gate from application UI. The interaction
  layer gains the public `setGestureGate()` hook behind it (INPUT-09).
- Add the built-in `fullscreenMode` plugin: a Fullscreen API toggle with state
  sync (including browser-initiated exits), an optional corner button, boolean
  results instead of throwing, a CSS viewport fallback reported as
  `mode: 'fallback'` when the API is denied, and cleanup that exits fullscreen.

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
