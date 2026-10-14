/** Verify and time single-feature mutations in the full 500k scene. */
export async function compareUpdates({ session, expect }) {
  expect.ok(await session.evaluate('window.__compareCheckResult.pass'), 'rendering prerequisites pass');
  const detail = await session.evaluate(`(async () => {
    const { map, engine, points, source } = window.__comparison;
    const side = Math.ceil(Math.sqrt(500000));
    const index = (side / 2) * side + side / 2;
    const id = 'p:' + index;
    const point = points?.[index];
    const layer = engine === 'maplet' ? map.layers.get('points') : null;
    const ref = engine === 'maplet' ? source.features.ref(id) : null;
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const samples = [];
    let visible = true;
    let color = '#e11d48';
    let x = 360;
    const setOverride = () => layer.setFeatureStyle(ref, { visible, color, radiusPx: 8, zIndex: 1 });
    const sample = async (screen) => {
      if (engine === 'maplet') return map.debug.samplePixel(screen);
      const at = map.containerPointToLayerPoint(screen).subtract(map.options.renderer._bounds.min);
      const ctx = map.options.renderer._ctx;
      const dpr = ctx.getTransform().a;
      const data = ctx.getImageData(Math.round(at.x * dpr), Math.round(at.y * dpr), 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] };
    };
    const matches = (pixel, value) => {
      const rgb = [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
      // GPU readback contains premultiplied RGB; Canvas2D getImageData
      // returns straight RGB. Normalize before comparing CSS colors.
      const scale = engine === 'maplet' && pixel.a > 0 ? 255 / pixel.a : 1;
      return Math.abs(pixel.r * scale - rgb[0]) <= 3 && Math.abs(pixel.g * scale - rgb[1]) <= 3 &&
        Math.abs(pixel.b * scale - rgb[2]) <= 3 && pixel.a >= 250;
    };
    // Lift one actual dataset point above its densely overlapping neighbors.
    // Both renderers keep all other 499,999 points and their interactions.
    if (engine === 'maplet') setOverride();
    else { point.setRadius(8).setStyle({ fillColor: color }).bringToFront(); }
    await nextFrame();
    await nextFrame();
    const initialPixel = await sample({ x, y: 260 });
    for (let repetition = 0; repetition < 5; repetition++) {
      for (const operation of ['hide', 'show', 'color', 'position']) {
        const oldX = x;
        const started = performance.now();
        if (operation === 'hide' || operation === 'show') {
          visible = operation === 'show';
          if (engine === 'maplet') setOverride();
          else if (visible) point.addTo(map);
          else map.removeLayer(point);
        } else if (operation === 'color') {
          color = color === '#e11d48' ? '#22c55e' : '#e11d48';
          if (engine === 'maplet') setOverride();
          else point.setStyle({ fillColor: color });
        } else {
          x = x === 360 ? 400 : 360;
          if (engine === 'maplet') source.features.update(id, { geometry: {
            type: 'point', position: map.screenToPosition({ x, y: 260 }) } });
          else point.setLatLng(map.containerPointToLatLng([x, 260]));
        }
        const apiMs = performance.now() - started;
        // Identical two-animation-frame paint fence; not a GPU-only timer.
        await nextFrame();
        await nextFrame();
        if (engine === 'maplet') await map.whenRendered(map.stats().revision);
        const toFrameMs = performance.now() - started;
        const pixel = await sample({ x, y: 260 });
        const oldPixel = operation === 'position' ? await sample({ x: oldX, y: 260 }) : null;
        const retained = engine === 'maplet' ? source.features.count() === 500000 && source.features.has(id) :
          points.length === 500000 && map.hasLayer(point) === visible;
        samples.push({ operation, repetition, apiMs, toFrameMs,
          pass: retained && matches(pixel, visible ? color : '#2563eb') &&
            (oldPixel === null || matches(oldPixel, '#2563eb')), pixel, oldPixel });
      }
    }
    const summarize = (operation, metric) => {
      const times = samples.filter(s => s.operation === operation).map(s => s[metric]).sort((a, b) => a - b);
      const pct = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * q))] * 10) / 10;
      return { samples: times.length, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: pct(1) };
    };
    return { engine, count: 500000, targetId: id, radiusCssPx: 8,
      pass: matches(initialPixel, '#e11d48') && samples.every(s => s.pass),
      summary: Object.fromEntries(['hide', 'show', 'color', 'position'].map(operation => [operation,
        { api: summarize(operation, 'apiMs'), toFrame: summarize(operation, 'toFrameMs') }])), samples };
  })()`);
  expect.ok(detail.pass, 'all 20 single-point changes preserve data and produce the expected pixels');
  console.log('\n    updates-result — ' + JSON.stringify(detail));
}
