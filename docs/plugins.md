# Plugins

A plugin is an ordinary function. No base class, global registry, prototype
patching, `definePlugin` helper or extra dependency is needed.

Try the interactive [HTML example](../demo/plugins.html) at
`http://localhost:8400/demo/plugins.html` after `npm run build` and `npm run demo`.
It toggles HTML, a pin layer, a color transform and a Canvas replacement with
hit testing. The example is offline; `?backend=webgpu` selects WebGPU and
`?backend=none` starts directly with the custom renderer. Its Canvas renderer
deliberately supports only the circle/solid-line scene used by the example.

```ts
import type { PluginContext } from 'maplet';

function zoomBadge({ map, container, signal, onCleanup }: PluginContext) {
  if (!container) return;
  const badge = container.ownerDocument.createElement('span');
  badge.style.cssText = 'position:absolute;top:12px;left:60px;pointer-events:none';
  container.append(badge);
  onCleanup(() => badge.remove());

  const update = () => { badge.textContent = `Zoom ${map.view.get().zoom.toFixed(1)}`; };
  map.on('viewchange', update, { signal });
  update();
  return { element: badge };
}

const badge = map.use(zoomBadge);
badge.api?.element.classList.add('my-badge'); // inferred API, no casting
badge.remove();                            // unsubscribe + remove DOM
```

Install automatically with `createMap({ …, plugins: [zoomBadge, otherPlugin] })`.
Use `map.use()` when you need the returned API. A factory is enough for options:
`map.use(myPlugin({ color: 'blue' }))`, where `myPlugin(options)` returns a setup
function. Each installation is independent, even for the same function on the
same map. `use` and `remove` can be detached from their handles.

## Context and ownership

| Member | Purpose |
| --- | --- |
| `map` | Full public map API: sources, layers, view, selection, events, controls, details, bindings… |
| `container` | Actual HTML container, or `null` for a DOM-free map; also available as `map.container` |
| `signal` | Aborted when the installation is removed, setup fails, or the map is destroyed |
| `onCleanup(fn)` | Register resource cleanup, run once in reverse registration order |
| `render` | Rendering extensions, automatically removed with this installation |

Plugins are trusted application code, not sandboxed modules. Changing HTML is
intentional: append your own nodes, change existing controls through
`map.controls.get(id)?.element()`, or integrate a UI framework. Register DOM
removal/framework unmount with `onCleanup`. If you temporarily change existing
HTML or styles, register restoration too; Maplet does not guess how to undo
arbitrary DOM changes. Use `textContent` for untrusted strings.

For interactive overlays, stop propagation of `pointerdown`, `wheel`, etc. when
the map should not handle those gestures, or use `pointer-events:none` for
display-only content. DOM listeners support `{ signal }`; map listeners do too.
Listeners registered without that signal need explicit cleanup.

Setup is synchronous. Start asynchronous loading inside setup, pass `signal`
to cancellable work, and check `signal.aborted` before applying late results.
The returned value is your plugin's API, **not** an implicit cleanup function.
Use `onCleanup` for cleanup.

Failed setup aborts the signal and runs all registered cleanups. Failed cleanup
does not prevent other registered cleanups or other plugins from being removed;
errors are reported as `AggregateError`. Initial plugin setup failure destroys
the partially created map and rejects `createMap`. On map destruction, plugins
clean up in reverse installation order **before** sources and layers die.

## Add a functionality layer

Use existing public sources and layers; your plugin can expose higher-level
operations without adding properties to the map or subclassing it:

```ts
function pins({ map, onCleanup }: PluginContext) {
  const source = map.sources.vector({ id: 'my-pins' });
  onCleanup(() => map.sources.remove(source.id));
  const layer = map.layers.add({
    id: 'my-pins', type: 'points', source,
    style: { color: '#2563eb', radiusPx: 8 },
  });
  onCleanup(layer.remove); // LIFO: remove layer before its source

  return {
    add(id: string, lat: number, lng: number) {
      source.features.add({ id, geometry: { type: 'point', position: { lat, lng } } });
    },
    hide() { layer.setVisible(false); },
  };
}

const installed = map.use(pins);
installed.api.add('office', 50.08, 14.42);
installed.api.hide();
installed.remove();
```

Source/layer IDs follow normal map uniqueness rules. Factories can take IDs
when you want multiple instances. Mutations use normal transactions; setup is
not an implicit transaction over arbitrary DOM or application state. Register
cleanup immediately after acquiring each resource.

## Change rendering

Ordinary appearance changes use `map.layers.update`, `layer.setStyle` and
feature overrides. For advanced rendering there are three independent hooks,
also available outside plugins as `map.render`:

### 1. Transform the shared GPU plan

Both built-in backends and custom renderers consume the transformed plan.
Transforms compose in registration order and are cached for the same base plan
and plugin invalidation epoch. Color-only example:

```ts
import { POINT_STRIDE } from 'maplet';

const bluePoints = map.use(({ render }) => {
  render.transform(plan => ({
    ...plan,
    draws: plan.draws.map(draw => {
      if (draw.type !== 'batch' || draw.batch.kind !== 'points') return draw;
      const data = new Float32Array(draw.batch.data);
      for (let i = 0; i < data.length; i += POINT_STRIDE) {
        data[i + 4] = 0;
        data[i + 5] = 0;
        data[i + 6] = 1;
      }
      return { ...draw, batch: { ...draw.batch, data } };
    }),
  }));
});
```

The advanced plan exports include `FramePlan`, `DrawItem`, `PlanBatch`,
`PlanPickTable`, placements, strides and flags. Packed layouts are documented in
[`src/render/frame-plan.ts`](../src/render/frame-plan.ts). Plans and retained
buffers are borrowed read-only data: **do not mutate them**. Return replacement
objects/buffers only for changed draws. Preserve plan revision, viewport,
pick identities and upload-version semantics; update plan statistics if you
change primitive counts. Pick indices must agree with the plan's pick table.
Maplet does not deep-clone or validate every vertex on behalf of trusted hooks.

The example intentionally copies the affected point buffer; use ordinary styles
for ordinary color changes. Registering a hook does not introduce per-feature
listeners or mandatory full-buffer copies. A hook can still be expensive.

### 2. Draw your own content after each frame

```ts
const overlay = map.use(({ container, render, onCleanup }) => {
  if (!container) throw new Error('This plugin needs a container');
  const canvas = container.ownerDocument.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  container.append(canvas);
  onCleanup(() => canvas.remove());
  const ctx = canvas.getContext('2d')!;

  render.onFrame(({ plan, positionToScreen }) => {
    canvas.width = plan.deviceWidth;
    canvas.height = plan.deviceHeight;
    ctx.setTransform(plan.dpr, 0, 0, plan.dpr, 0, 0);
    canvas.style.width = `${plan.view.width}px`;
    canvas.style.height = `${plan.view.height}px`;
    const p = positionToScreen({ lat: 50.08, lng: 14.42 });
    ctx.fillStyle = 'orange';
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
  });
});
```

Use a positioned map container (`position:relative`). You own the surface and
can use HTML, SVG, Canvas, WebGL or WebGPU, without sharing mutable GPU state
with the built-in renderer. `RenderFrame` includes `map`, `plan`, `time` and a
`positionToScreen()` tied to **that frame's view**, even during async rendering.
These callbacks are synchronous, run in order and finish before `whenRendered`
resolves. Overlay content is not automatically included in GPU picking: bind
DOM events or implement your own hit testing.

### 3. Replace the entire renderer

```ts
const replacement = map.use(({ render, signal, onCleanup }) => {
  // Create your own surface/context and register its removal with onCleanup.
  render.use({
    async render(frame) {
      // Consume frame.plan or render your own representation of frame.map.
      // Await submission/painting; check signal.aborted before late writes.
    },
    async pick(point, { limit }) {
      // Return actual PickResult[] from your renderer, or omit pick entirely.
      return [];
    },
    destroy() { /* release renderer-owned GPU/other resources */ },
  });
});
replacement.remove(); // restores the previous built-in renderer
```

For a custom-only map, avoid GPU initialization with
`createMap({ container, renderer: { primary: 'none' }, plugins: [customPlugin] })`.
A supplied container still enables controls, layout and map gestures. Without
a container, custom rendering can also run headlessly.

Only one replacement can be active; a second installation throws
`dependency-conflict`. The built-in canvas is hidden, built-in draws are skipped,
and `capabilities().backend` reports `'custom'`. Sources, layers, relations,
view and identities stay unchanged. Removing the replacement cancels queued
frames, calls `destroy()` once and restores the default renderer. Late async
completion cannot advance the map's rendered revision after removal; your
renderer must still cancel its own external work using the plugin signal.

Async frames are serialized and coalesced. A frame only completes its captured
revision; updates during rendering schedule a follow-up frame. A custom
renderer can optionally provide `stats()` with actual `instances`, `drawCalls`
and `gpuBytes`; omitted counters are zero, not inferred from the default GPU
plan. Without `pick()`, `query.rendered()` throws `unsupported-capability` and
gestures have no feature hits (pan/zoom still work). With `pick()`, queries and
feature gestures use the replacement's results. `debug.samplePixel()` is only
supported for built-in GPU rendering; read your own surface for custom pixels.

## Redraw and remove

`render.invalidate()` creates a new visual revision and schedules a frame after
plugin-owned state changes. Follow it with `await map.whenRendered()` to wait
for that revision. Invalidations coalesce; they do not discard retained geometry.
Rendering failures emit `map.on('rendererror', ({ error }) => …)` and reject
pending render fences rather than reporting an unpainted frame as complete.

Every `transform`, `onFrame` and `use` registration returns an idempotent removal
function. Registrations through the plugin's **context** `render` are cleaned up
automatically. Registrations made directly through `map.render` must be removed
explicitly or are cleaned up on map destruction.

Checks: `test/scene/plugins.test.ts`, published consumer types in
`type-tests/plugins.test.ts`, and `npm run e2e -- --scenario plugins` (add
`--webgpu` or `--basic` for those profiles). The browser scenario checks real
pixels, HTML cleanup, projected overlays, replacement picking and restoration.
