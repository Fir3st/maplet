# Cluster nearby pins

`map.setMarkerClustering()` replaces pins that would overlap with one count
badge. A dense map stays readable: the badge shows how many pins it stands for,
hovering it reveals the count, and clicking it zooms those pins apart.

## Turn it on

```ts
map.addMarkers(places.map(place => ({ position: place.at, tooltip: place.name })));
map.setMarkerClustering({ radiusPx: 64 });
```

A pin joins the nearest group whose running centre is within `radiusPx` screen
pixels, and a group needs at least `minCount` members (default 2) to replace its
pins with a badge. The default radius of 64 px is sized for the 32 px pin: pins
that would touch on screen end up in one badge.

## The badge

- It carries the member count as text — exact up to 999, then `1.2k` — in three
  size and colour tiers, so a dense map still reads at a glance.
- Hovering a badge shows a `N pins` tooltip and the cursor becomes a pointer.
- Clicking a badge fits the member bounds, so the pins separate at the new zoom.
  `disableAtZoom` caps that zoom, and at the cap every pin draws individually.
- A badge is one internal point feature in the shared marker layer with the
  reserved `maplet-cluster:` id prefix; it picks and hovers like any sprite, and
  it never opens a popup.

```ts
map.setMarkerClustering({ radiusPx: 48, minCount: 3, disableAtZoom: 14 });
map.getMarkerClustering(); // { radiusPx: 48, minCount: 3, disableAtZoom: 14 }
map.setMarkerClustering(null); // every pin draws again
```

## Per-pin control

```ts
map.addMarker({ position: depot, cluster: false }); // a landmark that stays put
pin.hide(); // leaves its badge's count; show() puts it back
```

- `cluster: false` keeps one pin individual inside a crowd.
- A pin being dragged stays individual for the gesture; at `dragend` it joins or
  leaves a group and the badge counts follow.
- A grouped pin's permanent tooltip and open popup leave the map with the pin
  and come back when it ungroups.
- Grouping is resolved in screen space at the current zoom, so panning never
  re-clusters; it re-resolves when the zoom or the pins change. Pins that share
  one position stay one badge at the maximum zoom (no spiderfy in this alpha).

## Live example

Hover a badge for its count, click one to zoom the pins apart, cycle the radius,
add a burst of pins and toggle clustering off to see every pin.

<!-- example -->

Badges are canvas sprites in the same shared layer as the pins — no DOM element
per badge. See the [marker contracts](../decisions.md#markers), the
[markers tutorial](markers.md) and the
[rendering guide](../rendering.md#markers).
