# Points that change

Move a point, change its properties and hide it without deleting its data.
The example uses a synthetic station grid in planar coordinates.

## Create an editable collection

`map.addPoints()` adds a collection to the shared `map.base`. It does not allocate
an object handle per row. Request one with `get(id)` when you need to edit it.

```ts
const stations = map.addPoints(
  [{ id: 'first', position: { x: 0, y: 0 }, properties: { status: 'offline' } }],
  { draggable: true },
);
const first = stations.get('first');
first?.setPosition({ x: 0.5, y: 0.2 });
first?.setProperties({ status: 'online' });
```

Planar maps use `projection: crs.simple()`. Geographic tuples are not accepted
for planar coordinates.

## Style from data

```ts
stations.setStyle({
  color: style.by('status', { online: '#16724c', offline: '#bd573b' }, '#66776d'),
  radiusPx: style.when(style.state('selected'), 14, 10),
});
```

Import `style` from the package. Expressions read properties and selection state;
you do not need a loop that repaints each feature.

## Live example

Change the first station's status or position. Hide it and show it again: its ID,
properties and geometry stay in the source.

<!-- example -->

## Collection versus object styles

Collection `setStyle()` replaces the base style. Object `setStyle()` patches a
collection-local override; `clearStyle()` removes it. `hide()` affects rendering,
not `count()`. See [data lifetime](../data.md#identity-and-editing) and
[style reference](../api-index.md#styles).
