# Lines, fills and holes

A site layer contains a polygon and a nested paths layer. They can be controlled
independently or hidden together through their common parent.

## Mix content in a layer

```ts
const site = map.addLayer({ id: 'site' });
const fills = site.addPolygons([{ rings: [outerRing, holeRing] }]);
const paths = site.addLayer({ id: 'paths' });
const route = paths.addLines([{ positions: routePositions }]);
```

The first polygon ring is its exterior, and subsequent rings are holes. A hole is
empty geometry: it is not painted with the background color, and picking respects it.

## Live example

Toggle the polygon, route or entire site. If a polygon is independently hidden,
showing its parent does not reset that choice.

<!-- example -->

## Move and remove

`route.move({ index: 0 })` reorders it among its current siblings.
`route.move({ into: site.id })` reparents it. `site.remove()` removes the site's
current subtree, but a child moved out before removal survives.

Styles belong to `fills` or `route`, not the mixed `site` container. See
[layers and objects](../api.md#layers-form-a-tree) and [exact signatures](../api-index.md#layers-and-collections).
