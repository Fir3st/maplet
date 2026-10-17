/** Hierarchical public layers: real clicks, painter order, mixed content and cleanup. */
export async function layerTree({ session, expect, options }) {
  const start = await session.evaluate(`(async () => {
    window.__e2e.map.destroy();
    const { createMap, crs } = await import('/dist/index.js');
    const map = await createMap('map', {
      projection: crs.simple(), renderer: { primary: '${options.webgpu ? 'webgpu' : 'webgl1'}', fallback: false },
      center: { x: 0, y: 0 }, zoom: 0, controls: ['layers'],
    });
    const places = map.addLayer({ id: 'places' });
    const local = places.addLayer({ id: 'local' });
    const points = local.addPoints([{ id: 'nested', position: { x: 0, y: 0 }, properties: { name: 'Nested' } }], {
      draggable: true, style: { radiusPx: 16, color: '#2563eb' },
    });
    const labels = local.addLabels(points.source, { style: { offsetPx: { x: 0, y: -35 } } });
    const lines = places.addLines([{ positions: [{ x: -0.7, y: 0.5 }, { x: 0.7, y: 0.5 }] }], { style: { color: '#16a34a', widthPx: 8 } });
    const polygons = places.addPolygons([{ rings: [[{ x: 0.4, y: -0.5 }, { x: 0.8, y: -0.5 }, { x: 0.6, y: -0.1 }]] }], { style: { fillColor: '#f97316' } });
    const image = places.addImage({ pixels: { width: 1, height: 1, data: new Uint8Array([139, 92, 246, 255]) },
      bounds: { southwest: { x: -0.8, y: -0.5 }, northeast: { x: -0.4, y: -0.1 } } });
    const basePoints = map.addPoints([{ id: 'base-point', position: { x: 0, y: 0 } }], { style: { radiusPx: 16, color: '#dc2626' } });
    const point = points.get('nested');
    const state = { map, places, local, points, labels, lines, polygons, image, basePoints, point, clicks: [], stop: false };
    point.on('click', () => state.clicks.push('object'));
    points.on('click', () => state.clicks.push('collection'));
    local.on('click', () => state.clicks.push('local'));
    places.on('click', event => { state.clicks.push('places'); if (state.stop) event.stopPropagation(); });
    map.on('click', () => state.clicks.push('map'));
    window.__tree = state;
    await map.whenRendered();
    const center = map.positionToScreen({ x: 0, y: 0 });
    const checkbox = document.querySelector('input[data-layer-id="places"]');
    const rect = checkbox.getBoundingClientRect();
    return { center, checkbox: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      roots: map.layers.list().map(layer => layer.id), controls: [...document.querySelectorAll('input[data-layer-id]')].map(input => input.dataset.layerId),
      pointPixel: await map.debug.samplePixel(center),
      linePixel: await map.debug.samplePixel(map.positionToScreen({ x: 0, y: 0.5 })),
      polygonPixel: await map.debug.samplePixel(map.positionToScreen({ x: 0.6, y: -0.4 })),
      imagePixel: await map.debug.samplePixel(map.positionToScreen({ x: -0.6, y: -0.3 })) };
  })()`);
  const rgb = (pixel) => [pixel.r, pixel.g, pixel.b].join(',');
  expect.equal(
    start.roots.join(','),
    'base,places',
    'ordinary map additions use one base underneath explicit layers',
  );
  expect.equal(
    start.controls.join(','),
    'base,places',
    'layer controls show root layers in painter order, not internal collections',
  );
  expect.equal(
    rgb(start.pointPixel),
    '37,99,235',
    'nested points render above the base created later',
  );
  expect.equal(rgb(start.linePixel), '22,163,74', 'the same logical layer renders lines');
  expect.equal(rgb(start.polygonPixel), '249,115,22', 'the same logical layer renders polygons');
  expect.equal(rgb(start.imagePixel), '139,92,246', 'the same logical layer renders image media');
  await session.move(start.center.x, start.center.y);
  await session.click(start.center.x, start.center.y);
  await session.waitFor('window.__tree.clicks.length === 5', 5000, 'nested click bubbling');
  expect.equal(
    (await session.evaluate('window.__tree.clicks')).join(','),
    'object,collection,local,places,map',
    'events bubble through every actual ancestor',
  );
  await session.evaluate('window.__tree.clicks.length = 0; window.__tree.stop = true');
  await session.click(start.center.x, start.center.y);
  await session.waitFor('window.__tree.clicks.length === 4', 5000, 'stopped nested click');
  expect.equal(
    (await session.evaluate('window.__tree.clicks')).join(','),
    'object,collection,local,places',
    'ancestor stopPropagation prevents map delivery',
  );
  await session.click(start.checkbox.x, start.checkbox.y);
  const hidden = await session.evaluate(`(async () => {
    const { map, local, places, points } = window.__tree;
    await map.whenRendered();
    const center = map.positionToScreen({ x: 0, y: 0 });
    return { visible: places.isVisible(), childVisible: local.isVisible(), count: points.count(),
      pixel: await map.debug.samplePixel(center), hit: (await map.query.rendered(center))[0]?.feature.id };
  })()`);
  expect.ok(
    !hidden.visible && !hidden.childVisible,
    'real layer-control input hides all descendants',
  );
  expect.equal(rgb(hidden.pixel), '220,38,38', 'hiding the whole subtree reveals the base');
  expect.equal(hidden.hit, 'base-point', 'hidden descendants cannot intercept picking');
  expect.equal(hidden.count, 1, 'hiding the subtree retains its data');
  const reordered = await session.evaluate(`(async () => {
    const { map, places } = window.__tree;
    places.show();
    places.move({ before: 'base' });
    await map.whenRendered();
    const below = await map.debug.samplePixel(map.positionToScreen({ x: 0, y: 0 }));
    places.move({ after: 'base' });
    await map.whenRendered();
    const above = await map.debug.samplePixel(map.positionToScreen({ x: 0, y: 0 }));
    return { below, above };
  })()`);
  expect.equal(
    rgb(reordered.below),
    '220,38,38',
    'moving a logical layer reorders its complete subtree',
  );
  expect.equal(
    rgb(reordered.above),
    '37,99,235',
    'restoring subtree order restores the visible nested point',
  );
  const cleanup = await session.evaluate(`(async () => {
    const { map, places, local, points, lines, polygons, image } = window.__tree;
    const rescue = map.addLayer({ id: 'rescue' });
    local.move({ into: rescue.id });
    places.remove();
    let stale = false;
    try { places.addPoints([]); } catch (error) { stale = error.code === 'destroyed'; }
    await map.whenRendered();
    const movedPixel = await map.debug.samplePixel(map.positionToScreen({ x: 0, y: 0 }));
    const released = [lines.sourceId, polygons.sourceId, image.sourceId].every(id => !map.data.get(id));
    const retained = map.data.get(points.sourceId) !== undefined && local.parentId === rescue.id;
    rescue.remove();
    await map.whenRendered();
    return { stale, released, retained, movedPixel, sources: map.data.list().length,
      finalPixel: await map.debug.samplePixel(map.positionToScreen({ x: 0, y: 0 })) };
  })()`);
  expect.ok(
    cleanup.stale && cleanup.released && cleanup.retained,
    'removal releases only current descendants and invalidates the old receiver',
  );
  expect.equal(rgb(cleanup.movedPixel), '37,99,235', 'a moved-out nested layer stays rendered');
  expect.equal(cleanup.sources, 1, 'final subtree cleanup leaves only the independent base source');
  expect.equal(
    rgb(cleanup.finalPixel),
    '220,38,38',
    'removing the moved subtree restores the independent base',
  );
}
