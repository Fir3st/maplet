# Maplet

A TypeScript mapping library for the browser, with WebGPU rendering and WebGL 1
fallback. Points, lines, polygons, tiles, labels and media live in a tree of layers;
individual objects remain editable.

[Documentation](https://fir3st.github.io/maplet/) ·
[Tutorials](https://fir3st.github.io/maplet/tutorials/) ·
[API reference](https://fir3st.github.io/maplet/reference/) ·
[Releases](https://github.com/Fir3st/maplet/releases)

**Alpha.** The API can change between releases. See [migration](docs/api.md#migration-table)
and [known limitations](docs/status.md#known-limitations).

## Install

Download the `.tgz` from [GitHub Releases](https://github.com/Fir3st/maplet/releases)
and install it locally, or use GitHub Packages with package-read authentication:

```sh
npm install @fir3st/maplet@next --registry=https://npm.pkg.github.com
```

Maplet has no runtime package dependencies and includes TypeScript declarations.
See [installation](docs/installation.md) for archive and browser-module setup.

## Quick start

Give the container a height:

```html
<div id="map" style="height: 400px"></div>
```

```ts
import { createMap } from '@fir3st/maplet';

const map = await createMap('map', {
  center: [50.08, 14.44],
  zoom: 8,
  controls: ['zoom', 'scale'],
});

const places = map.addLayer({ id: 'places' });
const points = places.addPoints([
  { id: 'prague', position: [50.08, 14.44], properties: { name: 'Prague' } },
]);
places.addLabels(points.source);
points.get('prague')?.setPosition([50.1, 14.5]);

// Call map.destroy() when the map is no longer needed.
```

Geographic tuples are **[latitude, longitude]**; GeoJSON uses [longitude, latitude].
Direct additions such as `map.addPoints()` share `map.base`. Explicit layers can
contain any type of content, including other layers.

## More

- [Guides and API](docs/README.md)
- [Development and local preview](docs/development.md)
- [Benchmarks](docs/benchmarks/README.md) · [Changelog](CHANGELOG.md)
- [Issues](https://github.com/Fir3st/maplet/issues)

Independent of Leaflet; not a plugin or drop-in replacement. Licensed under
[Apache-2.0](LICENSE). Third-party attribution is in [NOTICE](NOTICE).
