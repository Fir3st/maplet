# Data and transactions

## Collections or shared sources

For ordinary data, use `map.addPoints()`, `layer.addLines()` or `layer.addPolygons()`.
Each call creates a separate collection with its own style and source. A collection's
`.source` exposes imports, export, snapshots and low-level feature operations.

Create an explicit source when several render passes need the same data:

```ts
import type { PointGeometry } from '@fir3st/maplet';
const source = map.data.vector<PointGeometry>({ id: 'places-data' });
await source.importGeoJson(featureCollection);
const places = map.addLayer({ id: 'places' });
const points = places.addPoints(source);
places.addLabels(source);
```

Generic source types can restrict geometry and properties in TypeScript. For
arbitrary line/fill sources or read-only vector tiles, use
`layer.addLayer({ type, source, style, namespace })`.

## Identity and editing

Feature IDs are strings or numbers; `42` and `'42'` are different. Omitted IDs are
generated in the source. A `.ref` includes the scene, source, namespace, ID and
generation, so removing and recreating an ID never revives an old reference.

`collection.get(id)` returns a lazy object handle or `undefined`. Its `get()`
returns a snapshot with copied geometry and top-level properties. Treat shared
nested property values as immutable. Use `setProperties()` to merge keys, or set
a key to `undefined` to remove it. Geometry writes replace the complete geometry.

`addMany()` returns a commit with references, not an eager array of object handles.
`setData()` replaces source data atomically; IDs that remain retain their identity.
It is asynchronous, so await it before depending on the replacement.

## GeoJSON

```ts
await points.source.importGeoJson(featureCollection);
const exported = points.source.exportGeoJson();
```

GeoJSON keeps its standard **[longitude, latitude]** order. A third value is the
vertex altitude: it is metadata, preserved per vertex on points, lines and
polygons and returned by `exportGeoJson()` (a vertex without one exports two
coordinates). Invalid imports leave accepted data unchanged. Exports contain
canonical data, not clipped screen fragments; floating-point round trips are
approximate, not bit-identical. See the [GeoJSON tutorial](tutorials/geojson.md)
and the [altitude tutorial](tutorials/elevation.md).

## Columnar imports

```ts
await source.importColumnar(
  {
    kind: 'point',
    positions: new Float64Array([14.44, 50.08, 16.6, 49.2]),
    ids: ['prague', 'brno'],
  },
  { copy: true },
);
```

Positions are flat longitude/latitude or planar x/y pairs. Lines and polygons add
`partOffsets` and `featurePartOffsets`; the optional `altitudes` column holds one
value per vertex (`NaN` = absent) for geographic CRSs. The entire structure is
validated before publication. Worker preparation is separate from the
main-thread transaction.

The default copies buffers. `copy: false` transfers and detaches unique buffers
when a worker is available; inline preparation still copies. Imports accept an
AbortSignal. The bounded queue allows one active and four waiting tasks; overflow
rejects with `aborted`. See [import contracts](decisions.md#geojson-and-columnar-imports).

## Atomic batches

```ts
const commit = map.batch(() => {
  points.get('prague')?.setPosition([50.1, 14.5]);
  points.get('brno')?.setProperties({ status: 'offline' });
});
await map.whenRendered(commit.revision);
```

The callback must be synchronous. Nested batches join the outer transaction.
Validation or binding failures roll back the entire batch. A logical commit and
a rendered frame are different states; `whenRendered()` is the explicit screen fence.

## Relations and bindings

Relations describe connections without copying geometry. Bindings derive geometry
or properties and own their target fields:

```ts
map.relations.add({ id: 'connection', type: 'connects', from: a.ref, to: b.ref });
map.bindings.add({
  id: 'route-geometry',
  target: route.ref,
  geometry: { kind: 'lineBetween', from: a.ref, to: b.ref },
});
```

Other geometry bindings use `anchorOnLine`; property bindings use `copyProperty`.
Manual writes to a binding-owned field fail with `ownership-conflict`. Dependency
cycles are rejected. Relation endpoints and missing binding inputs default to
rejecting deletion; choose a documented policy explicitly when needed.
See [connected data](tutorials/bindings.md) and [ownership contracts](decisions.md#missing-inputs-deletion-and-ownership).

## Ownership and subscriptions

Explicit `map.data` sources are caller-owned. Inline sources are removed after their
last display pass disappears, unless relations or bindings retain them. Removing
a logical layer removes its current subtree; moved-out children survive.

`source.subscribe()` delivers an initial snapshot synchronously and later change
events. Subscriptions accept an AbortSignal and return idempotent unsubscribe
functions. `map.data.remove(id)` rejects live dependencies unless an explicit
`{ cascade: true }` is supplied. `map.destroy()` releases the entire scene.
