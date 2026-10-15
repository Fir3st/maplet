# Heatmap

The `heatmap` plugin renders weighted points as a smooth heat field over the map.
It is a built-in example of the after-frame hook: one absolutely positioned
canvas, no GPU state shared with the renderer, and no work while the map is idle.

## Install it

```ts
import { heatmap } from '@fir3st/maplet';

const heat = map.use(heatmap({
  points: [
    { position: [50.087, 14.421], weight: 1 },
    { position: [50.076, 14.451], weight: 0.6 },
  ],
  radius: 30,
}));

heat.api.addPoint([50.099, 14.435], 0.8);   // define more samples
heat.api.setPoints(measurements);           // or replace them all
heat.api.setOptions({ gradient: [[0, '#312e81'], [1, '#f97316']], max: 2 });
heat.api.clear();                           // remove every sample
heat.remove();                              // removes the overlay canvas
```

Positions follow the normal coordinate rules — a `[lat, lng]` tuple or an object,
`{ x, y }` on a planar map — and `weight` defaults to `1`.

| Option | Default | Meaning |
| --- | --- | --- |
| `points` | `[]` | Initial samples: `{ position, weight? }` |
| `radius` | `25` | Splat radius in CSS pixels |
| `blur` | `15` | Width of the soft splat edge in CSS pixels |
| `max` | largest weight | Intensity that reaches the top of the ramp; `null` scales by the data |
| `minOpacity` / `maxOpacity` | `0.05` / `1` | Bounds of one splat's alpha |
| `gradient` | blue → cyan → lime → yellow → red | `[offset, cssColor]` stops; `null` restores the default |
| `zIndex` | `1` | CSS `z-index` of the overlay surface |

## How the field is drawn

- Every rendered frame splats the samples that fall inside the view into a
  bounded offscreen field — at most 1.5 device pixels per CSS pixel and about a
  million pixels — and colorizes it through a 256-entry ramp whose alpha follows
  the accumulated intensity: splat alphas add up and saturate.
- Data and option changes schedule a frame through `render.invalidate()`, so a
  map that is not moving and whose data did not change does no heatmap work.
- The overlay sits above the map canvas and below controls and DOM overlays:
  points, labels and markers delivered by the GPU renderer show through faint
  areas and disappear under hot cores. `zIndex` moves the surface.
- A color the browser cannot parse in a gradient is reported through
  `map.on('rendererror')` on the first frame, like any other render failure.
- Dense data saturates the ramp because splat alphas add up: lower the per-sample
  weights or raise `max` so a single sample stays faint and the accumulation —
  not the largest weight — decides the color.

## Live example

The example draws 850 synthetic measurements around Prague with six plain points
under the field; the explicit `max: 1` keeps one sample faint, so the dense
clusters turn hot and the sparse ones stay cool. Replace the data, switch the
ramp, grow the splats, add a hotspot or clear the field; the status line reports
the sample count.

<!-- example -->

## Notes

- Frame cost grows with the samples inside the view, not with the dataset; the
  field buffer stays bounded, so very large maps render a slightly softer field
  instead of stalling.
- Non-positive weights are ignored while rendering; `count` still reports them.
- `heatmap` never replaces the renderer, so it works with the built-in backends,
  with `renderer: 'none'` and with a custom renderer, at the cost of drawing over
  GPU-delivered features.

See the [plugins guide](../plugins.md#built-in-plugins) and
[known limitations](../status.md#known-limitations).
