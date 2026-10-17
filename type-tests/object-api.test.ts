import {
  createMap,
  crs,
  style,
  type FeatureRef,
  type Geometry,
  type LayerHandle,
  type PointGeometry,
  type SourceLayerSpec,
} from '@fir3st/maplet';

interface StationProperties {
  readonly name: string;
  readonly status: 'online' | 'offline';
}

export async function objectConsumer(container: HTMLElement): Promise<void> {
  const map = await createMap(container, {
    center: [50.08, 14.44],
    zoom: 8,
    controls: ['zoom', 'scale', 'attribution'],
  });
  const stations = map.addPoints<StationProperties>(
    [{ id: 'prague', position: [50.08, 14.44], properties: { name: 'Prague', status: 'online' } }],
    {
      draggable: true,
      style: {
        radiusPx: 9,
        color: style.by('status', { online: '#16a34a', offline: '#dc2626' }, '#6b7280'),
      },
    },
  );
  const prague = stations.get('prague');
  if (prague) {
    const setPosition = prague.setPosition.bind(prague);
    setPosition([50.1, 14.5]);
    prague.setProperties({ status: 'offline' });
    const ref: FeatureRef<Geometry> = prague.ref;
    map.selection.add([ref]);
    map.selection.add([prague.ref]);
    map.state.set(prague.ref, { selected: true });
    stations.setFeatureStyle(prague.ref, { color: '#0000ff' });
    map.relations.neighbors(prague.ref);
    map.bindings.add({
      id: 'copy-name',
      target: prague.ref,
      properties: { kind: 'copyProperty', from: prague.ref, field: 'name' },
    });
    const other = map.data.vector<PointGeometry, { readonly name: number }>({ id: 'other' });
    // @ts-expect-error identity-only APIs accept refs, but typed writes reject incompatible properties
    other.features.update(prague.ref, { properties: { name: 1 } });
    // @ts-expect-error a typed object cannot accept an unknown status
    prague.setProperties({ status: 'paused' });
    // @ts-expect-error point coordinates require a full position
    setPosition([50]);
    // @ts-expect-error object snapshots remain readonly
    prague.get().properties.name = 'changed';
  }
  stations.on('click', (event) => {
    const type: 'click' = event.type;
    void type;
  });
  // @ts-expect-error object events do not accept the old aggregate name
  stations.on('feature', () => {});
  // @ts-expect-error styles are still typed, not arbitrary records
  stations.setStyle({ radiusPx: '#ff0000' });
  map.on('click', (event) => {
    if (event.feature) {
      const id: string | number = event.feature.id;
      void id;
    } else {
      const empty: null = event.feature;
      void empty;
    }
  });
  const source = map.data.vector<PointGeometry, StationProperties>({ id: 'shared' });
  map.addPoints(source);
  map.addLabels(source);
  const places: LayerHandle = map.addLayer({ id: 'places' });
  const local = places.addLayer({ id: 'local' });
  const nested = local.addPoints<StationProperties>([
    { position: [50, 14], properties: { name: 'Nested', status: 'online' } },
  ]);
  local.addLines([
    {
      positions: [
        [50, 14],
        [51, 15],
      ],
    },
  ]);
  local.addPolygons([
    {
      rings: [
        [
          [50, 14],
          [51, 15],
          [50, 15],
        ],
      ],
    },
  ]);
  places.addLabels(nested.source);
  local.addTiles('/tiles/{z}/{x}/{y}.png');
  const spec: SourceLayerSpec<'points'> = { type: 'points', source, style: { radiusPx: 8 } };
  const pass = local.addLayer(spec);
  const kind: 'points' = pass.kind;
  void kind;
  map.base.addPoints([]);
  places.hide();
  local.move({ into: null, index: 0 });
  const entry = map.layers.get('places');
  if (entry?.kind === 'layer') entry.addPoints([]);
  else if (entry) entry.setFeatureStyle('a', { visible: false });
  // @ts-expect-error logical containers have no one-geometry base style
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- the call is the deliberate error above
  places.setStyle({ radiusPx: 8 });
  // @ts-expect-error the nested point properties retain their concrete type
  nested.get('a')!.setProperties({ status: 'paused' });
  // @ts-expect-error the separate grouping API was replaced by recursive layers
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- deliberate removed-API error
  map.groups.add({ id: 'old-group' });
  // @ts-expect-error use the receiving layer or parent, not the old group option
  map.addPoints([], { group: 'places' });
  // @ts-expect-error a batch cannot span an asynchronous callback
  map.batch(async () => {
    await Promise.resolve();
  });
  map.addTiles('/tiles/{z}/{x}/{y}.png', { attribution: 'Test' });
  map
    .addLines([
      {
        positions: [
          [50, 14],
          [51, 15],
        ],
      },
    ])
    .add({
      positions: [
        [49, 13],
        [50, 14],
      ],
    })
    .setPositions([
      [48, 12],
      [49, 13],
    ]);
  // @ts-expect-error geographic tuples contain exactly two numbers
  map.setCenter([50, 14, 100]);
  // @ts-expect-error old facade is intentionally removed
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- deliberate removed-API error
  map.sources.vector({ id: 'legacy' });
  // @ts-expect-error old nested view is intentionally removed
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- deliberate removed-API error
  map.view.set({ zoom: 8 });
  // @ts-expect-error creation requires the container separately
  void createMap({ container, view: { zoom: 8 } });
  // @ts-expect-error old nested creation options are intentionally removed
  void createMap(container, { view: { zoom: 8 } });
  await createMap(null, { renderer: 'none', projection: crs.simple(), center: { x: 0, y: 0 } });
}
