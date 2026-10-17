# Connected data

Move either station and its route follows in the same transaction. Stable feature
references identify the endpoints; a binding derives the line geometry.

## Keep related content together

Create a network layer, add stations and a line, then get their object handles.
Draw the line before the points using `connections.move({ before: stations.id })`.

## Bind the route

```ts
const a = stations.get('a'),
  b = stations.get('b');
const route = connections.get('a-b');
map.bindings.add({
  id: 'route-geometry',
  target: route.ref,
  geometry: { kind: 'lineBetween', from: a.ref, to: b.ref },
});
map.relations.add({ id: 'station-connection', type: 'connects', from: a.ref, to: b.ref });
```

The binding owns the route geometry. The relation records a connection without
duplicating geometry or providing its own rendering.

## Live example

Drag an endpoint, or use **Move endpoint**. There is no manual line-repair loop.

<!-- example -->

## Ownership matters

Manual geometry writes to the bound route reject with `ownership-conflict`.
Remove or change the binding before taking over that field. Missing input deletion
defaults to rejection, and dependency cycles are rejected atomically.
See [relations and bindings](../data.md#relations-and-bindings).
