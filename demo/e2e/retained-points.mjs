/** Actual GPU uploads plus pixel/pick checks, not just planner instrumentation. */
export async function retainedPoints({ session, expect, options }) {
  const result = await session.evaluate(`(async () => {
    window.__e2e.map.destroy();
    const { createMap, expr } = await import('/dist/index.js');
    const map = await createMap({ container: 'map', renderer: { primary: '${options.webgpu ? 'webgpu' : 'webgl1'}', fallback: false },
      view: { center: { lat: 50, lng: 14 }, zoom: 10 } });
    const source = map.sources.vector({ id: 'retained' });
    const positions = new Float64Array(20000 * 2);
    for (let i = 0; i < 20000; i++) {
      positions[i * 2] = 14 - 0.1 + i % 200 * 0.001;
      positions[i * 2 + 1] = 50 - 0.05 + Math.floor(i / 200) * 0.001;
    }
    await source.importColumnar({ kind: 'point', positions, ids: Array.from({ length: 20000 }, (_, i) => i) }, { copy: false });
    const layer = map.layers.add({ id: 'points', type: 'points', source, style: {
      radiusPx: 2, color: expr.when(expr.state('hovered'), '#22c55e', '#2563eb') } });
    source.features.update(0, { geometry: { type: 'point', position: { lat: 50, lng: 14 } } });
    layer.features.setOverride(0, { color: '#e11d48', radiusPx: 8, zIndex: 1 });
    await map.whenRendered();
    const calls = [];
    const restores = [];
    const wrap = (prototype, name, measure) => {
      const original = prototype[name];
      prototype[name] = function (...args) { measure(...args); return original.apply(this, args); };
      restores.push(() => prototype[name] = original);
    };
    if (map.capabilities().backend === 'webgl1') {
      wrap(WebGLRenderingContext.prototype, 'bufferData', (target, data, usage) => {
        if (usage === WebGLRenderingContext.DYNAMIC_DRAW) calls.push({ full: true, bytes: data.byteLength });
      });
      wrap(WebGLRenderingContext.prototype, 'bufferSubData', (target, offset, data) => calls.push({ full: false, bytes: data.byteLength }));
    } else {
      wrap(GPUQueue.prototype, 'writeBuffer', (buffer, offset, data) => {
        if (buffer.usage & GPUBufferUsage.VERTEX) calls.push({ full: data.byteLength > 64, bytes: data.byteLength });
      });
    }
    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });
    const screen = () => map.view.positionToScreen(source.features.get(0).geometry.position);
    const color = async () => {
      const pixel = await map.debug.samplePixel(screen());
      const scale = pixel.a > 0 ? 255 / pixel.a : 1;
      return [pixel.r, pixel.g, pixel.b].map(value => Math.round(value * scale));
    };
    const near = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) <= 3);
    const patchBytes = ${options.basic ? 432 : 64};
    const local = (name) => check(name, calls.length === 1 && !calls[0].full && calls[0].bytes === patchBytes, calls.slice());
    try {
      map.view.set({ center: map.view.screenToPosition({ x: map.size().width / 2 + 10, y: map.size().height / 2 }) });
      await map.whenRendered();
      const panColor = await color();
      check('pan changes uniforms without uploading point data', calls.length === 0 && near(panColor, [225,29,72]), { calls: calls.slice(), color: panColor });
      calls.length = 0;
      layer.features.setOverride(0, { color: '#22c55e', radiusPx: 8, zIndex: 1 });
      await map.whenRendered();
      local('one color edit uploads one instance');
      check('color reaches the screen', near(await color(), [34,197,94]));
      calls.length = 0;
      const oldScreen = screen();
      source.features.update(0, { geometry: { type: 'point', position: map.view.screenToPosition({ x: oldScreen.x + 40, y: oldScreen.y }) } });
      await map.whenRendered();
      local('one move uploads one instance');
      check('moved point is pickable with its original identity', (await map.query.rendered(screen()))[0]?.feature.id === 0);
      check('moved point has the expected color', near(await color(), [34,197,94]));
      calls.length = 0;
      layer.features.setOverride(0, { visible: false, radiusPx: 8, zIndex: 1 });
      await map.whenRendered();
      local('hide uploads one instance');
      check('hidden point is not picked and all data stays', !(await map.query.rendered(screen())).some(hit => hit.feature.id === 0) && source.features.count() === 20000);
      calls.length = 0;
      layer.features.setOverride(0, { radiusPx: 8, zIndex: 1 });
      await map.whenRendered();
      local('show uploads one instance');
      calls.length = 0;
      map.state.set(source.features.ref(0), { hovered: true });
      await map.whenRendered();
      local('hover updates only one instance');
      check('hover style reaches the screen', near(await color(), [34,197,94]));
      calls.length = 0;
      map.view.set({ center: map.view.screenToPosition({ x: map.size().width / 2 + 100, y: map.size().height / 2 }) });
      await map.whenRendered();
      check('large pan refreshes the resident set rather than dropping points', calls.some(call => call.full) && near(await color(), [34,197,94]), calls.slice());
    } finally {
      for (const restore of restores) restore();
      map.destroy();
    }
    return checks;
  })()`);
  for (const check of result) expect.ok(check.pass, `${check.name}: ${JSON.stringify(check.detail ?? null)}`);
}
