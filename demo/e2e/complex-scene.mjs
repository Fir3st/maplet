/** Matched public-API workload. No internal cache/renderer hooks or altered clocks. */
export async function complexScene({ session, expect, options }) {
  const result = await session.evaluate(`(async () => {
    window.__e2e.map.destroy();
    document.getElementById('map').style.width = '720px';
    document.getElementById('map').style.height = '520px';
    const { createMap, crs, expr } = await import('/dist/index.js');
    const map = await createMap({ container: 'map', projection: crs.simple(), size: { width: 720, height: 520 },
      renderer: { primary: '${options.webgpu ? 'webgpu' : 'webgl1'}', fallback: false }, view: { center: { x: 0, y: 0 }, zoom: 0 } });
    const lines = map.sources.vector({ id: 'lines' }), areas = map.sources.vector({ id: 'areas' }), symbols = map.sources.vector({ id: 'symbols' });
    const lineXY = [], lineOffsets = [0], polygonXY = [], ringOffsets = [0], polygonOffsets = [0];
    for (let f = 0; f < 96; f++) {
      for (let i = 0; i < 256; i++) lineXY.push(-1.2 + i * 2.4 / 255, -0.9 + f * 1.8 / 95 + Math.sin(i * 0.2 + f) * 0.008);
      lineOffsets.push(lineXY.length / 2);
    }
    for (let f = 0; f < 64; f++) {
      const x = -1.05 + (f % 8) * 0.3, y = -0.8 + Math.floor(f / 8) * 0.22;
      for (const [cx, cy, r, count] of [[x, y, 0.09, 128], [x - 0.03, y, 0.025, 8], [x + 0.03, y, 0.025, 8]]) {
        for (let i = 0; i < count; i++) { const a = i * Math.PI * 2 / count; polygonXY.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
        ringOffsets.push(polygonXY.length / 2);
      }
      polygonOffsets.push(ringOffsets.length - 1);
    }
    const symbolXY = new Float64Array(2048 * 2), properties = [];
    for (let i = 0; i < 2048; i++) {
      symbolXY[i * 2] = -1.2 + (i % 64) * 2.4 / 63;
      symbolXY[i * 2 + 1] = -0.88 + Math.floor(i / 64) * 1.76 / 31;
      properties.push({ name: 'Label ' + (i % 256), image: 'image-' + (i % 16) });
    }
    for (let i = 0; i < 16; i++) {
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = i % 2 ? '#ee6633' : '#2266dd'; ctx.fillRect(0, 0, 8, 8);
      await map.assets.addImage({ id: 'image-' + i, src: canvas.toDataURL() }).ready();
    }
    const heap = () => performance.memory?.usedJSHeapSize ?? null;
    if (typeof gc === 'function') gc();
    const heap0 = heap(), t0 = performance.now();
    await lines.importColumnar({ kind: 'lineString', positions: Float64Array.from(lineXY), partOffsets: Uint32Array.from(lineOffsets), ids: Array.from({ length: 96 }, (_, i) => i) }, { copy: false });
    await areas.importColumnar({ kind: 'polygon', positions: Float64Array.from(polygonXY), partOffsets: Uint32Array.from(ringOffsets), featurePartOffsets: Uint32Array.from(polygonOffsets), ids: Array.from({ length: 64 }, (_, i) => i) }, { copy: false });
    await symbols.importColumnar({ kind: 'point', positions: symbolXY, properties, ids: Array.from({ length: 2048 }, (_, i) => i) }, { copy: false });
    const importMs = performance.now() - t0;
    const fillLayer = map.layers.add({ id: 'fills', type: 'fills', source: areas, style: { fillColor: '#2266dd', fillOpacity: 0.35, strokeWidthPx: 1 } });
    map.layers.add({ id: 'lines', type: 'lines', source: lines, style: { widthPx: 1, color: '#22aa55', opacity: 0.7 } });
    const iconLayer = map.layers.add({ id: 'icons', type: 'points', source: symbols, style: { icon: expr.field('image'), iconSize: 6 } });
    map.layers.add({ id: 'labels', type: 'labels', source: symbols, style: { text: expr.field('name'), sizePx: 9, collision: true, offsetPx: { x: 0, y: -8 } } });
    await map.whenRendered();
    const firstPaintMs = performance.now() - t0;
    if (typeof gc === 'function') gc();
    const heap1 = heap(), stats = map.stats();
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const pan = async (count) => {
      const samples = [];
      for (let i = 0; i < count; i++) {
        const start = performance.now();
        map.view.set({ center: { x: Math.sin(i * 0.43) * 0.025, y: Math.cos(i * 0.39) * 0.02 } });
        await frame(); samples.push(performance.now() - start);
      }
      return samples;
    };
    await pan(12);
    const panMs = await pan(36), editMs = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      fillLayer.features.setOverride(i, { fillColor: i % 2 ? '#dd2266' : '#2266dd' });
      iconLayer.features.setOverride(i, { opacity: i % 2 ? 0.6 : 1 });
      await map.whenRendered(); editMs.push(performance.now() - start);
    }
    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });
    check('all individual objects survive', lines.features.count() === 96 && areas.features.count() === 64 && symbols.features.count() === 2048);
    check('all line vertices survive export', lines.features.get(0).geometry.positions.length === 256);
    check('all polygon vertices and holes survive export', areas.features.get(0).geometry.rings.map(r => r.length).join(',') === '129,9,9');
    check('worker prepares every import', map.debug.imports().used.worker === 3, map.debug.imports());
    map.layers.get('lines').setVisible(false); map.layers.get('labels').setVisible(false); iconLayer.setVisible(false);
    fillLayer.features.setOverride(0, { fillColor: '#2266dd', fillOpacity: 1 });
    map.view.set({ center: { x: 0, y: 0 } }); await map.whenRendered();
    const filled = map.view.positionToScreen({ x: -1.05, y: -0.8 + 0.045 });
    const hole = map.view.positionToScreen({ x: -1.08, y: -0.8 });
    const pixel = await map.debug.samplePixel(filled), fillHits = await map.query.rendered(filled), holeHits = await map.query.rendered(hole);
    check('polygon pixels and exact individual picking', pixel.b > 150 && fillHits[0]?.feature.id === 0 && !holeHits.some(h => h.feature.id === 0), { pixel, fillHits, holeHits });
    map.destroy();
    const distribution = (values) => { const sorted = values.slice().sort((a, b) => a - b); return { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted.at(-1), samples: values }; };
    return { checks, measurements: { backend: '${options.webgpu ? 'webgpu' : options.basic ? 'webgl1-basic' : 'webgl1'}', importMs, firstPaintMs,
      heapDeltaMiB: heap0 === null || heap1 === null ? null : (heap1 - heap0) / 1048576, gpuBytes: stats.gpuBytes,
      drawCalls: stats.drawCalls, panMs: distribution(panMs), editMs: distribution(editMs) } };
  })()`);
  for (const check of result.checks) expect.ok(check.pass, `${check.name}: ${JSON.stringify(check.detail ?? null)}`);
  console.log(`\n    complex-scene measurements: ${JSON.stringify(result.measurements)}`);
}
