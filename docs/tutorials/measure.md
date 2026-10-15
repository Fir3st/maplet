# Measure a route and an area

A planning-tool pattern: click the map to place points, read the distance while
you go, close the ring to get an area, and step back with **Undo the last point**.

## The shape of the recipe

```ts
map.on('click', (event) => {
  if (event.feature) return;                       // background clicks only
  const handle = vertices.add({ position: event.position, properties: { label: '' } });
  if (handles.length > 1) {
    const leg = haversineMeters(handles[handles.length - 2].getPosition(), handle.getPosition());
    handle.setProperties({ label: formatDistance(leg) });
  }
  path?.setPositions(handles.map(vertex => vertex.getPosition()));
});
```

## Live example

Click the map a few times, watch the per-segment labels and the running total,
then close the area and undo a point.

<!-- example -->

## What the recipe shows

- `map.on('click')` reports background clicks with a canonical `event.position`;
  clicks on a feature keep their own behaviour and are skipped here.
- Every click writes through the public API — a point is added, the path's
  positions are replaced — so undo is a real removal, not a redraw.
- Segment lengths use `haversineMeters()`, and per-segment labels are one `label`
  property on the same vertices, rendered by a labels layer over one source.
- The area uses a planar approximation at the ring's mean latitude
  (equirectangular projection plus the shoelace formula), accurate to well under
  a percent at city scale — labeled as an approximation in the readout.
- Empty lines and polygons are rejected, so the path appears with the first
  click and the fill when three points close a ring. The path is created once
  and then only its positions change.

See [feature events](../interaction.md#feature-events), [coordinates](../maps.md#coordinates)
and [line and fill styles](../rendering.md#geometry).
