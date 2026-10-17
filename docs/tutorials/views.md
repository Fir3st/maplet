# Two independent map views

One host, several maps: `createMapSwitcher()` builds accessible tabs over
independent Maplet maps. Switching only changes which panel is visible. A map
that has been created keeps its view, layer visibility and subscriptions, and a
map that has not been opened yet is not created at all.

## Create the switcher

```ts
const switcher = await createMapSwitcher({
  container: 'map',
  label: 'Logistics map views',
  initial: 'overview',
  maps: [
    { id: 'overview', label: 'Network overview', options: { center: [49.8, 15.3], zoom: 7.1, controls: ['zoom', 'layers'] } },
    { id: 'detail', label: 'Prague detail', options: { center: [50.08, 14.43], zoom: 12.4, controls: ['zoom', 'layers'] } },
  ],
});

const overview = switcher.get('overview');    // created by the call above
const detail = await switcher.show('detail'); // created on first activation
```

`show()` resolves with the map (creating it on first use), `get()` returns an
already created map, `onChange()` reports the active entry after a switch and
`destroy()` releases every map the switcher created. The host needs an explicit
height, like a single map container.

## Layers per view

Give a root layer a `label` and the built-in `layers` control becomes a readable
overlay: each row toggles one root entry and its whole subtree.

```ts
const depots = switcher.get('overview').addLayer({ id: 'depots', label: 'Depots' });
depots.addPoints(stations, { style: { radiusPx: 7, color: '#16724c' } });
```

Every map owns its sources and layers, so toggling a layer in one view never
touches the other. The switcher handles tab roles, focus and keyboard switching.

## Live example

Switch tabs, pan and zoom in each view, then toggle its layers control. The
detail view is created only when you first open it and reset applies to the
active view.

<!-- example -->

## Notes

- Inactive panels stay laid out with `visibility`, which keeps a lazily created
  map at its real size and avoids resize churn while switching.
- Multiple maps are independent; the switcher does not share a source or a
  scene between them.
- See [multiple map views](../maps.md#multiple-map-views) and the
  [existing controls](../interaction.md#controls).
