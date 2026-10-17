# Raster tiles

Add an XYZ source and update it without rebuilding the map. The initial tile is
an inline SVG grid; OpenStreetMap loads only after you choose it.

## Add a basemap

```ts
const tiles = map.addTiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
});
map.addControl('attribution');
```

`addTiles()` creates the source and render pass together, inside `map.base`.
Its `.source.update()` changes the tile descriptor. Attribute the provider and
follow its tile usage policy.

## Live example

Choose demo tiles or OpenStreetMap, then pan and zoom. OpenStreetMap needs a
network connection. This example does not prefetch or persist provider tiles.

<!-- example -->

## More raster sources

Tile options support TMS, retina, zoom limits and fallback coverage. WMS uses
`addWms(url, options)` and accounts for service version and CRS axis order.
Image and video overlays use explicit bounds instead of a tile grid. See
[raster, MVT and media](../rendering.md#raster-tiles-and-wms).
