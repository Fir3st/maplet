/** New public calls, real pointer input, actual GPU pixels and generation reuse. */
export async function objectApi({ session, expect, options }) {
  const screen = await session.evaluate(`(async () => {
    window.__e2e.map.destroy();
    const { createMap, crs, style } = await import('/dist/index.js');
    const map = await createMap('map', {
      projection: crs.simple(), renderer: { primary: '${options.webgpu ? 'webgpu' : 'webgl1'}', fallback: false },
      center: { x: 0, y: 0 }, zoom: 0, controls: ['zoom'],
    });
    const points = map.addPoints([{ id: 'a', position: { x: 0, y: 0 }, properties: { name: 'A', status: 'online' } }], {
      draggable: true, style: { radiusPx: 16, color: style.by('status', { online: '#16a34a', offline: '#dc2626' }, '#6b7280') },
    });
    const point = points.get('a');
    const events = [];
    point.on('click', () => events.push('object'));
    points.on('click', () => events.push('layer'));
    points.once('dragend', () => events.push('dragend'));
    map.on('click', event => events.push(event.feature ? 'map' : 'background'));
    map.addLabels(points.source, { style: { offsetPx: { x: 0, y: -35 } } });
    await map.whenRendered();
    window.__objects = { map, points, point, events };
    return map.positionToScreen(point.getPosition());
  })()`);
  await session.move(screen.x, screen.y);
  await session.click(screen.x, screen.y);
  await session.waitFor("window.__objects.events.includes('map')", 5000, 'direct click bubbling');
  const clicked = await session.evaluate('window.__objects.events');
  expect.equal(clicked.join(','), 'object,layer,map', 'direct object/layer/map clicks bubble in order');
  await session.mouse('mousePressed', screen.x, screen.y);
  await new Promise(resolve => setTimeout(resolve, 100));
  await session.mouse('mouseMoved', screen.x + 40, screen.y + 20, { dragging: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  await session.mouse('mouseReleased', screen.x + 40, screen.y + 20);
  await session.waitFor("window.__objects.events.includes('dragend')", 5000, 'direct drag event');
  const result = await session.evaluate(`(async () => {
    const { map, points, point, events } = window.__objects;
    await map.whenRendered();
    const dropped = map.positionToScreen(point.getPosition());
    const before = point.ref;
    point.setProperties({ status: 'offline' });
    await map.whenRendered();
    const pixel = await map.debug.samplePixel(dropped);
    const hits = await map.query.rendered(dropped);
    const count = points.count();
    point.hide(); await map.whenRendered();
    const hiddenHits = await map.query.rendered(dropped);
    point.show(); await map.whenRendered();
    point.remove();
    const replacement = points.add({ id: 'a', position: { x: 0, y: 0 }, properties: { status: 'online' } });
    let stale = false;
    try { point.setPosition({ x: 1, y: 1 }); } catch (error) { stale = error.code === 'stale-reference'; }
    await map.whenRendered();
    return { dropped, pixel, hit: hits[0]?.feature.id, hidden: hiddenHits.length, count, stale,
      newGeneration: replacement.ref.generation !== before.generation, dragends: events.filter(type => type === 'dragend').length };
  })()`);
  expect.ok(Math.abs(result.dropped.x - screen.x - 40) < 1 && Math.abs(result.dropped.y - screen.y - 20) < 1, 'inline point drag follows the pointer');
  expect.ok(Math.abs(result.pixel.r - 220) <= 3 && Math.abs(result.pixel.g - 38) <= 3 && Math.abs(result.pixel.b - 38) <= 3, 'property style changes reach the GPU');
  expect.equal(result.hit, 'a', 'new inline point layer participates in picking');
  expect.equal(result.hidden, 0, 'object hide excludes picking');
  expect.equal(result.count, 1, 'hide keeps source data');
  expect.ok(result.stale && result.newGeneration, 'old objects do not rebind when their id is reused');
  expect.equal(result.dragends, 1, 'once(dragend) ignores preceding hover/click events');
  await session.click(60, 60);
  await session.waitFor("window.__objects.events.includes('background')", 5000, 'background click');
}
