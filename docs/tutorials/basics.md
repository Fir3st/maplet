# Your first map

Create a map, put points and labels in a layer, then open a detail when a point is
clicked. This tutorial uses three real city positions without an external basemap.

## Prepare the page

Install [Maplet](../installation.md) and give its container a height:

```html
<div id="map" style="height: 400px"></div>
```

## Create the map and layer

```ts
import { createMap } from '@fir3st/maplet';
const map = await createMap('map', { center: [49.7, 15.2], zoom: 7, controls: ['zoom'] });
const places = map.addLayer({ id: 'places' });
const points = places.addPoints([
  { id: 'prague', position: [50.08, 14.44], properties: { name: 'Prague' } },
]);
places.addLabels(points.source);
```

`createMap()` is asynchronous; later object edits are synchronous commits.
Geographic tuples use latitude first. Labels share the point source, so an edit
does not require maintaining a second copy of the data.

## Live example

Use **Fit all places**, or click a point to open its detail. The source below also
includes the other two cities and the detail callback.

<!-- example -->

## Respond to a click

```ts
points.on('click', event => {
  map.detail.open(event.feature, { content: feature => String(feature.properties.name) });
});
map.fitBounds(points.getBounds(), { padding: 40, maxZoom: 8 });
```

Details render strings as text and follow the feature's position. Destroy the map
when leaving the page. Continue with [editable points](points.md) or see
[maps and coordinates](../maps.md).
