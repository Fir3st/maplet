# Track a vehicle on a route

A last-mile tracking view: the planned path, the part already driven, three stops
and a vehicle marker that moves as a simulated GPS feed reports positions. The
same calls serve real telemetry — only the feed's cadence changes.

## The shape of the recipe

```ts
const planned = map.addLines([{ positions: route }], {
  interactive: false,
  style: { color: '#94a3b8', widthPx: 5, dash: [7, 6] },
});
const vehicle = map.addPoints([{ id: 'vehicle', position: route[0], properties: { heading: 0 } }], {
  id: 'vehicle',
  interactive: false,
  style: { icon: 'vehicle-arrow', iconSize: 28, iconRotate: style.field('heading') },
});

// One feed tick: move the vehicle and extend the travelled line together.
const handle = vehicle.get('vehicle');
handle.setPosition(next);
handle.setProperties({ heading: bearing });
travelled.setPositions([...route.slice(0, index), next]);
```

## Live example

Press **Play the feed** (the route starts by itself unless the system asks for
reduced motion), change the simulated speed, and switch follow mode off to pan
away from the vehicle and back.

<!-- example -->

## What the recipe shows

- The vehicle is one point with `iconRotate` bound to a `heading` property, so
  the sprite turns along the road segment without a DOM element per update.
- The vehicle and the travelled line are updated in the same commit — they can
  never show two different positions.
- The feed commits about twelve times per second (`UPDATE_MS`) while animation
  frames only measure elapsed time. A real GPS feed pushes 1–10 updates per
  second and needs no interpolation loop at all; the distance along the route is
  the state, not the frame count.
- Follow mode recentres with `setView()`, an instant commit — the pattern for a
  "chase" view. Turn it off to let the user pan without fighting the feed.
- The loop pauses when the tab is hidden and stops on arrival and on `pagehide`,
  so a tracking page never leaves an animation frame running.
- A following view requests new tiles as the vehicle moves. That is the intended
  behaviour and the reason a production tracker uses its own tile service or a
  commercial provider instead of a shared free one.
- `map.addControl('scale')` and `map.addControl('attribution')` are part of a
  real basemap recipe: distance context for the user, attribution for the data.

See [view methods](../maps.md#view-methods) for `setView`/`flyTo`, [geometry](../rendering.md#geometry)
for line styles and [controls](../interaction.md#controls) for scale and attribution.
