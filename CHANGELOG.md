# Changelog

## Unreleased

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
