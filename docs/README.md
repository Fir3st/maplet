# Maplet documentation

Maplet is a TypeScript mapping library with WebGPU rendering and WebGL 1 fallback.
Create a map, add content to layers, and edit individual objects without replacing
the whole dataset.

## Start here

- [Installation](installation.md) — packages, release archives and browser modules.
- [Your first map](tutorials/basics.md) — a container, points, labels and feature details.
- [Tutorials](tutorials/README.md) — working examples alongside the concepts they use.
- [API reference](api-index.md) — methods, options, types and events.

```ts
import { createMap } from '@fir3st/maplet';

const map = await createMap('map', {
  center: [50.08, 14.44],
  zoom: 8,
  controls: ['zoom'],
});

const places = map.addLayer({ id: 'places' });
places.addPoints([{ position: [50.08, 14.44] }]);
```

Give `#map` a height before creating the map. Geographic tuples are
**[latitude, longitude]**; GeoJSON coordinates are **[longitude, latitude]**.

## Guides

- [Maps and coordinates](maps.md) — projections, view changes and screen conversions.
- [Layers and objects](api.md) — nested layers, editable collections, ownership and migration.
- [Data and transactions](data.md) — shared sources, imports, references, relations and bindings.
- [Styles and rendering](rendering.md) — expressions, tiles, vector tiles, labels and media.
- [Interaction and UI](interaction.md) — events, selection, queries, controls and geolocation.
- [Plugins](plugins.md) — plain-function extensions and rendering hooks.
- [API contracts](decisions.md) — exact units, defaults and lifecycle rules.

## Project

Maplet is independent of Leaflet, with its own API. It ships ESM and TypeScript
declarations, without runtime package dependencies. The current release is
pre-1.0: read [known limitations](status.md#known-limitations) before relying on a feature.

- [Development](development.md) and [website publication](examples.md).
- [Implementation status](status.md) and [benchmark records](benchmarks/README.md).
- [Background](background.md), [changelog](../CHANGELOG.md) and [license](../LICENSE).
