# A plugin is a function

Install a pin plugin, call its returned API and remove its layers and HTML.
Plugins use the same public map API as applications.

## Own the resources you create

```ts
function pinsPlugin({ map, onCleanup }) {
  const layer = map.addLayer({ id: 'plugin-pins' });
  onCleanup(layer.remove);
  const pins = layer.addPoints([]);
  return {
    add(position) {
      return pins.add({ position });
    },
  };
}
const installed = map.use(pinsPlugin);
installed.api.add([50.08, 14.44]);
```

Setup is synchronous. Register cleanup immediately after acquisition; it runs in
reverse order. The context's AbortSignal stops asynchronous work on removal.

## Live example

Add a pin, remove the plugin, then install it again. The plugin owns its logical
layer, inline source and badge; the example's background grid remains.

<!-- example -->

## Remove an installation

`installed.remove()` is idempotent, and map destruction removes installations too.
Rendering hooks registered through the context are scoped to that installation.
See the [full plugin guide](../plugins.md) for plan transforms, frame hooks and
replaceable renderers.
