/** Public-package browser checks: actual GPU pixels, DOM and Canvas replacement. */
export async function plugins({ session, expect, options }) {
  const result = await session.evaluate(`(async () => {
    const { createMap, crs, POINT_STRIDE } = await import('/dist/index.js');
    const container = document.createElement('div');
    container.style.cssText = 'position:relative;width:320px;height:240px';
    document.body.append(container);
    const map = await createMap(container, { projection: crs.simple(), renderer: { primary: '${options.webgpu ? 'webgpu' : 'webgl1'}', fallback: false }, center: { x: 0, y: 0 }, zoom: 0 });
    const point = { x: 160, y: 120 };
    try {
      const source = map.data.vector({ id: 'plugin-points' });
      source.features.add({ id: 'p', geometry: { type: 'point', position: { x: 0, y: 0 } } });
      map.addLayer({ id: 'plugin-points', type: 'points', source, style: { color: '#ff0000', radiusPx: 20 } });
      await map.whenRendered();
      const original = await map.debug.samplePixel(point);
      let hooks = 0;
      const plugin = map.use(({ container, render, onCleanup }) => {
        const label = document.createElement('span');
        label.textContent = 'plugin HTML'; container.append(label); onCleanup(() => label.remove());
        render.transform((plan) => ({ ...plan, draws: plan.draws.map((draw) => {
          if (draw.type !== 'batch' || draw.batch.kind !== 'points') return draw;
          const data = new Float32Array(draw.batch.data);
          for (let i = 0; i < data.length; i += POINT_STRIDE) { data[i + 4] = 0; data[i + 5] = 0; data[i + 6] = 1; }
          return { ...draw, batch: { ...draw.batch, data } };
        }) }));
        const overlay = document.createElement('canvas'); overlay.width = 320; overlay.height = 240;
        overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none'; container.append(overlay); onCleanup(() => overlay.remove());
        render.onFrame(({ positionToScreen }) => {
          hooks++; const ctx = overlay.getContext('2d'); const p = positionToScreen({ x: 40 / 256, y: 0 });
          ctx.clearRect(0, 0, 320, 240); ctx.fillStyle = '#00ff00'; ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
        });
        return { overlay, label };
      });
      await map.whenRendered();
      const transformed = await map.debug.samplePixel(point);
      const picked = await map.query.rendered(point);
      const overlayPixel = [...plugin.api.overlay.getContext('2d').getImageData(200, 120, 1, 1).data];
      const htmlAdded = plugin.api.label.isConnected;
      plugin.remove(); await map.whenRendered();
      const restored = await map.debug.samplePixel(point);
      const htmlRemoved = !plugin.api.label.isConnected && !plugin.api.overlay.isConnected;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      canvas.style.cssText = 'position:absolute;inset:0'; container.append(canvas);
      const ctx = canvas.getContext('2d'); let disposed = 0;
      const replacement = map.use(({ render, onCleanup }) => {
        onCleanup(() => canvas.remove());
        render.use({
          render: ({ positionToScreen }) => { ctx.clearRect(0, 0, 320, 240); const p = positionToScreen({ x: 0, y: 0 }); ctx.fillStyle = '#00ff00'; ctx.fillRect(p.x - 10, p.y - 10, 20, 20); },
          pick: async () => picked,
          destroy: () => { disposed++; },
        });
      });
      await map.whenRendered();
      const customPixel = [...ctx.getImageData(160, 120, 1, 1).data];
      const defaultHidden = container.querySelector('canvas:not(:last-child)').style.visibility === 'hidden';
      const customBackend = map.capabilities().backend;
      const customPick = (await map.query.rendered(point))[0]?.feature.id;
      replacement.remove(); await map.whenRendered();
      const final = await map.debug.samplePixel(point);
      return { original, transformed, restored, final, overlayPixel, customPixel, hooks, htmlAdded, htmlRemoved, defaultHidden, customBackend, customPick, disposed, backend: map.capabilities().backend, featureCount: source.features.count() };
    } finally { map.destroy(); container.remove(); }
  })()`);
  const red = (p) => p.r > 240 && p.g < 10 && p.b < 10 && p.a > 240;
  expect.ok(red(result.original), 'baseline renders red');
  expect.ok(
    result.transformed.b > 240 && result.transformed.r < 10,
    'plan transform changes real GPU pixels',
  );
  expect.ok(
    red(result.restored) && red(result.final),
    'both removals restore original GPU rendering',
  );
  expect.equal(result.featureCount, 1, 'render changes preserve source data');
  expect.ok(result.htmlAdded && result.htmlRemoved, 'HTML mounts and cleans up');
  expect.ok(
    result.hooks > 0 && result.overlayPixel[1] === 255,
    'onFrame paints a projected Canvas overlay',
  );
  expect.ok(
    result.defaultHidden && result.customBackend === 'custom',
    'replacement hides the built-in canvas',
  );
  expect.equal(result.customPixel[1], 255, 'replacement renderer actually paints');
  expect.equal(result.customPick, 'p', 'replacement delegates picking');
  expect.equal(result.disposed, 1, 'renderer is destroyed exactly once');
  expect.equal(
    result.backend,
    options.webgpu ? 'webgpu' : 'webgl1',
    'removal restores the requested backend',
  );

  const customOnly = await session.evaluate(`(async () => {
    const { createMap, crs } = await import('/dist/index.js');
    const container = document.createElement('div');
    container.style.cssText = 'position:relative;width:320px;height:240px'; document.body.append(container);
    let surface, control, lastFrame;
    const map = await createMap(container, { projection: crs.simple(), renderer: { primary: 'none' }, center: { x: 0, y: 0 }, zoom: 0, plugins: [({ map, render, onCleanup }) => {
            const source = map.data.vector({ id: 'custom-only' });
            onCleanup(() => map.data.remove(source.id));
            source.features.add({ id: 'p', geometry: { type: 'point', position: { x: 0, y: 0 } } });
            const layer = map.addLayer({ id: 'custom-only', type: 'points', source });
            onCleanup(layer.remove);
            control = map.addControl({ id: 'custom-zoom', kind: 'zoom' });
            onCleanup(control.remove);
            control.element().title = 'Changed by plugin';
            surface = document.createElement('canvas');
            surface.style.cssText = 'position:absolute;inset:0;pointer-events:none';
            container.append(surface);
            onCleanup(() => surface.remove());
            const ctx = surface.getContext('2d');
            render.use({
                render(frame) {
                    lastFrame = frame;
                    surface.width = frame.plan.deviceWidth;
                    surface.height = frame.plan.deviceHeight;
                    surface.style.width = frame.plan.view.width + 'px';
                    surface.style.height = frame.plan.view.height + 'px';
                    ctx.setTransform(frame.plan.dpr, 0, 0, frame.plan.dpr, 0, 0);
                    const p = frame.positionToScreen({ x: 0, y: 0 });
                    ctx.fillStyle = '#00ff00';
                    ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
                },
                async pick(point, { limit }) {
                    const p = lastFrame.positionToScreen({ x: 0, y: 0 });
                    return limit > 0 && Math.abs(point.x - p.x) <= 10 && Math.abs(point.y - p.y) <= 10
                        ? [{ feature: source.features.ref('p'), sourceId: source.id, layerId: layer.id, screen: point, revision: lastFrame.plan.revision }] : [];
                },
            });
        }] });
    try {
      await map.whenRendered();
      const hit = (await map.query.rendered({ x: 160, y: 120 }))[0]?.feature.id;
      const miss = (await map.query.rendered({ x: 10, y: 10 })).length;
      const size = map.size(); const oldCenter = map.getView().center.x;
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await map.whenRendered();
      return { hit, miss, size, canvases: container.querySelectorAll('canvas').length, changedHtml: control.element().title, keyboardPanned: map.getView().center.x !== oldCenter, interactive: map.interaction !== null };
    } finally { map.destroy(); container.remove(); }
  })()`);
  expect.equal(
    customOnly.canvases,
    1,
    'custom-only creation does not initialize a built-in GPU canvas',
  );
  expect.ok(
    customOnly.size.width === 320 && customOnly.size.height === 240,
    'custom-only creation measures its actual container',
  );
  expect.equal(customOnly.changedHtml, 'Changed by plugin', 'plugin can modify existing controls');
  expect.ok(
    customOnly.hit === 'p' && customOnly.miss === 0,
    'custom-only renderer hit testing agrees with painted geometry',
  );
  expect.ok(
    customOnly.interactive && customOnly.keyboardPanned,
    'custom-only map retains keyboard map interaction',
  );
}
