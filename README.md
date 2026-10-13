# Maplet

[GitHub](https://github.com/Fir3st/maplet) ·
[Issues](https://github.com/Fir3st/maplet/issues) ·
[Apache-2.0](LICENSE)

**Maplet is a new, independent mapping library for the browser, inspired by
[Leaflet](https://leafletjs.com).** It renders maps on the GPU using WebGPU or
WebGL 1, with its own API and data model for sources, layers, feature identities,
transactions, relations and bindings.

Maplet is not a Leaflet plugin or a drop-in replacement, and has no runtime
dependency on Leaflet. Some coordinate calculations derive from Leaflet;
their attribution and license are included in [NOTICE](NOTICE).

> **Alpha: `0.1.0-alpha.3`.** The API is still evolving. See
> [implementation status](docs/status.md) for known limitations and the scope of
> testing. Development-machine timings are not reference benchmarks.

## Why Maplet exists

Leaflet inspired Maplet because it makes working with maps straightforward.
I wanted that approachable experience for maps where thousands of objects are
not just displayed, but continually change: points move, change color, appear
or disappear, react to selection, and update the geometry connected to them.
The goal is **rich, individually controllable map objects together with fast
GPU rendering**, designed in TypeScript from the start.

### Why Leaflet + PixiJS is a useful model

Leaflet handles the map; PixiJS handles a scene of graphical objects. That
combination is useful when an application needs many changing icons or sprites,
not just a static collection of dots:

- **Objects with persistent visual state.** A PixiJS sprite has position,
  visibility, tint, scale and rotation. Applications can change those properties
  directly instead of treating each update as a new drawing command.
- **Batched GPU rendering and shared textures.** Many sprites can reuse a
  texture or spritesheet and be rendered in batches, without an HTML element
  for every marker. This is a useful foundation for dense, dynamic symbol layers.
- **A scene graph for coordinated changes.** Containers let applications move,
  scale or organize related graphics together. Animated symbols and richer
  visual effects fit this model naturally.
- **A bridge between map and graphics coordinates.** Leaflet.PixiOverlay
  connects PixiJS to Leaflet's view and supports scaling projected geometry
  during zoom rather than reprojecting every object.

Canvas can also support changing visibility, color and position. Leaflet's
Canvas renderer already supplies mutable vector objects, events and partial
redraws. The distinction is therefore **not “Canvas is static, PixiJS is
interactive”**: it is the GPU-oriented sprite scene, its rendering capabilities
and the workflow it offers for many changing graphical objects. Nor does GPU
rendering automatically solve pointer hit testing or make every workload faster.

These capabilities are documented in [Leaflet.PixiOverlay](https://github.com/manubb/Leaflet.PixiOverlay)
and the [PixiJS scene-object](https://pixijs.com/8.x/guides/components/scene-objects)
and [batching documentation](https://pixijs.com/8.x/guides/concepts/performance-tips).
They explain the architectural motivation, not a measured claim that every
developer prefers PixiJS or that Maplet already outperforms it.

### What Maplet aims to bring together

Maplet targets the same need for dynamic GPU-rendered objects, but as a
standalone mapping library rather than a graphics overlay attached to Leaflet.
Map coordinates, rendering, feature identity, visual state and data updates
belong to one API. A point can change position or appearance while keeping its
identity, and a connected line can follow it through a computed binding.

The intended benefit is not merely drawing more dots: it is making **large,
changing, interconnected maps practical to build and maintain**, without
assembling a separate map engine, rendering overlay and application-specific
synchronization layer. That direction shapes the implementation:

- **TypeScript from the start.** Leaflet 1.9.x is written in JavaScript;
  TypeScript applications generally use separately maintained `@types/leaflet`
  declarations. Maplet is written in TypeScript and ships declarations generated
  from its implementation, with typed sources, feature references, expressions
  and events forming part of the API design.
- **No DOM element per marker.** Standard Leaflet markers use HTML image or div
  elements, with additional elements for shadows or permanent tooltips when
  enabled. With thousands of markers, managing and updating those elements can
  become a significant memory and rendering cost. Maplet batches points and
  image sprites into GPU draws rather than creating a DOM element for each one.
  Labels are rendered through texture atlases as well.
- **A GPU rendering pipeline.** Leaflet supports SVG and Canvas renderers for
  vector paths, and Canvas circle markers can avoid per-point DOM elements;
  plugins also offer alternative marker renderers. Maplet instead makes GPU
  rendering the core architecture, using WebGPU or WebGL for tiles, vectors,
  sprites, labels and picking rather than adding a separate rendering plugin.
- **SVG tiles in the same pipeline.** Maplet accepts SVG tile images alongside
  PNG and JPEG: the browser decodes them and the renderer draws them as GPU
  textures. Leaflet can also display SVG URLs as image tiles, so SVG support
  alone is not the distinction. The goal here is a shared GPU pipeline—not
  resolution-independent rendering of SVG paths on the GPU.
- **Data that stays connected.** Dense, interactive maps need more than drawing
  markers. Maplet separates sources from layers and provides stable identities,
  atomic updates, relations and computed bindings, so moving a point can update
  its connected geometry in the same transaction.

This is not a claim that Leaflet is slow for every map or that GPU rendering
removes every bottleneck. Leaflet remains a good fit for many applications.
Maplet explores a TypeScript-first, GPU-based alternative for data-heavy maps;
the [500,000-point example](demo/scale.html) exposes measured timings, while
[implementation status](docs/status.md) documents the remaining limits.

### Measured scale, not just architectural claims

The alpha has been checked with **500,000 points**: Maplet submits **258,420
planned point instances in one GPU draw call**, including its culling margin,
without per-point DOM markers. **180 visibility, color and position changes**
passed pixel and data-retention checks across Maplet and the Leaflet Canvas
comparison. These are demonstrated capabilities, not proof of a general speed
advantage or a complete benchmark of animated, sprite-heavy maps.

The retained-point revision removes repeated point planning and uploads: small
pan changes shader uniforms, and an individual edit uploads **64 bytes** (432
bytes without instancing). On the matched 500,000-circle workload, warmed small
pan measured **16.7 ms versus Leaflet Canvas's 137.1 ms**—an **8.2× shorter
interval**. Visibility/color/position paint fences fell from 162.5–178.8 ms to
23.5–30.4 ms, versus Canvas's 33.2–33.3 ms; all 180 mutation checks passed.

Fresh columnar point imports now build the initial store off-scene and adopt it
atomically, without per-feature CRUD/undo. An alternating three-run A/B check
against `40e22ed` measured **606 → 449 ms for WebGL 1** and **598 → 444 ms for
WebGPU**: **25.9% and 25.8% shorter setup**. Import alone fell from 518 → 366 ms
and 516 → 363 ms, about **30% shorter**. Every paired run improved, but these
are local medians, not universal guarantees. Existing datasets retain their
normal mutation path and identity/ownership checks.
Setup remains slower than Canvas's 282 ms. Maplet's
main-thread JS heap increase after GC is 138.7 MiB versus Canvas's 207 MiB, about 33% less,
but 9% above pre-retention Maplet. Headless scheduling still produced occasional
one-second pan intervals. These are local measurements, not smooth-playback or
all-workload guarantees; that revision did not yet retain icons/complex geometry.
See [methodology, before/after records and limitations](docs/benchmarks/README.md).
PixiJS itself has not been benchmarked.

The subsequent retained-scene rebuild extends retained GPU data to mixed vector
sources, indexed polygon meshes, sprites and shaped text. Columnar lines and
polygons prepare canonical Float64 pools without per-vertex object expansion;
shared image/text atlas pages preserve individual identity, ordering and picking.
See the [implementation and proof ledger](docs/benchmarks/retained-scene-plan.md)
for verified paths and deliberate limits. Geometry edits, collision-layout changes
and required validation still have costs.
Its [final A/B record](docs/benchmarks/retained-scene-ab.json) shows point setup
medians of **465 → 405 ms / 458 → 326 ms** (WebGL 1/WebGPU) against `315c5c8`, and
mixed-scene pan of approximately **57 → 17 ms**, with draw calls **2070 → 5**.
Point heap rises 3.3 MiB; the mixed scene uses less heap/GPU storage. The final
checks pass 248 unit tests, 36 browser scenarios per GPU profile and 180 mutation
samples. This does not establish hitch-free point pan or universal device support.

The latest [Canvas-target follow-up](docs/benchmarks/README.md#canvas-target-initialization-follow-up)
measures complete 500,000-point initialization at **315 ms WebGL 1 / 275 ms
WebGPU versus 287 ms Leaflet Canvas**, using three fresh runs and the unchanged
fixture. WebGL is still 9.8% slower; WebGPU's median is 4.2% faster, with one
slower individual run. Initialization is comparable on this workload, not proven
identical or universally faster. Main-thread heap deltas fall from 142 MiB to
127.3–127.4 MiB; all records and individual interactions remain present.

Reproduce the existing measurements with an installed Chromium browser:

```bash
npm run build
python3 demo/compare.py --no-dom --output docs/benchmarks/points-500k-local.json
python3 demo/compare.py --updates --no-dom --output docs/benchmarks/points-500k-updates-local.json
```

## Features

- **GPU rendering:** WebGPU with a configurable WebGL 1 fallback, a shared frame
  plan, GPU picking and recovery after device or context loss.
- **Vector layers:** points, lines, polygon fills with holes and labels;
  expression-based styles, filters, feature overrides and nested layer groups.
- **Raster sources:** XYZ/TMS/retina tiles and WMS, cached loading, parent/child
  tile fallback and retention of the previous bitmap while a replacement loads.
- **Vector tiles:** dependency-free MVT decoding, source-layer namespaces,
  identities shared across tile fragments and overzooming above the source limit.
- **Stable feature references:** scene, source, namespace, ID and generation;
  numeric and string IDs remain distinct, and old references never resolve to a
  newly created feature with the same ID.
- **Transactions:** atomic batches with rollback, separate logical and rendered
  revisions, and `whenRendered()` to wait for a revision to reach the screen.
- **Relations and bindings:** typed many-to-many relations, bounded traversal,
  and `lineBetween`, `anchorOnLine` and `copyProperty` bindings updated in the
  same transaction as their inputs.
- **Import/export:** GeoJSON and columnar typed-array imports, with worker
  preparation, explicit copy/move semantics, cancellation and a bounded queue.
- **Text and media:** GPU-rendered labels, font registration, collision handling,
  image sprites, bounded image/video overlays and partial pixel updates.
- **Interaction:** pan, wheel zoom, pinch, keyboard navigation, hover, click,
  feature dragging, box selection and events bubbling through layers and groups.
- **Optional HTML UI:** zoom, layers, attribution, scale and accessible list
  controls, generation-bound feature details and typed geolocation results.
- **Function-based plugins:** typed plugin APIs, HTML access and scoped cleanup;
  shared render-plan transforms, custom drawing and replaceable renderers.
  See [creating and integrating plugins](docs/plugins.md) and the
  [interactive HTML example](demo/plugins.html).
- **Diagnostics:** capabilities, frame/draw-call/GPU-memory statistics, measured
  picking stalls and debugging tools.

## Quick start

The source checkout requires **Node.js 22 or later** and **Python 3** for the demo
server. The library has no runtime package dependencies; the TypeScript compiler
is a pinned development dependency.

```bash
npm ci --ignore-scripts                # install the pinned compiler
npm run check                         # build, type checks and unit tests
python3 demo/generate-tiles.py         # generate local PNG/SVG demo tiles
npm run demo                          # http://localhost:8400/demo/
```

The main demo uses WebGL 1 by default. Add `?backend=webgpu` to request WebGPU
with WebGL 1 fallback, or `?tiles=osm` to use live OpenStreetMap tiles. The
default local basemap works without a network connection once generated.

Give the map container a height before creating the map:

```html
<div id="map" style="height: 500px"></div>
```

```ts
import { createMap, crs, expr } from '@fir3st/maplet';

const map = await createMap({
  container: 'map',
  projection: crs.webMercator(),
  renderer: { primary: 'webgpu', fallback: 'webgl1' },
  view: { center: { lat: 50.08, lng: 14.44 }, zoom: 8 },
});

map.sources.rasterTiles({
  id: 'base',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
});
map.layers.add({ id: 'base', type: 'raster', source: 'base' });

const stations = map.sources.vector({ id: 'stations' });
await stations.features.replace([
  {
    id: 'prague',
    geometry: { type: 'point', position: { lat: 50.08, lng: 14.44 } },
    properties: { name: 'Prague', status: 'online' },
  },
]);

map.layers.add({
  id: 'stations',
  type: 'points',
  source: stations,
  interaction: { enabled: true, draggable: true },
  style: {
    radiusPx: 9,
    color: expr.match(expr.field('status'),
      { online: '#16a34a', offline: '#dc2626' }, '#6b7280'),
  },
});

map.on('feature', (event) => {
  if (event.type === 'click') console.log(event.feature.id, event.position);
});

map.controls.add({ kind: 'zoom' });
map.controls.add({ kind: 'scale' });
map.controls.add({ kind: 'attribution' });

// Release resources when the map is no longer needed.
// map.destroy();
```

The package specifier above is for a packaged or locally linked build; the
repository demos import `../dist/index.js` directly. The package is published as
`@fir3st/maplet` to GitHub Packages, not npmjs.com; `publishConfig.registry` selects
the GitHub npm registry.

### Builds and releases

Every push to `main` runs the build, type checks and unit tests in GitHub Actions
and stores an installable `.tgz` package as a workflow artifact for 14 days.
If `package.json`'s version differs from the version before the push, the workflow
publishes the tested archive to GitHub Packages, then creates a tag `v<version>`
at the tested commit and a GitHub Release with the same package attached and
automatically generated release notes. The initial push of
a new `main` branch also releases its version. Existing releases are not overwritten
on reruns. Alpha, beta and RC versions are marked as prereleases and published
with the npm dist-tag `next`; stable versions use `latest`. Registry errors fail
the workflow rather than silently skipping publication.

To publish the next alpha:

```bash
npm version prerelease --preid=alpha --no-git-tag-version
# Update CHANGELOG.md, then commit package.json, package-lock.json and the changelog.
git push origin main
```

Use `npm version patch --no-git-tag-version` (or `minor` / `major`) for a stable
release. Always choose a new version; reusing a published version does not update
its package. A code-only push without a version change builds but does not release.
Rerun a failed workflow in GitHub Actions to retry the same release. If publication
left an incomplete release or draft, delete that incomplete release in GitHub first;
the workflow refuses to silently overwrite it.

Download the `.tgz` asset from [GitHub Releases](https://github.com/Fir3st/maplet/releases)
and install it in a consuming project:

```bash
npm install ./fir3st-maplet-0.1.0-alpha.3.tgz
```

Alternatively, install from GitHub Packages after authenticating npm with GitHub
and granting package-read access:

```bash
npm install @fir3st/maplet@next --registry=https://npm.pkg.github.com
```

GitHub's npm registry requires authentication even for public packages. For
applications with dependencies from multiple registries, configure only the
`@fir3st` scope to use GitHub Packages rather than changing the default registry.
See [GitHub's installation guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#installing-a-package).
The release archive can still be downloaded and installed without npm registry
authentication.

No custom publishing credentials are needed: the workflow uses GitHub's built-in
authentication with `packages: write` for publishing and `contents: write` for
releases. New GitHub Packages are private by default; the owner can change the
package's visibility in its GitHub settings if public access is desired.

Follow each tile provider's usage policy and display its required attribution.
The OpenStreetMap standard layer is used live, not cached by the demo scripts.

## API overview

| Handle | Operations |
| --- | --- |
| `map.view` | `get`, `set`, `fit`, `flyTo`, `stop`, `zoomAround`, `resize`, coordinate conversions |
| `map.sources` | `vector`, `rasterTiles`, `wms`, `vectorTiles`, `image`, `video`, `get`, `list`, `remove` |
| `map.assets` | `addImage`, `addFont`, `get`, `list`, `remove` |
| `source.features` | `get`, `ref`, `has`, `add`, `update`, `updateMany`, `remove`, `replace`, `append`, `count`, `ids`, `each` (mutations only on mutable vector sources) |
| `source` | `importGeoJson`, `importColumnar`, `exportGeoJson`, `snapshot`, `getBounds`, `subscribe` (depending on source type) |
| `map.layers` | `add`, `get`, `list`, `update`, `remove`, `move`; feature overrides and feature events |
| `map.groups` | `add`, `get`, `list`, `remove`, `move`, `setVisible`, feature events |
| `map.relations` | `add`, `get`, `remove`, `list`, `neighbors`, `traverse`, `setEndpointPolicy` |
| `map.bindings` | `add`, `get`, `update`, `remove`, `list` |
| `map.state` / `map.selection` | feature state and selection management, subscriptions |
| `map.query` | `at`, `area`, `rendered` |
| `map.controls` / `map.detail` / `map.locate` | optional controls, feature details, one-shot and watched geolocation |
| `map` | `batch`, `whenRendered`, `on`, `capabilities`, `stats`, `interaction`, `debug`, `destroy` |

See [API contracts](docs/decisions.md) for units, defaults, ownership and deletion
policies, and [demo and testing instructions](docs/status.md#running-the-checks)
for examples of fonts, media, imports and vector tiles.

## Relationship to Leaflet

Leaflet inspired the project: creating a map, adding layers and working with
coordinates should feel straightforward. Maplet takes a different approach to
rendering and data management rather than reproducing Leaflet's API.

Preserved calculations include spherical Web Mercator, the
`85.0511287798°` latitude limit, `256 × 2^zoom` world scale and longitude
wrapping into `[-180, 180)`. Tests compare these with Leaflet 1.9.4 as an
independent oracle. Differences are intentional: EPSG:4326 uses Maplet's own
linear mapping, and geographic distances use a mean Earth radius of
`6,371,008.8 m` rather than Leaflet's `6,371,000 m`.

## Repository contents

- `src/`: library source.
- `test/` and `type-tests/`: unit, integration, distribution and type-contract tests.
- `demo/`: examples, browser test pages, fixture generators and the E2E runner.
- `docs/`: API contracts, testing scope and limitations.
- `scripts/`: declaration post-processing for the build.

Build output, screenshots, downloaded provider tiles and Python caches are
ignored by Git. Keep the browser checks and their original fixtures: they are
part of the test suite, not disposable check results. Third-party fixture
attribution is in [NOTICE](NOTICE) and `demo/fonts/NOTICE.txt`.

## License

Maplet is licensed under the **Apache License 2.0**. It permits private,
open-source and commercial use, modification and redistribution, including
selling copies. Redistribution requires a copy of the license, preservation
of applicable notices and prominent notices in modified files. The license
does not grant trademark rights except for customary identification of origin.
See [LICENSE](LICENSE) for the full terms.

Leaflet-derived material retains its BSD-2-Clause terms, and third-party
development fixtures retain their own licenses. See [NOTICE](NOTICE).
