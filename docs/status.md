# Implementation status

Maplet is an alpha library (`0.1.0-alpha.1`). This document describes the
implementation, reproducible checks and known gaps. It replaces the internal
development log; no external planning documents or saved screenshots are needed
to use this repository.

## Implemented scope

| Area | Implementation and checks |
| --- | --- |
| Coordinates and view | Web Mercator, EPSG:4326, ellipsoidal Mercator, Simple/custom CRS, bounds, fit/flyTo, limits; math/view tests and a vendored Leaflet 1.9.4 oracle |
| Data | Stable identities/generations, CRUD, transactions/rollback, snapshots, state, selection, queries, GeoJSON and columnar imports; `test/scene/`, `test/io/` |
| Layers and styles | Groups, ordering, filters, overrides, expressions, points, lines and polygon holes; scene/render tests |
| Relations and bindings | Endpoint policies, traversal, dependency DAGs, field ownership, `lineBetween`, `anchorOnLine`, `copyProperty`; relation and data tests |
| Rendering | WebGPU and WebGL 1, CPU expansion without instancing, shared frame plan, pixel/pick parity and loss recovery; `demo/parity.html`, `demo/loss.html` |
| Raster | XYZ/TMS/retina, decoded parent/child fallback, previous-bitmap retention, WMS axis/CRS semantics; raster tests, `demo/tiles.html`, `demo/wms.html` |
| MVT | Decoder, source-layer namespaces, exact large IDs, fragments, unload/reload, overzoom and attribution; vector-tile tests, `demo/mvt.html` |
| Interaction | Pan, zoom, hover/click/drag, pinch, keyboard, selection, bubbling; `demo/interaction.html` and real-input E2E scenarios |
| Picking | Shape-aware GPU queries, revision/generation checks, measured blocking/async readback; `demo/pick.html` |
| Text and fonts | Labels, collisions, rotation, atlas eviction, font loading/fallback, platform shaping, bidi; `demo/labels.html`, `demo/fonts.html` |
| Media | Sprites, anchor rotation, image/video bounds, partial uploads and cleanup; `demo/icons.html`, `demo/media.html` |
| HTML UI | Optional controls, scale, attribution, geolocation, feature detail and bounded accessible lists; `test/ui/`, `demo/ui.html`, `demo/detail.html` |
| Worker imports | Validation, copy/move, cancellation, bounded queue, crash/CSP fallback; import tests, `demo/import.html`, `demo/csp.html?csp=worker-none` |
| Distribution | ESM/declaration/subpath/worker assets, archive audit and consumer types; `test/publish/`, `type-tests/` |
| Lifecycle and scale | Repeated create/destroy, GC-stabilized memory checks, cancellation and 500,000-point example; `demo/soak.html`, `demo/scale.html` |

## Recorded validation

The development record from October 10–11, 2026 reports **189 passing unit tests**
and **34 passing E2E scenarios/batteries** on each of WebGL 1, WebGPU and the
forced basic WebGL 1 profile. These are historical results, not a guarantee
about a different checkout, browser or machine. Run the commands below for
current results.

The recorded browser environment was headless Chromium on an Apple M5 Pro,
using ANGLE Metal for WebGL and `apple metal-3` for WebGPU. Pixel comparisons
against decoded source bitmaps and between backends found zero differences at
the sampled positions. This does not establish universal cross-device pixel
identity, especially for platform-rendered text.

The real-input E2E scenarios check public API state **and rendered pixels**:
point dragging follows the pointer at each step, linked geometry updates, pan
and zoom preserve their coordinate contracts, UI controls receive real input,
and geometry changes appear at their new positions. Synthetic pinch tests do
not replace validation on a physical touch device.

The 500,000-point example recorded roughly 1.2–1.3 s for worker import and
155/244/352 ms for the first render on WebGL 1/WebGPU/basic WebGL 1. These are
development-machine observations, **not reference benchmarks or performance
guarantees**. The demo HUD measures the current run.

A fresh three-run-per-backend check on October 11, 2026 recorded imports of
1,200–1,302 ms (WebGL 1) and 1,207–1,376 ms (WebGPU), with 258,420 visible
instances and one draw call. Its short headless pan check recorded approximately
one-second intervals, not smooth interactive frame rates. See the
[README measurement table](../README.md#measured-scale-not-just-architectural-claims)
for workload, memory observations, timing definitions and limitations. These
current observations should not be confused with the earlier development record.

The subsequent [matched Leaflet comparison](benchmarks/README.md) includes
Canvas and HTML-marker variants, longer warmed-up pan measurements, and
pixel-verified visibility/color/position changes. Leaflet Canvas was faster
than the current Maplet alpha for setup, pan and these single-point updates;
Maplet used less main-thread JS heap after GC. Three HTML-marker runs timed out
within the 120-second whole-process budget, so no successful DOM timing is
claimed. All 180 single-point mutation checks passed across the completed
Maplet/Canvas variants. PixiJS was researched, not benchmarked.

## Known limitations

- **Performance:** reference hardware and the reference benchmark suite have
  not been established. Revision/view changes rebuild instance planning data;
  chunk caching and upload budgeting remain future work.
- **Memory:** point positions use columnar storage, but properties and composite
  geometry remain objects. Columnar input does not mean a fully columnar store.
- **Text:** platform Canvas2D supplies shaping and metrics; no custom font
  parser or GSUB/GPOS shaper. Labels are single-line, use bounding-box collision
  without a halo margin, and do not promise identical pixels across browsers/OSes.
- **Media:** overlays are axis-aligned bounds, without rotation/skew or color
  filters. Opacity is supported; custom blending modes are not. Runtime URL
  updates are supported for images, not video.
- **Icons:** no tinting; size is square via `iconSize` or natural size/DPR.
  Shape fallbacks and ordinary point shapes do not rotate. Without browser image
  support, assets report error and use the shape fallback.
- **Altitude:** preserved for points, multiPoints, circles and rectangles, but
  not for line/polygon geometry or its exported coordinates.
- **MVT:** no antimeridian world wrapping. Residency follows the viewport rather
  than a temporal tile cache. One clamped source zoom is requested at a time;
  higher view zooms scale existing geometry. Edits require a mutable overlay.
- **Bindings:** synchronous evaluators are supported; worker-based binding
  modules and their backpressure protocol are not.
- **GPU extensions:** no public custom-render extension or API for deliberate
  backend switching. Automatic device/context-loss recovery is implemented.
- **Picking:** WebGL 1 readback blocks the calling thread, even through an async
  API. WebGPU readback is asynchronous. Stalls are measured, not inferred from
  Promise signatures. Animation/picking concurrency is not fully validated.
- **Portability:** GPU validation covers Chromium, not every browser, GPU or
  physical touch device. Specific bundler integrations have not been tested;
  archive contents and worker/CSP failure behavior are covered.
- **Workers under CSP:** asynchronous worker-load failure rejects the first
  import with `worker-failed` and permanently switches subsequent work to inline
  preparation. A broken bundler worker URL can follow the same path.
- **Query pagination:** `query.area` cursors are revision-bound. Data changes
  invalidate them with `invalid-state`, rather than silently restarting.

See [API contracts](decisions.md) for the precise behavior behind these limits.

## Running the checks

Prerequisites: Node.js 22+, TypeScript 5.8+ available as `tsc`, Python 3, and an
installed Chromium-family browser for E2E. No browser or compiler is downloaded
automatically. Video fixture regeneration additionally requires `ffmpeg`.

```bash
npm run check                        # build, source/test/consumer types, unit tests
python3 demo/generate-tiles.py        # deterministic local PNG/SVG tiles + pixel oracle
npm run demo                         # http://localhost:8400/demo/
npm run e2e                          # WebGL 1, starts the server if needed
npm run e2e -- --webgpu              # WebGPU
npm run e2e -- --basic               # forced reduced WebGL 1 profile
npm run e2e -- --list
npm run e2e -- --scenario drag-point-follows-pointer --verbose
```

Use `--browser /path/to/Chromium` to select a browser. The runner can also
discover installed Chrome or a local Playwright browser cache. It connects
through the DevTools Protocol and runs against the built `dist/` package.

The basic profile disables instancing/uint-index/VAO extensions at the API
level, reports mediump fragment precision and limits texture size to 2048.
It verifies fallback paths, not genuine fp16 behavior on every GPU.

The runner exposes GC for memory checks and supplies anti-throttling flags.
Without exposed GC, manual soak runs use explicitly looser sanity bounds.
Headless compositor warm-up can delay the initial frames; lifecycle checks
assert liveness and report cadence, rather than claiming reference performance.

### Browser pages

Open the paths below under `http://localhost:8400/demo/`. Most test pages accept
`?backend=webgpu` (or `&backend=webgpu` with existing query parameters).

| Page | Purpose |
| --- | --- |
| `index.html` | Interactive library demo; local tiles by default, live providers via `?tiles=osm` or the basemap buttons |
| `scale.html` | 500,000-point example with measured import/render/pan HUD |
| `compare.html` | Opt-in matched Maplet / Leaflet 500,000-point comparison; see `benchmarks/README.md` |
| `tiles.html?mode=svg` | Offline tile orientation, pixel sampling and seams |
| `tiles.html?mode=osm` | Live OpenStreetMap tile comparison |
| `tiles.html?mode=esri-imagery&live=1` | Live JPEG provider comparison |
| `wms.html` / `wms.html?mode=live` | Deterministic local WMS checks / optional public WMS |
| `interaction.html`, `pick.html` | Events, gestures, selection and readback stalls |
| `labels.html`, `fonts.html`, `icons.html` | Text, shaping fixtures, image assets and anchor rotation |
| `mvt.html` | Vector-tile identity, fragments, failure handling and overzoom |
| `parity.html`, `loss.html` | Backend parity and recovery |
| `ui.html`, `detail.html` | Controls, geolocation, detail lifecycle and accessibility |
| `media.html`, `import.html` | Image/video updates and worker imports |
| `csp.html?csp=worker-none` | Explicit worker failure followed by inline imports |
| `soak.html` | Repeated lifecycle and large-import cleanup |
| `gpu-probe.html`, `probe.html` | Shader/pipeline and minimal pixel/pick diagnostics |

Failure screenshots are generated in `demo/checks/`, which is ignored by Git.
The test pages and E2E sources remain in the repository because they are
executable tests, not generated reports.

### Fixtures and optional downloads

Original SVG, MVT, image/video and font fixtures are retained for reproducible
checks. Regenerate original data with:

```bash
python3 demo/generate-tiles.py
python3 demo/generate-mvt.py
python3 demo/generate-media.py        # video requires ffmpeg
```

Provider caches are **not distributed in Git**. `demo/fetch-tiles.py` can prepare
an optional local cache for OSM-DE, OpenTopoMap and Esri; review provider policies
before running it. Cached-provider checks and the OSM-DE cache button require
that local data. Live-provider checks require network access.

OpenStreetMap standard is live-only in the demo, not fetched into an offline
cache. Cache requests are sequential, delayed and checked for duplicate
placeholder payloads. Missing cached tiles may report 404 while a decoded
parent covers their area; this is not proof that the missing request succeeded.

The Roboto subset is already included; `python3 demo/fetch-font.py --force`
regenerates it through Google Fonts. Its Czech and combining-character strings
are intentional typography test inputs, not untranslated interface text.
See [NOTICE](../NOTICE) and `demo/fonts/NOTICE.txt` for provenance and licenses.

## Distribution

`npm run build` generates ESM modules, declarations, source maps and the import
worker. The declaration rewrite script converts relative `.ts` imports to `.js`
and verifies its output. Consumer type tests resolve the package's root, math
and formats exports against those generated declarations.

The archive audit uses `npm pack --dry-run` to check runtime assets and exclude
development files. The package remains marked `private` to prevent accidental
npm publication; this does not prevent hosting the source in a public Git repo.
