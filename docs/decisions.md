# Maplet API contracts

These contracts define units, defaults and observable behavior for the alpha
implementation and its tests. Changes require an explicit contract update and
matching test changes; tests must not establish defaults accidentally.

The current public construction, object lifetime and migration contract is in
[the object API guide](api.md). The engine contracts below remain in force.

## Units and coordinates

- World coordinates use a scale of `256` at zoom 0 for every CRS. Screen
  coordinates are CSS pixels; shaders account for device pixel ratio (DPR).
  `WorldPoint` is neither a geographic position nor a planar unit.
- EPSG:4326 uses `x = lng/360 + 0.5`, `y = 0.5 − lat/360`. It deliberately
  differs from Leaflet's EPSG:4326 pixel mapping.
- EPSG:3395 is ellipsoidal Mercator (WGS 84, eccentricity derived from `a`/`b`),
  not spherical EPSG:3857.
- Simple CRS uses planar `{x, y}` units, with `y` increasing northward.
  Distances are Euclidean and reported as `planarUnits`.
- Geographic distances use haversine with mean Earth radius `6,371,008.8 m`.
  The difference from Leaflet's `6,371,000 m` is tested explicitly.
- Metric circles use the local scale at their center latitude. Pixel circles
  use the point layer's `radiusPx` style.

## Identity

- A feature key is `namespace + '\0' + typeof id + ':' + String(id)`.
  Numeric `42` and string `'42'` identify different features.
- Generations increase monotonically throughout the source's lifetime.
  Removing and recreating an ID increases its generation; compaction does not
  reset generations.
- Omitted IDs become strings `auto:<n>`, using a deterministic per-source
  counter. They never collide with numeric IDs.
- Removing a source used by a layer, relation or binding fails with
  `dependency-conflict`. `cascade` removes dependents and their GPU data.

## Writes and transactions

- `update` replaces geometry as a whole and merges properties by key.
  A property value of `undefined` deletes that key; arrays are not deep-merged.
- `map.batch` publishes one logical revision. Nested batches join the outer
  transaction, without independent commits or rollback points.
- Async batch callbacks are rejected by types and at runtime
  (`invalid-argument`). Writes after the callback belong to a new transaction.
- Validation, ownership or binding-evaluation failure rolls back the entire
  transaction. A write outside a batch is its own implicit transaction.
- Each successful commit increments the scene revision. Rendered revision never
  exceeds logical revision; `whenRendered(r)` resolves when `rendered ≥ r`.
- User geometry always goes through the canonical validation/normalization
  kernel: object CRUD uses `prepareGeometry`; columnar imports share that kernel
  over projected Float64 pools. Prepared geometry enters only through internal
  bindings, tiles or validated import jobs, never by detecting public object keys
  such as `bbox` or `payload`.

## Missing inputs, deletion and ownership

- Relation endpoint deletion defaults to `reject`. Alternatives are
  `remove-relation` and `keep-missing`. The latter retains the original
  generation and never redirects to a new feature with the same ID.
- Binding `onMissing` defaults to `reject`; `retain` keeps the last result,
  while `hide` excludes the target from rendering and picking but not data queries.
- A binding owns its target geometry or property key. Manual writes to an owned
  field fail with `ownership-conflict` until the binding is removed or changed.

## Style, ordering and visibility

- Style order is layer base → property/zoom expression → per-feature override
  (`object.setStyle` / `layer.setFeatureStyle`) → interaction style.
- Interaction styles read `style.state('hovered' | 'selected' | 'disabled')`.
  Hover writes `state.hovered`; selection writes `state.selected`.
- Hiding uses an override `visible: false`, a filter or a binding; it never
  deletes source data.
- Equal `zIndex` values use ascending stable slot order. Layers follow their
  logical layer tree order; earlier siblings draw underneath later ones.
- A logical layer contains any geometry/media collections and nested layers.
  Direct map object helpers share a lazy `base` layer. Typed collections retain
  their own sources/styles; hiding or removing an ancestor affects its subtree.
  `move({ index })` stays among current siblings; `move({ into: null })` moves
  to the root. The source/render-pass engine groups implement this public tree.
- Zoom visibility is inclusive: `[minZoom, maxZoom]`.
- Labels read an expression (default `properties.name`); empty or missing text
  is skipped. `\n` splits the text into a vertically centred multi-line block
  with a fixed line height (no automatic wrapping). Their anchor is the feature
  center plus `offsetPx`.
- Label collision uses bounding boxes: higher `priority` wins, with stable slot
  order for ties. Atlas pages use LRU eviction and can be reconstructed (limit 256).
- Image assets have `loading`, `ready` and `error` states. A point icon uses its
  ready asset or the declared shape fallback, never a silent empty symbol.
- Instances share one atlas region per image asset/version; multiple regions can
  share a texture page without changing painter order. Icon size is `iconSize` (square,
  CSS pixels), or natural size divided by DPR; center is offset by `iconAnchor`.
  Picking uses an alpha threshold of `0.5`.
- `iconTint` (default white) multiplies the atlas RGB per instance; its alpha
  combines with `opacity`. A per-feature tint is an appearance patch, not a
  layout rebuild. Only the ready sprite is tinted — the shape fallback of a
  loading/failed icon keeps `color`. Picking ignores the tint RGB; the
  `0.5` texture-alpha threshold and the combined alpha still decide.
- `stats().drawCalls` counts actual GPU submissions, not planned placements.
- Sprite `iconRotate` and label `rotate` are clockwise degrees. A sprite rotates
  around its declared anchor at the feature position, not its offset center.
  Labels rotate around their center (`anchor + offsetPx`). Shared `quadVertices`
  supplies draw/pick geometry; label collision uses the rotated quad's AABB.
  Point shapes and icon shape fallbacks do not rotate.

## GPU backends

- Profiles are WebGPU, WebGL 1 with extensions, and WebGL 1 without
  `ANGLE_instanced_arrays`/uint-index/VAO, with mediump fragments. E2E `--basic`
  forces the third profile using an API patch; parity checks confirm the active
  profile through `capabilities().notes`.
- WebGPU is the primary option and WebGL 1 the configurable fallback. Backend
  creation is async because adapter/device acquisition is async.
- Both backends render the same frame plan and use equivalent shader logic and
  pick encoding. Vectors, labels and sprites use straight-alpha blending
  (`src-alpha`/`one-minus-src-alpha`); raster uses premultiplied-alpha blending
  (`one`/`one-minus-src-alpha`). The WebGPU canvas uses premultiplied alpha.
- WebGPU writes draw data to separate offsets in a paged ring buffer, with
  dynamic uniform offsets. Buffers retire after submission, so a later upload
  never overwrites data referenced by an earlier encoded draw.
- Picking and `debug.samplePixel` read an offscreen texture. BGRA is normalized
  to RGBA. Both backends use top-left coordinates (GL row `height - 1 - y`).
- Device/context loss replaces the internal canvas and backend: try the same
  backend first, then the configured fallback. Rendering pauses during recovery.
  `SwappableBackend` preserves the public handle; the scene retains identities,
  generations, view, selection, state and bindings.
- If both attempts fail, `capabilities().backend` becomes `unavailable`, a
  `backend` event reports failure, and GPU queries fail with `gpu-unavailable`.
  There is no retry loop or false success. `debug.forceBackendLoss()` uses the
  same recovery path as real loss.

## Picking and interaction

- Picking respects rendered shapes, holes, dash gaps and interaction flags.
  Results carry `renderedRevision`; identity and generation are checked before use.
- The pick search radius is 2 device pixels; `query.at` defaults to 4 CSS pixels.
- `stats().picking` reports `picks`, `lastMs`/`maxMs` (synchronous blocking
  section), `lastReadMs`/`maxReadMs` (blocking readback), `totalMs` and
  `readback: 'blocking' | 'async' | 'none'`.
- Backends measure stalls at the call site with `performance.now()`. WebGL 1
  `readPixels` blocks despite the async API. WebGPU `mapAsync` waits asynchronously;
  only the synchronous section before the first `await` counts as a stall.
- Feature dragging starts at 4 CSS pixels; below that threshold it is a click.
  Dragging a feature does not simultaneously pan the map.
- Drag position is initial feature position plus pointer displacement from
  pointer-down, never a repeated addition to the already-moved position.
- Cursor is `move` over draggable features, `pointer` over other interactive
  features, `grab` otherwise and `grabbing` during a map gesture.
- Feature events bubble `object/collection → logical layers (nearest first) → map`.
  `stopPropagation()` stops this chain without changing gesture handling.
- Each pinch starts with its own baseline distance. Lifting one finger continues
  as a pan without jumping.
- Keyboard handling does not steal input from `INPUT`, `TEXTAREA` or `contenteditable`.
- `interaction.setGestureGate(gate)` filters view-affecting gestures
  (`pan`, `pinch`, `wheel`, `doubleClick`, `featureDrag`) without stopping the
  pointer state machine: a blocked pan keeps its reference point, a blocked
  pinch drops its baselines, a blocked drag emits no drag events but suppresses
  the follow-up click, and a blocked wheel is not prevented so the page keeps
  scrolling (INPUT-09).

## Built-in plugins

- `gestureGuard(options)` installs an INPUT-09 gate: touch gestures need
  `touchPointers` fingers (default 2), mouse/pen gestures need the configured
  modifier (default Alt), and the container keeps `touch-action: pan-y` so a
  one-finger drag scrolls the page. `unlock()`/`lock()` override the gate from
  application UI, and removal restores the previous `touch-action` and clears
  the gate.
- `fullscreenMode(options)` toggles the container (or an explicit `target`)
  through the Fullscreen API. State follows `fullscreenchange`, including
  browser-initiated exits; `enter`/`exit`/`toggle` resolve a boolean instead of
  pretending success; the optional corner button mirrors the state; removing
  the plugin exits fullscreen and removes the button and listener. The map
  resizes through its own container observer.

## Raster and WMS

- Tile zoom is `floor(zoom) + (retina ? 1 : 0)`, clamped to
  `[minZoom, min(maxZoom, nativeZoom)]`. TMS flips `y` within the grid.
- World wrapping repeats tile identities; without wrapping, requests stay in-grid.
- WMS version/CRS determine `SRS` versus `CRS` and BBOX axis order:
  1.1.1 uses lng/lat, 1.3.0 EPSG:4326 uses lat/lng, CRS:84 uses lng/lat.
  BBOX units depend on the CRS, not the version. EPSG:3857 uses true spherical
  Mercator meters in both versions. Requests never send both `SRS` and `CRS`.
- One GetMap request covers the viewport, with width/height rounded to multiples
  of 256. URL keys the cache. A parameter change retains the previous bitmap
  until the replacement loads; late superseded responses never replace it.
- Interactive raster sources expose one pick record with the source ID for the
  displayed rectangle, not IDs invented from pixels. Tile basemaps require
  explicit `interactive: true`; media follows layer defaults.

## Vector tiles (MVT)

- Sources are viewport-driven and read-only. Edits belong to a separate mutable
  overlay source, never the original tile bytes.
- Namespace is the MVT source-layer name. Equal IDs in `roads` and `buildings`
  remain distinct. Unsafe uint64 IDs are exact decimal strings.
- Features without provider IDs have tile-local identities
  (`tl:z/x/y:index#seq`), valid only while the tile is loaded. Reload creates a
  new identity and does not restore its state.
- One logical feature occupies one store record, combining loaded fragments.
  Selection and state cannot diverge across those fragments.
- Leaving the viewport removes fragments and eventually the record. Reloaded
  records have new generations (old refs are stale); stable-ID state is restored.
- Tile zoom is `clamp(floor(viewZoom), minZoom, maxZoom)` (default max 14).
  Above `maxZoom`, world geometry scales with the view without deeper requests.
- Requests cover the exact viewport, without padding; default `maxParallel` is
  4 and `maxTiles` is a hard limit of 128. Excess work is reported as `deferred`.
- Late retired-tile responses are discarded. Network/decode failures count as
  `failed`; retry follows eviction and return. Invalid bytes or extreme vertex
  offsets fail with `import-invalid`, never partially decoded geometry.
- Strings/floats/doubles/bools retain their values. int64/uint64/sint64 values
  use safe numbers or exact decimal strings. Polygon rings use signed area
  (positive exterior), falling back to the largest ring for reversed exteriors.
- `map.addLayer({ namespace })` selects a source layer; omission selects all
  records. Counts and box selection also honor namespaces.
- Attribution includes each source used by a layer, deduplicating exact strings.
- Viewport sources receive every `requestFrame()` notification, even when a
  frame is already pending; they deduplicate their own reconciliation microtask.

## Images and video

- `map.addImage({ url | pixels, bounds })` and
  `map.addVideo({ url, bounds, loop })` place data in a geographic or planar
  rectangle (`southwest`/`northeast`). Raster layers provide opacity and order.
  Raw `pixels` are copied RGBA data.
- Descriptor changes (image URL, bounds) increment `revision` and rebuild the
  scene plan. Pixel changes (decode, `updateRegion`, video frames) increment
  `pixelVersion` and request a frame without rebuilding the plan.
- Load failures expose `error` and retain the last decoded pixels.
- `updateRegion(region, pixels, { stride })` validates bounds, stride and buffer
  length before writing (`invalid-region`). Uploads are partial, with
  premultiplied rows: `texSubImage2D` or `writeTexture` with `origin`.
- `rotate` turns a media placement clockwise about its bounds centre (degrees,
  the convention shared with sprite and label rotation). It is a descriptor
  change: `revision` bumps and the plan re-places the turned quad, while pixels
  and `pixelVersion` are untouched. Picking and culling use the turned quad
  (MEDIA-07).
- Video uses `requestVideoFrameCallback` (rAF fallback) only while playing.
  `pause()` uploads the final frame once and stops the pump. Remove/destroy
  releases the video and textures and ignores late frames. Only images support
  runtime URL changes.
- Each media source has one pick record (its source ID) for the whole quad,
  with normal event bubbling. Feature dragging applies only to vector sources.

## Snapshots, events and export

- `subscribe` delivers an initial snapshot synchronously (`initial: true`).
  Later events carry revision and change summaries (ID samples up to 4096,
  counts thereafter).
- Subscription cancellation is idempotent; an already-aborted `AbortSignal`
  creates no listener.
- Event emission iterates a listener snapshot; listeners added during an
  emission do not receive that emission.
- Export returns canonical geometry, not clipped fragments. Geographic numeric
  round trips tolerate `1e-9` degrees, not bit identity. This alpha does not
  preserve line/polygon altitude.
- `query.area` cursors contain offset and revision; a changed revision causes
  `invalid-state`, never silently mixed snapshots.

## GeoJSON and columnar imports

- Columnar `positions` contains flat `x, y` pairs (x = longitude or planar x).
  `point` maps each vertex to a feature. `lineString`/`polygon` use `partOffsets`
  and `featurePartOffsets`; without the latter, each part is one feature.
  A polygon feature has one exterior part followed by holes.
- `altitudes` (geographic only, `NaN` = absent), `ids` and `properties` are
  indexed by feature.
- The entire structure is validated before the first vertex is read: array
  types, lengths, monotonic offsets and bounds. Failure is `import-invalid`.
  The store owns prepared copies, not caller data.
- The worker only prepares features through the shared `prepareImport` function.
  Publication (`replace`/`append`) always runs as a main-thread store transaction.
- Default `copy: true` preserves caller buffers. `copy: false` transfers unique
  `ArrayBuffer`s and detaches their views; without a worker it behaves as a copy.
  `SharedArrayBuffer` is not required.
- The queue allows 4 waiting tasks plus 1 active task. Overflow rejects with
  `aborted`, `{ reason: 'queue-full' }`. Cancellation rejects the Promise and
  discards late responses using `requestId`.
- Worker crashes or invalid messages fail the active task with `worker-failed`
  and permanently switch to inline preparation. Errors carry logical revision;
  `map.debug.imports()` reports backend, pending work and preparation counts.
- Under Chromium CSP `worker-src 'none'`, Worker construction can succeed before
  loading fails asynchronously. The first task explicitly fails `worker-failed`;
  subsequent tasks run inline. A bundler that fails to preserve/rewrite the
  worker URL can produce the same failure path; partial publication is never success.

## Lifecycle and measurement

- The E2E runner enables exposed GC and precise memory reporting. Soak checks
  use GC-stabilized heap deltas: 12 create/destroy cycles below 8 MB; residual
  memory after destroying the large map below 96 MB and below 0.6× store size.
  Manual runs without GC use a looser, explicitly labeled sanity bound.
- Headless compositor warm-up can delay initial frames. Lifecycle checks assert
  liveness and report cadence; they do not establish reference performance.
  The runner supplies anti-throttling flags.
- The runner reads the server marker from `demo/serve.py`, rather than keeping
  a separate constant, to reject stale servers reliably.
- The 500,000-point demo reports generation, worker import, first-render and
  pan p50/p95 timings for the current machine. It is not a reference benchmark.

## HTML controls, detail and geolocation

- Controls are opt-in. Their overlay/subscriptions are created with the first
  control and removed with the last. Controls read `commit`/`viewchange` and call
  the public API; they do not maintain a second model.
- Layer controls show root entries in painter order and update rows in place to
  keep focus. Nested content is controlled through its root logical layer.
- Attribution uses sources with at least one layer, registration order and exact
  string deduplication. Shared notices remain while any contributing source exists.
  Attribution strings render as text, never active HTML.
- Geographic scale uses `156543.034 × cos(latitude) / 2^zoom` meters per pixel,
  with 1/2/5 × 10ⁿ steps up to 100 px. Planar scale uses CRS units labeled `u`.
- Geolocation returns `ok`, `permission`, `timeout`, `unavailable` or
  `unsupported`. Watch cancellation/map destruction ignores late callbacks.
  `setView` applies only to geographic projections.
- `detail.open` binds to a reference generation, updates on commit/viewchange,
  and follows a representative geometry position. Removal closes it by default
  (`close`) or freezes it with a marker (`retain`); a new generation never appears.
- Detail strings render as text. An explicit `Node` from the content factory is
  attached under the caller's DOM contract; factory errors show safe text.
- Accessible lists are bounded (default 10, maximum 50), drawn from the current
  view, with keyboard-operable buttons, selection mirrored by `aria-pressed`
  and changes announced through `aria-live`; no DOM button per source feature.
- Control/detail overlays must receive hit tests and contain their own gestures.
  Set `pointer-events: auto` after content construction; pointer/wheel input
  must not fall through to map gestures. Tests use hit testing and real input,
  not just programmatic `.click()`.

## Markers

- `addMarker(options)` / `addMarkers(options[])` add Leaflet-style pins. A marker
  is one point feature in a shared internal points layer drawn as a GPU sprite:
  there is no DOM element per marker. The built-in pin asset is registered with
  the marker layer; `icon`, `iconSize`, `iconAnchor` and `iconTint` override it
  per marker (per-feature `icon`/`iconSize`/`iconAnchor` overrides work for every
  points layer, MEDIA-07/08 shape fallback included).
- Tooltips default to hover and support `permanent`. At most one hover tooltip
  exists at a time; each permanent tooltip owns one element per marker while
  bound. `setTooltip(null)` unbinds it and an open tooltip updates in place;
  `openTooltip()` opens a sticky tooltip that survives `mouseout` until
  `closeTooltip()`.
- One popup per map at a time: a marker click or `openPopup()` opens it, its close
  button, a background click, `closePopup()` or marker removal closes it.
  `autoPan` (default true) shifts the view by the minimum amount that keeps the
  popup and its anchor inside the container with an 8 px margin; the anchor clamp
  wins, so a popup larger than the viewport overflows instead.
- Overlays are re-placed from the marker's current screen position on every
  `commit`/`viewchange`, clamped horizontally for tooltips, and removed on marker
  removal, unbinding (`setPopup(null)`/`setTooltip(null)`) or map destroy. A
  static container receives `position: relative` once, like Leaflet's stylesheet.
- Content follows the UI-06 contract: a string renders as text, a `Node` renders
  as-is. Marker dragging, keyboard focus on pins and clustering are not part of
  this alpha; pins pick and emit feature events like any interactive point.

## Fonts and text

- `assets.addFont({ id, family, src })` accepts a URL or CSS `local(...)`/`url(...)`
  source. `FontFace` enters `document.fonts` only after successful loading;
  `loading`/`ready`/`error` remain observable. Removal/destroy removes the family.
- Labels use platform fallback while loading. Atlas keys include
  `family|direction|fontSignature`; ready/error publishes a revision and
  remeasures text, rather than reusing stale raster data.
- `direction: 'ltr' | 'rtl' | 'auto'` defaults to `ltr`. Canvas direction and
  `textAlign: 'left'` govern rasterization; `auto` uses the first strong character.
- Platform Canvas2D handles shaping, ligatures, kerning and combining marks.
  A custom font parser/GSUB/GPOS shaper is outside the alpha scope.
- The fixed Roboto subset tests fi/fl/ffi ligatures against ZWNJ controls and
  AV kerning. Layout uses measured advance and rasterizes entire text runs;
  a run splits on `\n` into lines with a fixed line height and no automatic
  wrapping. Cross-browser/OS text pixel identity is not promised.

## Distribution and types

- `dist/` contains ESM, declarations, source maps and `workers/import.worker.js`.
  Exports cover the root, `./math` and `./formats`, with runtime and type targets.
- `test/publish/pack.test.ts` audits `npm pack --dry-run`: include runtime assets,
  README, NOTICE, LICENSE and CHANGELOG, exclude development directories, verify
  export targets and relative imports in emitted JavaScript.
- Types are checked against both source and published declarations. `check`
  builds first so consumer tests see current output.
- TypeScript rewrites relative `.ts` extensions in emitted JavaScript; the build
  script also rewrites declaration imports to `.js` and rejects leftovers.
- `@ts-expect-error` cases are contractual: unused directives fail type checking.

## Environment

- `renderer.primary: 'none'` requires neither DOM nor GPU; it is for logical
  tests and SSR, never evidence of rendering.
- Outside a browser, creation without `'none'` fails with `environment`.
  Unavailable GPU backends fail with `gpu-unavailable` subject to the configured
  fallback; capabilities report the actual backend.
- An idle map does not render continuously. Data, style, view changes and
  pending work request frames.
