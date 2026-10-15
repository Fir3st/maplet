# Implementation status

Maplet is an alpha library (`0.1.0-alpha.7`). This document describes the
implementation, reproducible checks and known gaps. It replaces the internal
development log; no external planning documents or saved screenshots are needed
to use this repository.

## Implemented scope

| Area | Implementation and checks |
| --- | --- |
| Coordinates and view | Web Mercator, EPSG:4326, ellipsoidal Mercator, Simple/custom CRS, bounds, fit/flyTo, limits; math/view tests and a vendored Leaflet 1.9.4 oracle |
| Data | Stable identities/generations, CRUD, transactions/rollback, snapshots, state, selection, queries, GeoJSON and columnar imports; `test/scene/`, `test/io/` |
| Layers and styles | Heterogeneous nested layers, shared base, ordering, filters, overrides, expressions, points, lines and polygon holes; scene/render tests |
| Relations and bindings | Endpoint policies, traversal, dependency DAGs, field ownership, `lineBetween`, `anchorOnLine`, `copyProperty`; relation and data tests |
| Rendering | WebGPU and WebGL 1, retained mixed-vector buffers with local uploads, indexed polygon meshes and spatial geometry blocks, expansion without instancing/wide indices, shared frame plan and loss recovery; `test/render/`, parity/loss batteries, `retained-point-buffers` and `retained-mixed-scene` E2E |
| Raster | XYZ/TMS/retina, decoded parent/child fallback, previous-bitmap retention, WMS axis/CRS semantics; raster tests, `demo/tiles.html`, `demo/wms.html` |
| MVT | Decoder, source-layer namespaces, exact large IDs, fragments, unload/reload, overzoom and attribution; vector-tile tests, `demo/mvt.html` |
| Interaction | Pan, zoom, hover/click/drag, pinch, keyboard, selection, bubbling; `demo/interaction.html` and real-input E2E scenarios |
| Picking | Shape-aware GPU queries, revision/generation checks, measured blocking/async readback; `demo/pick.html` |
| Text and fonts | Labels, multi-line text, collisions, rotation, atlas eviction, font loading/fallback, platform shaping, bidi; `demo/labels.html`, `demo/fonts.html` |
| Media | Sprites, anchor rotation, tinting, image/video bounds with placement rotation, partial uploads and cleanup; `demo/icons.html`, `demo/media.html` |
| HTML UI | Optional controls, scale, attribution, geolocation, feature detail and bounded accessible lists; `test/ui/`, `demo/ui.html`, `demo/detail.html` |
| Markers | Leaflet-style `addMarker`/`addMarkers` GPU pins with hover/permanent tooltips, one click popup with auto-pan, custom icons/tint and per-marker overrides; `demo/markers.html` |
| Plugins | Plain setup functions, typed APIs, HTML access, abort/cleanup, render transforms, after-frame drawing, replaceable renderers and the built-in `gestureGuard`/`fullscreenMode`/`heatmap` plugins; plugin tests, consumer types, the `plugins` scenario and `demo/plugins-builtin.html`; [guide](plugins.md) |
| Worker imports | Compact columns/canonical line and polygon pools, owned metadata on the publishing thread, validation, copy/move, cancellation, bounded queue, crash/CSP fallback; import tests, `demo/import.html`, `demo/csp.html?csp=worker-none` |
| Distribution | ESM/declaration/subpath/worker assets, archive audit and consumer types; `test/publish/`, `type-tests/` |
| Lifecycle and scale | Repeated create/destroy, GC-stabilized memory checks, cancellation and 500,000-point example; `demo/soak.html`, `demo/scale.html` |

## Recorded validation

The plugin addition passes **268 unit tests** and all build/type/distribution
checks. The new `plugins` browser scenario passes **16 assertions per profile**
on WebGL 1, WebGPU and forced basic WebGL 1, run through Playwright against the
built package. It checks actual GPU/Canvas pixels, HTML addition/modification,
cleanup, custom-only initialization, keyboard interaction, custom picking and
restoration. A 10,000-point unit fixture verifies packed-buffer retention and
coalesced plugin invalidation, not a throughput benchmark. The complete existing
browser battery was not rerun for this addition.

The development record from October 10–11, 2026 reports **189 passing unit tests**
and **34 passing E2E scenarios/batteries** on each of WebGL 1, WebGPU and the
forced basic WebGL 1 profile. These are historical results, not a guarantee
about a different checkout, browser or machine. Run the commands below for
current results.

The retained-point revision checked on October 12, 2026 passes **204 unit tests**
and **35 E2E scenarios/batteries per profile** (WebGL 1, WebGPU and forced basic
WebGL 1). The new `retained-point-buffers` scenario instruments actual GPU calls:
small pan uploads no point data; a local edit uploads 64 bytes, or 432 bytes in
the CPU-expanded basic profile. Pixels, picking and all 20,000 source records
are checked together. Import tests also cover slot reuse, atomic publication
and late cancelled replies crossing different worker result formats.

The initialization follow-up passes **208 unit tests** and the same **35 E2E
scenarios/batteries on each of all three profiles**. Additional tests compare
direct point ingestion with prepared geometry across CRS, wrapping, altitude,
validation failures and spatial-index boundaries, and verify insertion slot
identity without a second ID lookup. A fresh 500,000-point mutation comparison
passes **180/180 pixel/data-retention checks** on the final build.

The bulk-initialization follow-up checked on October 13 passes **219 unit tests**,
all build/type/distribution checks, **35 E2E scenarios/batteries on each of all
three profiles**, and a fresh **180/180 mutation checks**. New tests cover a
single batch undo, whole-set invalidation, staged rollback/generation safety,
CRS-domain failure, cancellation during the last conversion, generated IDs,
binding ownership/overflow and writes during preparation. Initial datasets use
atomic off-store construction; existing or recycled stores keep the normal path.

The retained-scene rewrite checked on October 13 passes **248 unit tests**, all
build/type/distribution checks, **36 E2E scenarios/batteries on each of all three
GPU profiles**, and **180/180 pixel/data-retention mutation samples** (three fresh
processes per profile). Its mixed-scene GPU instrumentation verifies no vector,
sprite or label upload on a resident pan; a fill-color edit reuses tessellation;
text/icon appearance edits upload only their affected quads without atlas upload.
The same scenario renders/picks a 70,000-vertex polygon even on uint-index-free
basic WebGL. Independent geometry tests cover concavity, holes, non-overlap,
large-ring self-intersections and Float64 clipping, alongside storage, ownership,
custom-CRS, cancellation, rollback and generation regressions. Heavy-map destruction
leaves 0.9–1.0 MiB of GC-stabilized residual main-thread heap in the soak fixture.
Hidden-group cache cleanup also has a regression test that rejected the faulty
candidate before the repair. The final [retained-scene A/B record](benchmarks/retained-scene-ab.json)
matches that recorded rewrite build: point setup medians are **465 → 405 ms** and
**458 → 326 ms** (WebGL 1/WebGPU); mixed geometry/sprite/text pan is approximately
**57 → 17 ms**, with draw calls **2070 → 5**. Point heap rises **3.3 MiB**; mixed
heap and GPU allocation decrease. Vertex-heavy candidates pass on all profiles,
but both bounded baseline attempts time out, so no dense-baseline timing ratio
is claimed. Point warm-pan maxima remain approximately one second.

The Canvas-target follow-up passes **253 unit tests**, **36 browser scenarios per
GPU profile**, mixed/dense fixtures on all three profiles and **180/180 final
mutation samples**, retaining all 500,000 records. The archived final build and
unchanged evaluator hashes match. Complete initialization medians are **315 ms
WebGL 1 / 275 ms WebGPU versus 287 ms Canvas**: comparable for this fixture,
but WebGL is still 9.8% slower, and one WebGPU run also exceeds Canvas. Immediate
baseline medians were 367 / 336 ms. Main-thread heap falls from 142 MiB to
127.3–127.4 MiB. See the [final comparison](benchmarks/points-500k-canvas-target-ab.json).

The icon-tint addition passes **307 unit tests**, all build/source/test/consumer
type and distribution checks, and the complete default browser suite: **39/39
scenarios/batteries on each of WebGL 1, WebGPU and forced basic WebGL 1**. The
extended `battery:icons` samples the multiplied atlas pixels (a white texel times
`#3366ff` reads `[51,101,253]`), the tinted red pin body, picking under tint and a
per-feature override; `retained-mixed-scene` instruments the actual GPU calls: a
tint edit uploads one 384-byte quad range with no atlas upload, and the tinted
pixels still pick. Untinted pixels and all previous icon checks are unchanged.

The multi-line label addition passes **308 unit tests**, the same build/type/
distribution and consumer-type checks, and the complete default browser suite:
**39/39 scenarios/batteries on each of WebGL 1, WebGPU and forced basic WebGL 1**.
The extended `battery:labels` scans rendered ink: a two-line label produces two
bands in order (measured widths 102 and 58 px), centre-to-centre spacing of
19.5 px against the fixed 19 px line height, and a block centred on the anchor;
glyph picking hits both lines and neither the inter-line gap nor the space above
the block. Single-line pixels and every previous label, font and icon check are
unchanged.

The media-rotation addition passes **309 unit tests**, the same build/type/
distribution and consumer-type checks, and the complete default browser suite:
**39/39 scenarios/batteries on each of WebGL 1, WebGPU and forced basic WebGL 1**.
The extended `battery:media` turns an 80x160 placement by 90 degrees about its
centre and samples the texture quadrants at their turned positions (the red
top-left corner reads at the right edge, and so on), the emptied old strips and
the filled new strip; picking hits inside the turned quad and misses inside the
old axis-aligned bounds, the descriptor revision bumps while `pixelVersion`
stays. At 45 degrees the corners of the axis-aligned box read `rgba(0,0,0,0)`
while the turned midsides keep their exact quadrant colours. Unturned placements
and every previous media, video and lifecycle check are unchanged.

The marker addition passes **312 unit tests**, the same build/type/distribution
and consumer-type checks, and the complete default browser suite: **40/40
scenarios/batteries on each of WebGL 1, WebGPU and forced basic WebGL 1**. The
new `battery:markers` samples the default pin (body `rgba(37,99,235,255)`, white
centre, empty below the tip and above the sprite) and its `setPosition` move, the
hover tooltip (text, `role`, bottom 36 px above the marker, `pointer-events:
none`), a permanent tooltip that ignores `mouseout`, the click popup (single
instance, close button, background click, plain-text strings, `Node` content),
pan and zoom follow (the overlay delta equals the anchor delta, and zoom re-places
to the same offset), auto-pan (the marker moved 52 px down so an edge popup fits;
`autoPan: false` left the view untouched), a 16 px custom asset, tinted pixels
(`rgba(0,99,0,255)` body, `rgba(0,255,0,255)` centre), marker feature events,
`setIcon(null)` restoring the built-in pin and removal leaving no DOM overlay
behind. Untouched layers, existing icon/media checks and the other 39
scenarios/batteries are unchanged.

The three built-in plugin additions pass **331 unit tests**, the same build/type/
distribution and consumer-type checks, and the complete default browser suite:
**41/41 scenarios/batteries on each of WebGL 1, WebGPU and forced basic WebGL 1**.
The `battery:plugins-builtin` battery runs eleven checks. It drives synthetic input
through the real interaction layer: a one-finger touch pan and drag keep the view
still while a two-finger pinch (zoom 13 → 13.51) and a two-finger drag move it; a
mouse pan, wheel and double-click do nothing without the modifier — the blocked
wheel is never `preventDefault`ed — and apply with Alt; a blocked attempt shows
the hint overlay ("Hold Alt and scroll to zoom the map", "Use 2 fingers to move
the map"), which an allowed gesture hides, which expires on its own and which
stays silent with `overlay: false`; `unlock()`/`lock()`, `setModifier('control')`
and `onChange` behave; removing the guard restores `touch-action: none` and
unguarded gestures. The fullscreen checks stub the API to cover native `enter`,
`exit`, browser-initiated exits, the corner button and cleanup; a denied request
reports `mode: 'fallback'`, covers the container (`position: fixed` plus a
marker) and Escape exits and restores it, while `fallback: false` resolves
`false`; an unsupported target resolves `false`; the map follows container
resizes (640×480 → 520×360 → back). The heatmap checks render a real field from
stacked weighted samples (5,044 painted pixels with a saturated red core), turn
the core green after a gradient change, shrink the field with a smaller radius,
follow `addPoint`/`clear` down to zero painted pixels and remove the overlay
canvas; an empty plugin still sizes its transparent surface to the container and
leaves container styles untouched; and a single-sample field moves within 2 px of
the renderer's own projection after a view change. Live documentation checks
additionally entered real fullscreen through a real click on the tutorial action
and the corner button (the map auto-resized to 1476×987, Escape synced the
state), and the gesture-guard tutorial gated a real wheel, showed the hint and
selected the modifier from its buttons. The heatmap tutorial was checked live
too: 850 samples produced a graded field (183,273 painted pixels across five
intensity bands), a ramp switch turned the hot core to the new color, a bigger
radius grew the field, and the controls cleared, regenerated and removed it.

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
[benchmark records](benchmarks/README.md)
for workload, memory observations, timing definitions and limitations. These
current observations should not be confused with the earlier development record.

The October 11 [matched Leaflet comparison](benchmarks/README.md) includes
Canvas and HTML-marker variants, longer warmed-up pan measurements, and
pixel-verified visibility/color/position changes. Leaflet Canvas was faster
than the pre-retention alpha for setup, pan and these single-point updates;
Maplet used less main-thread JS heap after GC. Three HTML-marker runs timed out
within the 120-second whole-process budget, so no successful DOM timing is
claimed. All 180 single-point mutation checks passed across the completed
Maplet/Canvas variants. PixiJS was researched, not benchmarked.

The October 12 retained-point [before/after comparison](benchmarks/README.md)
uses the same workload and checks: warmed small pan is 16.7 ms p50 on both
Maplet backends versus Canvas's 137.1 ms (8.2× shorter). Single-point paint
fences are 23.5–30.4 ms p50, down from 162.5–178.8 ms, with all 180 mutation
checks passing. Setup is 706–708 ms versus Canvas's 285 ms. Main-thread JS
heap increase is 139 MiB versus 207 MiB for Canvas, but 9% above pre-change Maplet.
Every final warm run still contains a roughly one-second maximum interval;
these results do not establish hitch-free playback, large-pan/zoom throughput,
sprite performance or a universal advantage over Canvas.

The initialization follow-up [alternating A/B record](benchmarks/points-500k-initialization-ab.json)
compares an isolated build of `f656c7f` with the direct point-ingest path, using
the unchanged evaluator. Three fresh runs per version/backend plus three Canvas
controls give setup medians of **743 → 685 ms (WebGL 1, 7.8% shorter)** and
**756 → 654 ms (WebGPU, 13.5% shorter)**. Import medians are **659 → 598 ms** and
**674 → 571 ms**, respectively. Heap deltas stay at 139 MiB and warm pan p50
stays at 16.7 ms; Canvas setup is still faster at 288 ms. Some individual runs
are slower after the change, and roughly one-second pan outliers remain.

The October 13 [bulk-initialization A/B record](benchmarks/points-500k-bulk-initialization-ab.json)
compares against `40e22ed` with the same unchanged workload/evaluator. Setup
medians are **606 → 449 ms (WebGL 1, 25.9% shorter)** and **598 → 444 ms (WebGPU,
25.8% shorter)**; imports are **518 → 366 ms** and **516 → 363 ms**, respectively
(29.3% and 29.7% shorter). All six paired runs improve. These percentages use
the freshly measured baseline, not the older initialization record. Main-thread
heap deltas are 138.7 MiB after the change and warm pan p50 remains 16.7 ms;
Canvas setup is still faster at 282 ms. One-second warm-pan outliers persist.

## Known limitations

- **Performance:** reference hardware and the reference benchmark suite have
  not been established. Points, lines, fills, sprites and labels retain GPU data:
  pan within a 32-CSS-pixel resident margin changes uniforms, and compatible
  appearance edits upload changed ranges. Zoom, resident-set/order changes and
  invalidation-journal overflow rebuild safely. Text/size/priority changes rerun
  collision layout; geometry size changes can rebuild a layer's derived buffers.
- **Memory:** canonical anchors/coordinates and part offsets use paged/typed
  storage; properties, IDs and geometry descriptors remain JS objects. This is
  not a fully binary scene, and retained data has a working-set cost.
- **Text:** platform Canvas2D supplies shaping and metrics; no custom font
  parser or GSUB/GPOS shaper. Labels split on `\n` into a vertically centred
  multi-line block with a fixed line height; there is no automatic wrapping.
  Collision uses the block's bounding box without a halo margin, and labels do
  not promise identical pixels across browsers/OSes.
- **Media:** overlays are placed into axis-aligned bounds; `rotate` turns a
  placement clockwise about its centre, without skew or color filters. Opacity
  is supported; custom blending modes are not. Runtime URL updates are supported
  for images, not video.
- **Icons:** size is square via `iconSize` or natural size/DPR. `iconTint` multiplies
  the icon atlas RGB (default white); the shape fallback of a loading/failed icon
  keeps `color` and is not tinted. Shape fallbacks and ordinary point shapes do not
  rotate. Without browser image support, assets report error and use the shape fallback.
- **Markers:** pins are GPU sprites with no per-marker DOM; tooltips and popups are
  DOM overlays (at most one popup and one hover tooltip at a time, while a
  permanent tooltip owns one element per marker). Strings render as text (UI-06)
  rather than Leaflet-style HTML; pass a `Node` for rich content. Marker dragging,
  cluster grouping and DOM focus on pins are not part of this alpha.
- **Plugins:** the gesture guard blocks one-finger touch feature drags and touch
  double-tap zoom (a touch double-click reports `mouse`); with
  `touch-action: pan-y` a two-finger vertical drag can still scroll the page.
  Its hint overlay is DOM created on the first blocked attempt. Fullscreen needs
  browser support and a user gesture; requests resolve a boolean instead of
  throwing, and a denied request covers the window with the CSS fallback
  (`mode: 'fallback'`) unless `fallback: false`. The heatmap plugin splats on the
  CPU per rendered frame into a bounded buffer (≤1M pixels, ≤1.5 device pixels per
  CSS pixel), draws above GPU-delivered features and skips samples outside the
  view.
- **Altitude:** preserved for points, multiPoints, circles and rectangles, but
  not for line/polygon geometry or its exported coordinates.
- **MVT:** no antimeridian world wrapping. Residency follows the viewport rather
  than a temporal tile cache. One clamped source zoom is requested at a time;
  higher view zooms scale existing geometry. Edits require a mutable overlay.
- **Bindings:** synchronous evaluators are supported; worker-based binding
  modules and their backpressure protocol are not.
- **GPU extensions:** public plan transforms, frame hooks and custom renderers
  are supported. There is no API for deliberate built-in backend switching;
  automatic device/context-loss recovery is implemented.
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
development files. GitHub Packages publication uses the repository-linked registry;
the same tested archive is attached to GitHub Releases.
