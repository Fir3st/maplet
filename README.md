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

> **Alpha: `0.1.0-alpha.1`.** The API is still evolving. See
> [implementation status](docs/status.md) for known limitations and the scope of
> testing. Development-machine timings are not reference benchmarks.

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
- **Diagnostics:** capabilities, frame/draw-call/GPU-memory statistics, measured
  picking stalls and debugging tools.

## Quick start

The source checkout requires **Node.js 22 or later**, **TypeScript 5.8 or later**
(`tsc` on your PATH), and **Python 3** for the demo server. The library has no
runtime package dependencies. TypeScript is not currently declared as a package
development dependency, so `npm install` alone does not provide the compiler.

```bash
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
import { createMap, crs, expr } from 'maplet';

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
repository demos import `../dist/index.js` directly. This checkout is marked
`private` in `package.json` to prevent accidental npm publication. Public Git
hosting does not require removing that safeguard.

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
