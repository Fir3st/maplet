# Bring your GeoJSON

Import a FeatureCollection into a source and export the stored result. Input stays
in your browser; this tutorial accepts up to 64 KiB and 100 point features.

## Coordinate order

GeoJSON uses **[longitude, latitude]**, the reverse of Maplet's geographic tuples.

```js
const data = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'prague', properties: { name: 'Prague' },
    geometry: { type: 'Point', coordinates: [14.44, 50.08] } },
] };
await points.source.importGeoJson(data);
```

This example uses a point collection. For mixed geometry, create an explicit
shared source and separate point, line and fill render passes.

## Live example

Edit the coordinates and import. Export writes the accepted source data back into
the editor. Invalid input reports an error without replacing the previous data.

<!-- example -->

## Canonical export

```ts
const exported = points.source.exportGeoJson();
```

Exported geometry is canonical, not clipped to the viewport. Normalization and
projection can cause tiny floating-point differences. See
[imports](../data.md#geojson) and [columnar data](../data.md#columnar-imports).
