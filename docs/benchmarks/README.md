# 500,000-point Maplet / Leaflet comparison

## Environment and records

Measured October 11–13, 2026, on an Apple M5 Pro with 64 GiB RAM, using headless
Chromium 153.0.0.0 (installed `chromium-1243` build), DPR 1. Leaflet is the
vendored, unmodified 1.9.4 ESM build. Maplet is the locally built alpha package.

- [Bulk-initialization A/B setup and pan](points-500k-bulk-initialization-ab.json):
  October 13, three fresh processes per version/backend against `40e22ed`, with
  alternating before/after order, plus three Canvas controls.
- [Bulk-initialization updates](points-500k-updates-bulk-initialization.json):
  final-build WebGL 1, WebGPU and Canvas, three fresh processes each; all
  **180 pixel/data-retention checks pass**.

- [Initialization A/B setup and pan](points-500k-initialization-ab.json): October
  12, three fresh processes per version/backend against an isolated build of
  `f656c7f`, with alternating before/after order, plus three Canvas controls.
- [Initialization follow-up updates](points-500k-updates-initialization.json):
  final-build WebGL 1, WebGPU and Canvas, three fresh processes each; all
  **180 pixel/data-retention checks pass**.

- [Retained-point setup and pan](points-500k-retained.json): October 12, three
  fresh processes each for Maplet WebGL 1, WebGPU and Leaflet Canvas.
- [Retained-point updates](points-500k-updates-retained.json): the same profiles,
  three fresh processes each, with all **180 pixel/data-retention checks passing**.
- [Immediate pre-change setup and pan](points-500k-before-retained.json) and
  [updates](points-500k-updates-before-retained.json): captured against the
  unchanged build before implementing retention, on the same machine/browser.
- [Archived October 11 setup and pan](points-500k.json): three fresh processes each for
  Maplet WebGL 1, Leaflet Canvas, Maplet WebGPU and Leaflet HTML markers.
- [Archived October 11 updates](points-500k-updates.json): three fresh processes
  each for the two Maplet backends and Leaflet Canvas, with 20 mutations per
  process. All 180 mutation checks passed.

The comparison source is `demo/compare.js`. Mutations are executed by
`demo/e2e/compare-updates.mjs`. `demo/compare.py` supplies an independent
120-second process budget and records timeout separately from pass/fail.
These expensive scenarios are opt-in, not added to the default E2E suite.

## Results

### Canvas-target initialization follow-up

The [final alternating A/B record](points-500k-canvas-target-ab.json) compares
the immediate retained-scene rewrite with this follow-up. Three fresh processes
per version/backend and three interleaved Canvas controls use the unchanged
`demo/compare.js` fixture/evaluator; only the isolated `dist/` root changes.
Version order reverses in repetition two. All 15 setup/pan processes pass count,
projection and pixel checks. No benchmark, profiling or build runs concurrently.

| Three-run median                        | Maplet WebGL 1 | Maplet WebGPU | Leaflet Canvas |
| --------------------------------------- | -------------: | ------------: | -------------: |
| Complete setup to paint opportunity     |         315 ms |        275 ms |         287 ms |
| Import / layer installation             |         243 ms |        206 ms |         221 ms |
| GC-stabilized main-thread heap increase |      127.4 MiB |     127.3 MiB |      207.1 MiB |

Immediate baseline setup medians are 367 ms / 336 ms: reductions of 14.2% / 18.2%,
with all six paired runs improving. Final WebGL is **28 ms (9.8%) slower than
Canvas**; WebGPU's median is **12 ms (4.2%) faster**. This is comparable roughly
0.3-second initialization on this fixture, not exact parity or a guarantee:
WebGPU's individual runs are 274, 311 and 275 ms, and one exceeds Canvas.
WebGL runs are 305, 315 and 323 ms. No confidence interval is inferred from three
processes. The fence includes map creation, generation, loading and the unchanged
two-rAF-plus-20-ms paint opportunity; it is not time-to-photon or GPU execution time.

The implementation copies validated primitive IDs directly, retains native
property-graph cloning, uses one identity lookup with separate live-slot and
generation columns, and adopts owned projected Float64 pools into canonical
pages. Point culling precedes object-view allocation; compact immutable pick
identity columns avoid eager ref objects, without reading recycled live rows.
Custom CRS callbacks, altitudes, full validation, ordering, transactions and
individual edits remain enabled. All 500,000 records remain present; rendered
counts remain 258,420 for Maplet and 231,240 for Canvas under their existing
culling conventions. No LOD, clustering or whole-scene raster replacement is used.

Build/source/test/consumer/distribution checks pass 253 tests; the full browser
suite passes 36/36 scenarios on WebGL 1, WebGPU and forced basic WebGL, with the
mixed and dense opt-in fixtures also passing on all three profiles. All
[180/180 final mutation checks](points-500k-canvas-target-updates.json) pass and
retain all 500,000 records; archived build/evaluator integrity checks pass. Warm pan
still has roughly one-second maximum intervals; this initialization change does
not establish hitch-free playback. The earlier
[initial controls](points-500k-canvas-target-before.json) and
[intermediate candidate](points-500k-canvas-target-candidate.json) are exploratory
records, not additional final repetitions.

### Retained-scene rewrite

The rewrite is compared against an isolated build of `315c5c8`, not the historical
timings below. Three fresh browser processes per version/workload/backend use
the same endpoint and evaluator; only the served `dist/` root changes, and
version order reverses in repetition two. No benchmark or build runs concurrently.
The [raw final record](retained-scene-ab.json) includes evaluator/build hashes,
individual measurements, tail intervals, functional checks and explicit timeouts.

| Alternating A/B: `315c5c8` → retained scene           |           WebGL 1 |            WebGPU |
| ----------------------------------------------------- | ----------------: | ----------------: |
| 500k points: setup to paint opportunity, median       |      465 → 405 ms |      458 → 326 ms |
| 500k points: data loading, median                     |      380 → 313 ms |      378 → 242 ms |
| 500k points: GC-stabilized JS heap increase           | 138.7 → 142.0 MiB | 138.7 → 142.0 MiB |
| 500k points: warm pan p50                             |    16.7 → 16.7 ms |    16.7 → 16.7 ms |
| Mixed vectors/symbols: warm pan p50                   |    56.8 → 16.7 ms |    57.3 → 16.7 ms |
| Mixed vectors/symbols: appearance edit p50            |    57.7 → 16.9 ms |    57.6 → 16.6 ms |
| Mixed vectors/symbols: draw calls                     |          2070 → 5 |          2070 → 5 |
| Mixed vectors/symbols: GC-stabilized JS heap increase |    20.1 → 7.5 MiB |    20.1 → 7.5 MiB |
| Mixed vectors/symbols: GPU allocation                 |  17.37 → 4.44 MiB |  17.37 → 4.49 MiB |

The point evaluator (`demo/compare.js`) is unchanged. The complementary mixed
fixture (`demo/e2e/complex-scene.mjs`) uses 96 × 256-vertex lines, 64 polygons
with 128 exterior vertices and two eight-vertex holes each, and 2,048 individually
interactive sprites plus collision-managed labels (16 image assets and 256
strings). Counts, exported geometry, actual worker use, polygon pixels and
individual picking are checked independently of timings. No LOD, clustering,
reduced count or replacement with a whole-scene image is used.

The mixed-scene improvement is approximately **3.4× shorter warm pan intervals**;
point setup is **12.9%/28.8% shorter**, with all six paired setup runs improving.
WebGL's first baseline setup run is a 925 ms outlier; its three-run median is
465 ms, not that outlier. Point heap is **3.3 MiB higher**, not an
improvement; mixed-scene heap and GPU storage are lower. Point warm runs still
contain roughly one-second maximum intervals. Three-run medians, main-thread
heap and paint fences are not confidence bounds, total browser memory or isolated
GPU execution times. There is no new Canvas/PixiJS comparison in this record.

To run the new opt-in fixtures against the current build:

```bash
npm run build
node demo/e2e/runner.mjs --scenario complex-scene-performance --verbose
node demo/e2e/runner.mjs --scenario dense-geometry-performance --verbose
```

Add `--webgpu` or `--basic` for the other profiles. The dense fixture has a
100,000-vertex line and an 8,192-vertex concave polygon with six 64-vertex holes.
Both single baseline attempts exceeded the **120-second whole-process budget**;
no baseline app-stage time, median or speedup ratio is inferred. The candidate
passes three fresh processes on each main backend and one basic-profile run,
with complete exported geometry and actual line/fill/hole pixels and picking.

| Vertex-heavy candidate only, three-run medians |        WebGL 1 |         WebGPU |
| ---------------------------------------------- | -------------: | -------------: |
| Import                                         |        21.1 ms |        20.9 ms |
| Import to first paint fence                    |      1070.9 ms |      1101.3 ms |
| Warm pan p50 / p95                             | 16.7 / 18.3 ms | 16.7 / 18.4 ms |
| Appearance edit p50 / p95                      | 16.6 / 31.4 ms | 16.2 / 32.0 ms |
| Main-thread JS heap increase after GC          |      11.12 MiB |      11.08 MiB |
| GPU allocation / draw calls                    |   7.07 MiB / 3 |   7.12 MiB / 3 |

This record has **31 completed passing processes and two baseline timeouts**:
24 alternating point/mixed-scene runs and seven completed dense-candidate runs.
It is not a 33/33 passing comparison. The final functional validation separately
passes 248 unit tests, 36 default browser scenarios on each of WebGL 1/WebGPU/basic,
and all 180 mutation samples in the 500,000-point scene. Three short dense pan
runs establish this fixture's behavior, not universal sustained-frame guarantees.

### Bulk initialization

| Measurement after bulk initialization     | Maplet WebGL 1 | Maplet WebGPU | Leaflet Canvas |
| ----------------------------------------- | -------------: | ------------: | -------------: |
| Setup to paint opportunity, median        |         449 ms |        444 ms |         282 ms |
| Data loading, median                      |         366 ms |        363 ms |         215 ms |
| Main-thread JS heap increase after GC     |      138.7 MiB |     138.7 MiB |      207.1 MiB |
| Warm pan interval p50, median across runs |        16.7 ms |       16.7 ms |       140.8 ms |
| Warm pan interval p95, median across runs |        18.3 ms |       18.4 ms |       151.5 ms |

| Alternating A/B: `40e22ed` → bulk initialization |               Maplet WebGL 1 |                Maplet WebGPU |
| ------------------------------------------------ | ---------------------------: | ---------------------------: |
| Setup to paint opportunity, median               | 606 → 449 ms (25.9% shorter) | 598 → 444 ms (25.8% shorter) |
| Data loading, median                             | 518 → 366 ms (29.3% shorter) | 516 → 363 ms (29.7% shorter) |
| Main-thread JS heap increase after GC            |            139.1 → 138.7 MiB |            139.0 → 138.7 MiB |
| Warm pan p50                                     |               16.7 → 16.7 ms |               16.7 → 16.7 ms |

Both builds use the same endpoint/browser/fixture/evaluator, and version order
reverses in repetition two. All **15 setup/pan runs** pass full-count, projection
and pixel checks. Every paired after-run has lower setup and loading times than
its before-run. The percentages use this fresh baseline, not the older record
below; no build or other benchmark runs concurrently. Three-run medians are
not statistical confidence bounds or a guarantee on other workloads/devices.

This is a bulk path for a **pristine source**, not a fully columnar replacement
of the live store. It builds normal individually editable records and the
spatial index from owned, validated columns, then adopts them with one undo
entry and one full-set invalidation. Existing/recycled stores keep the ordinary
replace/append path, including generation history and binding ownership checks.
CRS normalization and validation remain enabled. No points, metadata or
interactions are removed to obtain these results.

Warm Maplet runs still contain roughly one-second maximum intervals, as does
Canvas. Pan p50 stays at 16.7 ms; this work does not establish hitch-free
playback. Canvas setup remains faster at 282 ms. The final mutation comparison
passes **180/180 checks**, retaining all 500,000 records; paint-fence p50 is
20.7–29.5 ms for Maplet and 33.2–33.4 ms for Canvas. These fences remain near
the animation-frame floor and do not isolate GPU execution time.

### Direct point ingestion (preceding initialization stage)

| Measurement after direct point ingest     | Maplet WebGL 1 | Maplet WebGPU | Leaflet Canvas |
| ----------------------------------------- | -------------: | ------------: | -------------: |
| Setup to paint opportunity, median        |         685 ms |        654 ms |         288 ms |
| Data loading, median                      |         598 ms |        571 ms |         220 ms |
| Main-thread JS heap increase after GC     |      139.1 MiB |     139.0 MiB |      207.1 MiB |
| Warm pan interval p50, median across runs |        16.7 ms |       16.7 ms |       137.1 ms |
| Warm pan interval p95, median across runs |        16.9 ms |       17.5 ms |       167.4 ms |

| Alternating A/B: retained-point baseline → direct ingest |              Maplet WebGL 1 |                Maplet WebGPU |
| -------------------------------------------------------- | --------------------------: | ---------------------------: |
| Setup to paint opportunity, median                       | 743 → 685 ms (7.8% shorter) | 756 → 654 ms (13.5% shorter) |
| Data loading, median                                     | 659 → 598 ms (9.3% shorter) | 674 → 571 ms (15.3% shorter) |
| Main-thread JS heap increase after GC                    |           139.1 → 139.1 MiB |            139.0 → 139.0 MiB |
| Warm pan p50                                             |              16.7 → 16.7 ms |               16.7 → 16.7 ms |

Both versions use the same demo endpoint, browser, fixture and evaluator; only
the served `dist/` root changes. Before/after order reverses in repetition two.
All **15 setup/pan runs** pass count, projection and pixel checks; no build or
other benchmark runs concurrently. The record includes the evaluator's SHA-256.
The older retained-point record below is preserved, not used as the paired
baseline for these percentages.

These are reductions of three-run medians, not statistical confidence bounds
or guarantees: WebGL 1 repetition two and WebGPU repetition three are slower
after the change. Warm Maplet runs have 535–545 samples and Canvas 63–65;
roughly one-second maximum pan intervals still occur. Import/publication, not
the paint-wait fence, supplies the improvement; Canvas setup remains faster.

The final-build mutation check retains all 500,000 records and passes **180/180
checks**. Its paint-fence p50 values are 26.0–30.9 ms for Maplet and 33.2–33.3 ms
for Canvas. As before, these timings are near the two-frame floor and do not
isolate GPU execution time.

### Retained-point revision (preceding stage)

| Measurement                               | Maplet WebGL 1 | Maplet WebGPU | Leaflet Canvas |
| ----------------------------------------- | -------------: | ------------: | -------------: |
| Setup to paint opportunity, median        |         708 ms |        706 ms |         285 ms |
| Data loading, median                      |         619 ms |        623 ms |         219 ms |
| Main-thread JS heap increase after GC     |      139.1 MiB |     139.0 MiB |      207.1 MiB |
| Warm pan interval p50, median across runs |        16.7 ms |       16.7 ms |       137.1 ms |
| Warm pan interval p95, median across runs |        17.2 ms |       16.9 ms |       153.7 ms |

The measured small-pan interval is **8.2× shorter than Leaflet Canvas**. Setup
is roughly twice as fast as the immediate pre-change Maplet build, but still
slower than Canvas. This is a fixed-workload result, not an all-maps speed claim.

| Immediate before → after              |    Maplet WebGL 1 |     Maplet WebGPU |
| ------------------------------------- | ----------------: | ----------------: |
| Setup to paint opportunity, median    |    1,375 → 708 ms |    1,388 → 706 ms |
| Data loading, median                  |    1,133 → 619 ms |    1,152 → 623 ms |
| Warm pan p50                          |   163.9 → 16.7 ms |   160.1 → 16.7 ms |
| Main-thread JS heap increase after GC | 127.3 → 139.1 MiB | 127.3 → 139.0 MiB |

| Single-point operation: p50 / p95 to paint fence | Maplet WebGL 1 |  Maplet WebGPU | Leaflet Canvas |
| ------------------------------------------------ | -------------: | -------------: | -------------: |
| Hide                                             | 23.5 / 27.9 ms | 24.0 / 30.0 ms | 33.3 / 33.9 ms |
| Show                                             | 29.8 / 31.7 ms | 29.0 / 30.4 ms | 33.2 / 34.2 ms |
| Change color                                     | 30.4 / 31.4 ms | 28.9 / 30.7 ms | 33.3 / 33.6 ms |
| Move by 40 CSS pixels                            | 30.1 / 31.9 ms | 28.8 / 30.8 ms | 33.3 / 34.1 ms |

Against the immediate pre-change Maplet build, these p50 values are **5.4–7.2×
shorter** (before: 162.5–178.8 ms). Their small difference from Canvas is close
to the animation-frame fence floor; it is not a GPU-only speedup measurement.

All three archived HTML-marker runs exceeded the 120-second whole-process budget;
no completed timing is available for that variant. Timing definitions,
sample sizes and limits are described below.

## Shared workload

- 500,000 points, a deterministic approximately 708 × 708 grid spanning one
  degree of longitude/latitude around `{lat: 50, lng: 14.05}`.
- Zoom 10, viewport 720 × 520 CSS pixels, two-pixel-radius blue circles.
- Every point has an ID and a small property object. All layers remain interactive.
- No basemap, labels, clustering, aggregation or reduced point count.
- Maplet: one point layer, columnar worker import with `copy: false`.
- Leaflet Canvas: `L.circleMarker`, one Canvas renderer, padding 0, no stroke,
  fill opacity 1. All 500,000 point objects are retained and added to the map.
- Leaflet DOM: `L.marker` with shared `L.divIcon` configuration and four-pixel
  circular HTML elements, without icon shadows or keyboard focus per marker.
  This minimizes extra DOM work rather than using oversized default pin icons.

Map creation, generation and data loading are timed separately. Loading means
worker preparation plus store publication in Maplet, and circle/marker object
construction plus layer installation in Leaflet. These are application-level
operations, not equivalent internal algorithms: Leaflet does not implement
Maplet's transactional store or spatial data-query model.

## Timing and correctness

### Setup and pan

The setup total begins before map creation and ends after two animation-frame
callbacks plus a 20 ms delay. All variants use this same paint opportunity
fence. It is not a compositor presentation timestamp or GPU execution timer.
Source creation and import/layer installation are included. Pixel sampling,
GC, screenshot capture and record serialization happen outside this total.

Two in-viewport pixel probes must show the blue points. Their screen positions
are also compared with an independent Web Mercator formula (within one CSS
pixel, allowing Leaflet's integer rounding). Completed runs retain all 500,000
points and have nonempty rendering. Screenshots were inspected separately.
The original scale page's second probe lies outside this viewport in Leaflet;
the matched comparison deliberately uses an in-viewport probe for both engines.

Maplet plans 258,420 instances, including its existing 32-pixel culling margin.
Leaflet Canvas draws 231,240 circles with padding 0. These counters are not the
same definition of “visible point.” The underlying dataset and viewport are
identical, and no normalization of timings by these counts is claimed.

Pan follows the original tiny sinusoidal center changes, approximately
0.0006° latitude and 0.0008° longitude, without animations. A 2.5 s initial
sample is followed by 5 s of additional pan warm-up and a 10 s measured pan.
Each interval is `view.set`/`panTo` to the next animation-frame callback.
Leaflet rounds its pan offsets; Maplet retains fractional coordinates. This
test is not a realistic continuous large-distance drag or a display FPS counter.

The retained-point warm runs contain 538–541 samples for Maplet WebGL 1,
538–539 for WebGPU and 66–68 for Leaflet Canvas. The setup/pan table reports the
median of the three per-run p50/p95 values, not a pooled percentile. **Every
final warm run still contains a roughly one-second maximum interval**, including
Canvas. The lower p50/p95 is not proof of hitch-free playback; headless scheduling
outliers remain visible in the raw records.

### Visibility, color and position

One actual dataset point (`p:250986`) is enlarged to radius 8 and raised above
its overlapping neighbors before timing. This keeps it observable without
removing or replacing the background dataset.

Each cycle hides it, shows it, alternates red/green and moves it 40 CSS pixels.
Five cycles per process yield 15 samples per operation/backend across three
fresh runs. The published update p50 is the median of all 15 samples; p95 uses
sorted index `floor(15 × 0.95)`, so it is the maximum for this small sample.

- Maplet visibility/color use `layer.features.setOverride`; positions use
  `source.features.update`. Hidden source data and references remain present.
- Leaflet visibility removes/re-adds the same point object; its data remains
  retained in the points array. Color uses `setStyle` and movement uses `setLatLng`.
- API-call duration is separate from time through two animation-frame callbacks.
  Maplet additionally confirms the logical revision has rendered. This is a
  paint-fence measurement, not an exact time-to-photon or GPU-only cost.
- Each operation is checked against its expected color and presence. Movement
  also checks the previous location. GPU readback RGB is unpremultiplied before
  comparing CSS colors; Canvas2D already returns straight RGB.
- All 500,000 data objects remain retained. Only the intended point is hidden,
  recolored or moved. The other 499,999 points are not filtered out to improve times.

Leaflet's roughly 33 ms paint-fence time is near two 60 Hz animation-frame
intervals. Its actual redraw can be substantially shorter; the measurement
does not isolate that time. Retained-point Maplet records 23.5–30.4 ms p50,
instead of the pre-change 162.5–178.8 ms. Readback occurs outside the timer but
can change the next operation's phase relative to an animation frame. Do not
interpret the small Maplet/Canvas fence difference as an isolated redraw-time
advantage. Both systems support these changes; throughput for changing many
points per frame is not established.

### Memory and timeouts

Main-thread JS heap deltas are sampled after exposed GC before setup and after
initial rendering. They are 139.0–139.1 MiB for retained-point Maplet and
207.1 MiB for Leaflet Canvas: about **33% less than Canvas**, but about **9% more
than the pre-change Maplet build**. Retaining row indices and per-instance state
trades some persistent memory for much less repeated planning/upload work.
They do not include all worker memory, DOM/native allocations or driver memory.
Maplet's GPU counter reports 15.8 MiB, not total driver VRAM. The older scale
page's non-GC heap readings are not comparable with these GC-stabilized deltas.

All three archived HTML-marker runs exceeded the **whole-process** 120-second budget.
The wrapper terminated each process group it created, including its browser.
No completed initial-render, pan, mutation or memory result was captured for
that variant. The timeout does not identify which phase exceeded the budget,
and must not be reported as a 120-second startup measurement, crash, universal
marker limit or speedup multiplier. DOM mutation tests were not run because
the full-scene prerequisites did not complete.

## Retained-point implementation and regression checks

- Plain-point layers without icons retain their sorted, viewport-relative
  instances, slot-to-row lookup and generation-bound pick references. Small pan
  inside the 32-CSS-pixel resident margin changes shader uniforms, not point data.
- Bounded, independently consumed change journals localize position, property,
  override, hover and selection changes. Filters and visibility update the same
  rows; hiding never discards source data. Adjacent dirty rows share an upload.
- WebGL and WebGPU retain batch buffers across color, pick and sample passes.
  A local point change uploads **64 bytes**; the basic WebGL fallback expands
  only that row and uploads **432 bytes**. These sizes and zero-upload small pan
  are asserted against actual GPU calls in `retained-point-buffers`, alongside
  pixels, picking and all 20,000 retained records, on all three profiles.
- Zoom, resident-set/order changes, slot-identity changes, broad render
  invalidations and journal overflow rebuild safely. A backend that missed an
  upload version refreshes the full buffer. Icons, labels and complex geometry
  keep the existing planner; the circle benchmark does not establish their speed.
- Columnar point imports stay compact across the worker boundary. Position
  buffers transfer back without an expanded per-feature geometry tree. Store
  publication still uses normal transactional validation and ownership checks.

The retained-point checks passed **204 unit tests** and **35 browser scenarios/batteries per
profile** (WebGL 1, WebGPU, basic WebGL 1). Regression checks include failed
transactions, recycled slots with equal generations but different identities,
late cancelled worker replies of a different result format, first/skipped-version
uploads and disabling stale WebGL attribute pointers before freeing buffers.
Existing MVT, bindings, raster, labels, sprites, interaction and loss recovery
checks remain enabled. Current Maplet and Canvas comparison screenshots were
opened and inspected; coordinate and pixel probes are retained in the records.

### Direct point ingestion and regression checks

- Points use the existing checked CRS conversion, then store coordinates and
  altitude inline, without allocating a prepared geometry payload or degenerate
  typed-array bounding box. Complex geometries keep their prepared path.
- Point indexing inserts directly into its one clamped grid cell; the shared
  bucket operation is also used by rectangle indexing. Generations, journal
  entries, rollback and metadata ownership keep the same store implementation.
- Insertion uses the returned slot and one feature reference instead of an
  additional composite-ID lookup and duplicate reference allocation.
- The final check passes **208 unit tests**, source/test/consumer type checks,
  distribution checks, and **35 browser scenarios/batteries per profile** on
  WebGL 1, WebGPU and basic WebGL 1. Differential tests cover CRS/wrapping,
  altitude, validation failures and index boundaries. The allocation regression
  check rejects the original ingest path. Final Maplet/Canvas screenshots were
  opened and inspected; pixel and projection probes remain unchanged.

### Bulk-initialization regression checks

The final check passes **219 unit tests**, build/source/test/consumer type and
distribution checks, plus **35 browser scenarios/batteries per profile** on
WebGL 1, WebGPU and basic WebGL 1. The bulk path is tested against ordinary CRUD
across CRS, wrapping, generated IDs, numeric/string identities, altitude and
metadata ownership. All 5,000 rows of a separate structural fixture are checked
for identity, properties and canonical position; it rejects the original
per-row CRUD path and asserts a single undo entry.

Tests also cover full-domain validation before adoption, cancellation during
the final CRS conversion, late writes during preparation, unchanged binding
ownership/overflow behavior, whole-set cache invalidation followed by local
uploads, and rollback after later staged edits. Consumed generations remain
invalid after rollback, and discarded free slots cannot leak into subsequent
writes. Final setup and mutation screenshots for both Maplet and Canvas were
opened and inspected. The unchanged evaluator's SHA-256 is stored in the A/B
record; the historical records remain intact.

## Canvas, PixiJS and dynamic maps

Canvas is not inherently noninteractive or CPU-only. Leaflet supplies hit
testing and mutable circle/path layers; the measurements above verify actual
visibility, color and position changes in its Canvas renderer.

PixiJS can still be a useful alternative for sprite-heavy maps:

- Its sprite scene graph exposes per-object position, tint and visibility,
  with texture sharing and batching. This is convenient for icons, animated
  symbols and richer effects rather than only simple circles.
- Leaflet.PixiOverlay projects geometry into a shared coordinate system and
  supports scaling on zoom without reprojecting every geometry, plus Leaflet
  zoom animation. This is an architectural capability, not a measured speedup here.
- Canvas partial redraws and GPU batching are different strategies. Leaflet
  Canvas tracks a changed region, scans its draw list and redraws intersecting
  paths. In this local single-point workload, that is effective. Maplet now
  retains plain-point instance data and uploads changed rows rather than
  rebuilding all point data for a single feature; GPU drawing alone did not
  remove that CPU preparation cost in the archived build.
- Pointer interaction is a separate problem. Leaflet 1.9.4 Canvas walks its
  draw list to find hover/click targets. PixiJS likewise has scene-tree hit
  testing; GPU rendering does not automatically make hit testing cheap.
  PixiOverlay's city example uses a quadtree for target lookup and disables the
  default interaction manager. Its million-marker particle example also disables
  that manager, so it is not evidence of one million independently interactive sprites.

Maplet's intended advantage is integrated dynamic GPU rendering **and** a
native typed data/identity/update model, not the claim that Canvas cannot change
point state. Visibility, color and position are implemented and checked here;
these results do not establish throughput for changing many points per frame.
No PixiJS/PixiOverlay timing baseline was run, and these tests do not justify a
Maplet-versus-PixiJS claim.

Primary sources (reviewed October 11, 2026):

- [Leaflet 1.9.4 Canvas implementation](https://github.com/Leaflet/Leaflet/blob/v1.9.4/src/layer/vector/Canvas.js): `_updatePath`, `_draw`, `_onClick`, `_handleMouseHover`.
- [Leaflet.PixiOverlay documentation](https://github.com/manubb/Leaflet.PixiOverlay): scaling, sprites and interaction options; the documented overlay versions support PixiJS 4–7.
- [PixiOverlay city example](https://github.com/manubb/Leaflet.PixiOverlay/blob/master/docs/us-cities.html): quadtree lookup, focus texture and throttled hover.
- [PixiOverlay million-marker example](https://github.com/manubb/Leaflet.PixiOverlay/blob/master/docs/many-markers.html): particle batching with the interaction manager disabled.
- [PixiJS sprite/batching guidance](https://pixijs.com/8.x/guides/concepts/performance-tips) and [scene objects](https://pixijs.com/8.x/guides/components/scene-objects): current PixiJS concepts, not a claim that this Leaflet overlay supports version 8.
- [PixiJS hit testing](https://pixijs.com/8.x/guides/components/events): scene-tree traversal, hit areas and interactive children.

## Reproduction

Build first; an installed Chromium browser is required. No packages or browsers
are downloaded by these commands. The Python wrapper uses POSIX process groups
for its hard deadline (macOS/Linux):

```bash
npm run build
python3 demo/compare.py --no-dom --output docs/benchmarks/points-500k-local.json
python3 demo/compare.py --updates --no-dom --output docs/benchmarks/points-500k-updates-local.json
```

These commands preserve the archived/pre-change records. Omit `--no-dom` to
include HTML markers in setup/pan; each of their three runs has a 120-second
budget. `--output` chooses the record destination; without it the original
`points-500k.json` / `points-500k-updates.json` is replaced. Screenshots go to
Git-ignored `demo/checks/` and are not part of the public result records.

For an initialization A/B check, also build the applicable baseline in an
isolated directory: `40e22ed` for bulk initialization, or `f656c7f` for the
preceding direct-ingestion stage.
Serve the unchanged current demo while selecting that build's `dist/` or the
current `dist/` at the same URL. Run the Maplet scenario below in fresh processes,
alternating version order over three repetitions on each backend, with a Canvas
control per repetition. Do not build or run another benchmark during timing;
keep new results separate from the checked-in records.

To inspect one variant:

```bash
npm run e2e -- --scenario comparison:maplet --verbose
npm run e2e -- --scenario comparison:maplet --webgpu --verbose
npm run e2e -- --scenario comparison:leaflet-canvas --verbose
npm run e2e -- --scenario comparison-updates:maplet --verbose
npm run e2e -- --scenario comparison-updates:maplet --webgpu --verbose
npm run e2e -- --scenario comparison-updates:leaflet-canvas --verbose
```

Use the Python wrapper for the DOM variant: the existing browser runner's
in-page timeout cannot reliably interrupt a blocked renderer. The outer process
deadline prevents leaked browser processes. Re-run on target hardware and with
representative data before making product performance decisions.
