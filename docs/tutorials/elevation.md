# Elevation on a route

A hiking route usually carries its altitude in the third GeoJSON coordinate.
Maplet keeps that value on every vertex, so an elevation profile or a climbing
readout can be built straight from the exported data — no side table.

## Altitude in coordinates

GeoJSON positions are `[longitude, latitude, altitude]`; Maplet's geographic
positions are `{ lat, lng, altitude }`. The third value is metadata: it never
changes where a vertex is projected, but it survives import, storage and export
for **every geometry type**, lines and polygon rings included.

```ts
await trails.importGeoJson({ type: 'FeatureCollection', features: [{
  type: 'Feature', id: 'ridge-trail', properties: { name: 'Ridge trail' },
  geometry: { type: 'LineString', coordinates: [
    [15.7120, 50.7230, 769], [15.7168, 50.7252, 842], // [lng, lat, altitude]
  ] },
}] });
```

A vertex without an altitude simply exports two coordinates. Normalization
keeps altitudes attached to their vertices: merging consecutive duplicate
positions keeps the first vertex's value, an auto-closed ring repeats the first
one, and a winding flip reverses the altitude column together with its ring.
The precise rules are recorded in the
[normalization contract](../decisions.md#writes-and-transactions).

## Live example

Move over the profile or scrub the slider: the pin follows the matching point
of the route and the readout reports its altitude. "Show exported GeoJSON"
prints what `exportGeoJson()` returns, and the chart itself is drawn from that
same export.

<!-- example -->

## Reading the profile back

```ts
const [route] = trails.exportGeoJson().features;
const points = (route.geometry as { coordinates: number[][] }).coordinates;
// [lng, lat, altitude] — the chart maps points.map(([, , altitude]) => altitude)
```

The example already reads the route back this way: the chart, the distance and
the ascent are all derived from the exported coordinates, so altitudes dropped
anywhere in the pipeline would flatten the profile. Altitudes are
geographic-only (`NaN` means absent); a planar map stores none. See the
[GeoJSON import guide](../data.md#geojson) and the
[export contract](../decisions.md#snapshots-events-and-export).
