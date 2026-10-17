# Tutorials

Each tutorial introduces one part of the API, with a live map and the complete
JavaScript source. Start with a first map, then choose a topic.

<!-- tutorial-directory -->

## Getting started

- [Your first map](basics.md) — container, map creation, points, labels and details.
- [Points that change](points.md) — properties, style expressions and editable objects.

## Geometry and data

- [Lines, fills and holes](geometry.md) — mixed content and nested layer visibility.
- [Connected data](bindings.md) — stable references and derived route geometry.
- [Bring your GeoJSON](geojson.md) — atomic import and canonical export.
- [Elevation on a route](elevation.md) — altitude per vertex, read back from the exported data.

## Presentation and extensions

- [Labels and image pins](labels.md) — reusable images, labels and shared data.
- [Markers with tooltips and popups](markers.md) — pins, hover tooltips, one click popup per map and drag to move a pin.
- [Cluster nearby pins](clusters.md) — count badges for dense pins that split apart as you zoom in.
- [Raster tiles](raster.md) — tile URLs, source updates and attribution.
- [A plugin is a function](plugins.md) — installation, a custom API and cleanup.
- [Gesture guard](gesture-guard.md) — two-finger touch and modifier-gated mouse gestures.
- [Fullscreen mode](fullscreen.md) — a fullscreen toggle with a corner button.
- [Heatmap](heatmap.md) — a weighted heat field drawn through the after-frame hook.

## Real-world recipes

- [A city guide on real tiles](city-guide.md) — markers, popups, a list and a filter over OpenStreetMap.
- [Two map views](views.md) — a switcher over independent maps, each with labelled layers.
- [Track a vehicle on a route](tracking.md) — a simulated GPS feed, a travelled path and follow mode.
- [Filter and inspect a field dataset](field-explorer.md) — style expressions, filters, detail and in-view queries.
- [Measure a route and an area](measure.md) — background clicks, geodesic distances and a closed ring.

<!-- /tutorial-directory -->

For exact signatures, use the [API reference](../api-index.md). For additional
capabilities such as WMS, vector tiles, media and geolocation, read the
[guides](../README.md#guides).
