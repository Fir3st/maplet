# Maps and coordinates

## Create a map

```ts
import { createMap } from '@fir3st/maplet';

const map = await createMap('map', {
  center: [50.08, 14.44],
  zoom: 8,
  controls: ['zoom', 'scale', 'attribution'],
});
```

Pass an element or its ID. Creation is asynchronous because GPU acquisition is
asynchronous. Give the container a height first. Web Mercator and automatic
WebGPU → WebGL 1 fallback are the defaults; no controls are added unless requested.

## Coordinates

| Input                                       | Meaning                                              |
| ------------------------------------------- | ---------------------------------------------------- |
| `[50.08, 14.44]`                            | Geographic latitude, longitude                       |
| `{ lat: 50.08, lng: 14.44, altitude: 250 }` | Geographic position with optional altitude           |
| `{ x: 10, y: 20 }`                          | Planar position; requires a planar projection        |
| GeoJSON `[14.44, 50.08]`                    | Longitude, latitude, as required by GeoJSON          |
| Screen `{ x, y }`                           | CSS pixels from the top-left corner of the container |

Read methods return canonical object coordinates, not tuples. World coordinates
use `256 × 2^zoom`; they are not geographic or planar positions. Pixel styles use
names such as `radiusPx` and `widthPx` to distinguish screen size from geometry.

## View methods

```ts
map.setView({ center: [49.2, 16.6], zoom: 10 });
map.setCenter([50.08, 14.44]);
map.setZoom(12);
map.fitBounds(points.getBounds(), { padding: 40, maxZoom: 14 });
await map.flyTo({ center: [49.2, 16.6], zoom: 9 });
```

`getView()`, `getCenter()`, `getZoom()` and `getBounds()` inspect the current view.
`fitBounds(null)` is useful with empty collections. `stop()` cancels view motion.
`zoomAround(screenPoint, deltaZoom)` keeps a screen anchor fixed during a zoom.

`positionToScreen(position)` and `screenToPosition(screenPoint)` bridge application
overlays and map coordinates. `size()` returns CSS-pixel dimensions; `resize(width,
height)` updates them explicitly. DOM maps also observe their container size.

## Projections

```ts
import { createMap, crs } from '@fir3st/maplet';

const map = await createMap('map', {
  projection: crs.simple(),
  center: { x: 0, y: 0 },
  zoom: 0,
});
map.addPoints([{ position: { x: 2, y: 3 } }]);
```

Simple CRS uses arbitrary planar units with positive y pointing north. Geographic
tuples are rejected on a planar map. Other built-in choices are `crs.webMercator()`,
`crs.epsg4326()` and `crs.epsg3395()`; `crs.define(spec)` defines a custom
projection. Geographic distance uses meters; simple-CRS distance uses planar units.

## Multiple map views

`createMapSwitcher()` manages several independent maps in one host with
accessible tabs:

```ts
import { createMapSwitcher } from '@fir3st/maplet';

const switcher = await createMapSwitcher({
  container: 'views',
  label: 'Map views',
  initial: 'overview',
  maps: [
    {
      id: 'overview',
      label: 'Overview',
      options: { center: [49.8, 15.3], zoom: 7, controls: ['zoom', 'layers'] },
    },
    {
      id: 'detail',
      label: 'Detail',
      options: { center: [50.08, 14.43], zoom: 12.4, controls: ['zoom', 'layers'] },
    },
  ],
});

switcher.activeId; // 'overview'
const detail = await switcher.show('detail'); // created on first activation
switcher.get('overview'); // the created map, or undefined
switcher.onChange((id) => {}); // notified after the active entry changes
switcher.destroy(); // destroys every created map
```

The initial entry is created during the call; every other map is created on its
first activation and then kept alive, so switching preserves pan, zoom, layer
visibility, selection and subscriptions. Inactive panels stay laid out with
`visibility`, so a lazily created map measures its real size before its first
frame. The host needs an explicit height, like a single map container.

A switcher is a plain composite: each view is an ordinary `MapHandle` with its
own sources, layers and controls, and nothing is shared between views. Tabs
expose `tablist`/`tab`/`tabpanel` roles, roving focus and arrow/Home/End keys.

## Headless scenes and cleanup

`createMap(null, { renderer: 'none' })` provides data and transactions without a
DOM or GPU. DOM-only operations reject with `unsupported-capability`.

Call `map.destroy()` when leaving a page or unmounting a component. It releases
sources, layers, GPU resources, subscriptions, controls and installed plugins.
See [renderer recovery](rendering.md#backend-recovery) and [exact contracts](decisions.md).
