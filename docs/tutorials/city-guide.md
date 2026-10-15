# A city guide on real tiles

The pattern most sites start with: an OpenStreetMap basemap, one pin per place,
a tooltip on hover, a popup on click, a keyboard-reachable list and a category
filter — everything driven by one array of records.

## The shape of the recipe

```ts
const map = await createMap('map', { center: [50.0875, 14.4213], zoom: 13.4 });
map.addTiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  id: 'basemap',
  attribution: '© OpenStreetMap contributors',
});
map.addControl('attribution');

const markers = map.addMarkers(places.map(place => ({
  id: place.id,
  position: place.at,
  iconTint: KINDS[place.kind].tint,
  tooltip: `${place.name} · ${KINDS[place.kind].label}`,
  popup: { content: popupNode(place) },   // a Node renders as-is, a string as text
})));

await map.flyTo({ center: place.at, zoom: 15 }, { duration: 600 });
markers[index].openPopup();
```

## Live example

Click a pin or a list entry, switch the category filter, try **Where am I?**, and
use the offline demo tiles to work without a network connection.

<!-- example -->

## What the recipe shows

- One array of records drives the markers, the list and the filter. Nothing is
  duplicated between the DOM and the map, and a marker click keeps the list
  selection in sync the other way around.
- Popup content is a caller-owned `Node`. Strings always render as text, so data
  from a CMS or an API never becomes active HTML.
- `map.flyTo()` moves the view to a record, and the popup follows its pin while
  you pan because markers re-place their overlays on view and commit changes.
- `iconTint` multiplies the pin texture, so category colours need a white-bodied
  asset with the same silhouette: the example registers one SVG with
  `map.assets.addImage()` and every marker references it by id.
- The **offline demo tiles** switch replaces the tile URL together with its
  attribution in one `source.update()` call — the same call a theme or a
  language switch would use. Attribution always describes the active source.
- Live OpenStreetMap tiles need an internet connection and follow the OSM tile
  usage policy: the source carries its attribution, tiles are requested only for
  the visible view, and nothing is prefetched or cached.

See [raster tiles](raster.md) for tile sources, [markers](markers.md) for the
tooltip and popup contract, and
[geolocation](../interaction.md#geolocation) for `map.locate()`.
