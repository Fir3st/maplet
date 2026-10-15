# Filter and inspect a field dataset

Forty-eight sites on a real basemap: filter them by kind or state, fit the view
to the matches, click a site for its detail and watch the "current view" counter
follow the map. This is the inspect-and-edit loop of most internal tools.

## The shape of the recipe

```ts
const points = layer.addPoints(sites, {
  style: {
    radiusPx: style.when(style.state('selected'), 9, style.when(style.state('hovered'), 8, 6)),
    color: style.by('status', { open: '#16724c', busy: '#c98a1b', closed: '#8b9a91' }, '#66776d'),
    opacity: style.when(style.state('disabled'), 0, 1),
    strokeColor: '#ffffff',
    strokeWidthPx: 2,
  },
});
layer.addLabels(points.source, {
  style: {
    text: style.when(style.state('disabled'), '', style.field('code')),
    collision: true,
    minZoom: 12.5,
  },
});

map.state.set(points.get('site-07').ref, { disabled: true });   // filtered out
points.on('click', (event) => {
  points.get(event.feature.id)?.select();
  map.detail.open(event.feature, { content: detailNode });
});

const result = map.query.area(map.getBounds(), { sources: [points.source.id] });
```

## Live example

Filter by category, tick **Only sites open now**, click a site for its detail,
then pan or zoom: the in-view count follows `viewend`.

<!-- example -->

## What the recipe shows

- Filtering writes one shared state flag (`map.state.set(ref, { disabled })`).
  The dots and their labels both read it through `style.state('disabled')`, so a
  filtered-out site cannot leave a floating code or an invisible click target
  behind. The records themselves stay untouched: hiding is not deleting.
- Hidden data stays in the source, so `map.query.area()` still returns it. The
  counter applies the same filter rule to the query result — the pattern to copy
  whenever filters and queries meet.
- Labels stay readable through collision culling and a `minZoom`: codes appear
  when the view is close enough to use them.
- Clicking a site selects it and opens `map.detail`, which follows the feature
  while panning, closes on removal and renders caller-owned content.
- The recipe scales to hundreds of sites without changing shape: one collection
  listener, one label layer and one bounded query.

See [queries](../interaction.md#queries), [feature details](../interaction.md#feature-details)
and [collection styles](../rendering.md#collection-and-object-styles).
