# Retained scene rebuild — work record

Contract: implement the binary/retained-scene analysis across points, complex
geometry, sprites, text and picking. Preserve the public contracts in
`docs/decisions.md`, complete geometry, individual interactions and all README
features. No implicit LOD, clustering, reduced counts, disabled validation or
changes to the existing benchmark evaluator. No new runtime dependency.

Baseline: `315c5c8`; isolated compiled source under
`/private/var/folders/7s/v15d0wv93w58mbg5sdfdjkk40000gn/T/opencode/maplet-scene-baseline-9jmodith`.
Baseline `npm run check` passes. Previous browser/performance records remain
historical, not proof for this rebuild.

## Requirement-to-proof ledger

| Requirement | Implementation/check | Status |
| --- | --- | --- |
| Binary columnar import without per-vertex object expansion; bounded worker jobs and owned metadata | `test/io/parts.test.ts`, worker metadata/count/kind/schema tests; actual worker import/CSP/complex-scene checks. Custom CRS retains normalize/toWorld callbacks and altitude inputs | pass |
| Page-backed canonical data and atomic publication; stable identities, generations, slot order, rollback, relations/bindings | Page boundary/altitude/undo tests; existing data/import/relation/binding suites; queued-abort and retained-handle destruction regressions, including hidden-group resident cleanup | pass |
| Correct large polygon topology and reusable indexed tessellation | Independent concave/multi-hole and outside/touching/overlapping/nested-hole coverage checks; validation/tessellation of a 20k ring; actual pixels/picking of a 70k ring, including uint-index-free WebGL | pass |
| Retained buffers for mixed sources, lines, fills and points; local style/state updates | Fresh-plan differentials and actual GPU instrumentation: camera-only updates upload no vector/symbol data; fill color edits upload one feature range without tessellation | pass |
| Camera transforms, visibility/culling, large objects and precision | Existing view/parity tests; spatial selection of a 100k-segment line; Float64 clipping of long segments/large triangles. Canonical export remains complete | pass |
| Shared atlases and retained sprites/text; bounded layout work | Label/icon/font/media/loss/soak batteries; collision grid vs a 10k-box oracle; page runs keep painter order. Actual symbol appearance edits upload only their quads without atlas upload; text/size/priority changes rerun layout | pass |
| Exact picking and visible-label agreement, generation/revision safety | Actual shape/cap/dash/hole/transparent-icon/zero-opacity/collision-winner queries; existing pick and real-input suites on all profiles | pass |
| Demonstrable performance gains and measured memory/lifecycle costs | [Final raw record](retained-scene-ab.json): 24 isolated alternating point/mixed A/B runs pass; dense candidate passes on all profiles. Two dense baseline attempts time out at 120 s, without inferred stage timings or ratios. Point setup medians improve; mixed pan/edits, heap and GPU allocation improve. Point heap increases 3.3 MiB explicitly | pass for measured fixtures |
| Final artifact consistency | `npm run check`: 248/248 tests and build/source/test/consumer type/distribution checks. Final repeat after hidden-group cleanup: 36/36 browser scenarios per GPU profile and 180/180 mutation samples. Recorded compiled JS fingerprint matches the current final build; existing evaluators match `315c5c8` | pass |

## Construction decisions

- Main thread remains authoritative for synchronous API reads, transactions,
  ownership checks and bindings. Workers prepare geometry, not a second scene.
- Canonical coordinates retain Float64 precision. Render storage is derived,
  local-origin and capability-aware; it does not replace exported geometry.
- Geometry, style, state, layout and view invalidations are separate. A change
  to appearance must not retessellate unaffected geometry.
- Regular polygon topology uses a strict-TypeScript adaptation of Earcut 3.0.2
  (ISC notice preserved in `NOTICE`), not a new package dependency. Previously
  accepted touching/outside/overlapping clipping holes retain the subtraction
  path. Both results are cached by canonical geometry identity.
- Initial and queued work preserve copy/move, cancellation, ordering and error
  semantics. Property graphs are owned but do not make unnecessary round trips.
- Spatial/render chunks preserve logical feature identity, topology, dash phase
  and painter order. Shader/backend choices may differ without differing API
  behavior. Basic WebGL remains supported.
- Timing claims require uninstrumented repeated comparisons; diagnostics prove
  mechanism only. Count, metadata, projection, visible pixels and interactions
  must pass independently of candidate timings.

## Deliberate limits

- Retained rendering is not a zero-cost mutation API: a complex feature's
  per-vertex attribute change still processes its visible vertices. Geometry
  size, order and resident-set changes can rebuild derived buffers safely.
- Symbol color/opacity/interactivity edits are local when layout is unchanged.
  Text, dimensions, visibility, geometry and priority changes rebuild that
  layer's placement/collision layout; mixed icon/fallback layers also rebuild.
  Canvas2D remains the shaping oracle, not a custom font parser/shaper.
- GeoJSON remains the compatible object-input path. Binary columnar line/polygon
  imports no longer expand each vertex into an intermediate Position/FeatureInput
  tree. Arbitrary custom CRS callbacks remain on the publishing thread.
- Properties are owned JS graphs. IDs and geometry descriptors are not forced
  into numeric arrays; canonical anchors/coordinates, part offsets and render
  meshes are typed. This is not a claim that every scene field is binary.
- Browser evidence covers installed Chromium/Metal and forced basic WebGL, not
  every browser/GPU or a physical touch device. Spatial hierarchies prune typical
  geometry; adversarial overlapping bounds can still require quadratic
  intersection work. Validation is never skipped to avoid that cost.

The final evidence is scoped to these fixtures and profiles, not a promise that
every workload improves or every browser/device is covered. The numerical
results, hashes, individual runs, timeouts and lifecycle checks are preserved in
`retained-scene-ab.json`; the plan alone is not proof.

Final lifecycle repair: `frame-plan-lifecycle.test.ts` initially rejected the
candidate because hidden groups retained their point/vector/symbol caches.
Cleanup now enumerates all layers, not only render-visible group descendants;
the regression passes without changing its assertion or publishing an unrelated
visibility invalidation that could mask the omission.

## Canvas-level initialization follow-up

User target: initialize the complete 500,000-point comparison scene at Leaflet
Canvas speed, including map creation, generation, import/publication and first
paint opportunity. Import alone is not the acceptance metric. The existing
fixture, evaluator, counts, validation and individual interactions stay unchanged.

- Freeze the current retained rewrite as the immediate baseline, not `315c5c8`.
- Measure fresh Canvas and both GPU controls; profile initialization separately
  from the uninstrumented timings before selecting an implementation change.
- Recheck ownership, custom CRS/altitude, rollback/generations, first-frame
  ordering/picking and the existing browser/mutation suites after changes.
- Final timing: 315 ms WebGL 1 / 275 ms WebGPU versus 287 ms Canvas. Comparable
  on this fixture, not exact parity: WebGL remains 9.8% slower; one WebGPU run
  also exceeds Canvas. All 15 alternating setup/pan processes pass.

Profile-guided implementation:

- Copy validated primitive IDs directly; keep native structured cloning for
  complete property graphs, including aliases, cycles and platform values.
- Use one identity lookup plus parallel live-slot/generation columns instead of
  two string-keyed maps. Retired identities and consumed rollback generations
  remain authoritative; physical slot reuse does not change identity.
- Project unmodified native CRS columns directly and adopt that owned Float64
  pool as canonical pages, rather than allocating a second coordinate pool.
  Custom/modified CRS retain the checked normalize/toWorld path and altitudes.
- Reject off-rectangle points before materializing object views. Keep immutable
  pick identity columns and construct refs on lookup, not for every first-frame
  instance; stale plans never read identities from recycled live rows.
- Write point attributes directly without one temporary 16-element array per
  instance. Rendering, painter ordering, filters and binding visibility remain
  enabled. No implicit LOD, clustering or count changes.

Current source/build/unit/consumer checks pass 253 tests. Full browser checks pass
36/36 scenarios per GPU profile; mixed/dense fixtures pass on all three profiles.
Final mutation checks pass 180/180 samples across nine fresh processes, retaining
all 500,000 records. Final build and unchanged-evaluator hashes match the archived
record. The remaining gap is exact WebGL/Canvas timing parity, not a failed
correctness check; no universal performance or hitch-free-pan claim is made.
