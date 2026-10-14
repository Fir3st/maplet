# Labels and image pins

Register one SVG image and reuse it for several pins. A label collection reads the
same feature source, so names and positions stay synchronized.

## Register and reuse an image

```ts
map.assets.addImage({ id: 'pin', src: '/images/pin.svg' });
const pins = map.addPoints(places, {
  style: { icon: 'pin', iconSize: 32, iconAnchor: { x: 0, y: -16 } },
});
const labels = map.addLabels(pins.source, {
  style: { sizePx: 14, collision: true, offsetPx: { x: 0, y: -42 } },
});
```

Labels default to each feature's `name` property. Empty names are skipped.
Loading or failed icons use the point shape fallback rather than disappearing.

## Live example

Drag a pin, toggle labels or rename a place. The example embeds its SVG and uses
system fonts, without an asset download.

<!-- example -->

## Text and placement

Higher-priority labels win collisions. Text is single-line and shaped by the
platform, so pixels can differ across operating systems. `assets.addFont()` adds
a named font; labels use fallback while it loads. See [images and labels](../rendering.md#images-and-labels).
