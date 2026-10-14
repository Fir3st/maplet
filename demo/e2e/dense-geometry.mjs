/** Vertex-heavy public-API fixture, complementary to the mixed-symbol workload. */
export async function denseGeometry({ session, expect, options }) {
  const result = await session.evaluate(`(async () => {
    window.__e2e.map.destroy();
    const host = document.getElementById('map'); host.style.width = '720px'; host.style.height = '520px';
    const { createMap, crs } = await import('/dist/index.js');
    const map = await createMap('map', { projection: crs.simple(),
    renderer: { primary: '${options.webgpu ? 'webgpu' : 'webgl1'}', fallback: false }, center: { x: 0, y: 0 }, zoom: 0 });
    const lines = map.data.vector({ id: 'line' }), areas = map.data.vector({ id: 'area' });
    const lineXY = new Float64Array(100000 * 2), areaXY = [], offsets = [0];
    for (let i = 0; i < 100000; i++) { lineXY[i * 2] = -1.15 + i * 2.3 / 99999; lineXY[i * 2 + 1] = 0.84 + Math.sin(i * 0.002) * 0.055; }
    for (let i = 0; i < 8192; i++) {
      const angle = i * Math.PI * 2 / 8192, radius = 0.7 + Math.sin(angle * 16) * 0.05;
      areaXY.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    offsets.push(areaXY.length / 2);
    for (const y of [-0.22, 0.22]) for (const x of [-0.3, 0, 0.3]) {
      for (let i = 0; i < 64; i++) { const angle = i * Math.PI * 2 / 64; areaXY.push(x + Math.cos(angle) * 0.065, y + Math.sin(angle) * 0.065); }
      offsets.push(areaXY.length / 2);
    }
    const areaPositions = Float64Array.from(areaXY), heap = () => performance.memory?.usedJSHeapSize ?? null;
    if (typeof gc === 'function') gc();
    const heap0 = heap(), started = performance.now();
    await lines.importColumnar({ kind: 'lineString', positions: lineXY, partOffsets: Uint32Array.of(0, 100000), ids: ['line'] }, { copy: false });
    await areas.importColumnar({ kind: 'polygon', positions: areaPositions, partOffsets: Uint32Array.from(offsets), featurePartOffsets: Uint32Array.of(0, 7), ids: ['area'] }, { copy: false });
    const importMs = performance.now() - started;
    const fillLayer = map.addLayer({ id: 'area', type: 'fills', source: areas, style: { fillColor: '#2266dd', fillOpacity: 1, strokeWidthPx: 1 } });
    const lineLayer = map.addLayer({ id: 'line', type: 'lines', source: lines, style: { widthPx: 2, color: '#22aa55', opacity: 0.7 } });
    await map.whenRendered();
    const firstPaintMs = performance.now() - started;
    if (typeof gc === 'function') gc();
    const heap1 = heap(), stats = map.stats(), frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const pan = async count => {
      const samples = [];
      for (let i = 0; i < count; i++) {
        const start = performance.now(); map.setView({ center: { x: Math.sin(i * 0.43) * 0.025, y: Math.cos(i * 0.39) * 0.02 } });
        await frame(); samples.push(performance.now() - start);
      }
      return samples;
    };
    await pan(12);
    const panMs = await pan(36), editMs = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now(); fillLayer.setFeatureStyle('area', { fillColor: i % 2 ? '#dd2266' : '#2266dd' });
      await map.whenRendered(); editMs.push(performance.now() - start);
    }
    map.setView({ center: { x: 0, y: 0 } }); await map.whenRendered();
    const checks = [], check = (name, pass, detail) => checks.push({ name, pass, detail });
    const exportedLine = lines.features.get('line').geometry, exportedArea = areas.features.get('area').geometry;
    check('all vertices, rings and individual identities survive', exportedLine.positions.length === 100000 && exportedArea.rings.map(r => r.length).join(',') === '8193,65,65,65,65,65,65' && lines.features.count() === 1 && areas.features.count() === 1);
    const center = map.positionToScreen({ x: 0, y: 0 }), centerPixel = await map.debug.samplePixel(center), centerHits = await map.query.rendered(center);
    check('edited concave polygon remains rendered and individually pickable', centerPixel.r > 150 && centerHits[0]?.feature.id === 'area', { centerPixel, centerHits });
    const linePoint = map.positionToScreen(exportedLine.positions[50000]), linePixel = await map.debug.samplePixel(linePoint), lineHits = await map.query.rendered(linePoint);
    check('dense line renders and picks at its original geometry', linePixel.g > linePixel.r && lineHits.some(hit => hit.feature.id === 'line'), { linePixel, lineHits });
    lineLayer.setVisible(false); await map.whenRendered();
    for (const y of [-0.22, 0.22]) for (const x of [-0.3, 0, 0.3]) {
      const screen = map.positionToScreen({ x, y }), pixel = await map.debug.samplePixel(screen), hits = await map.query.rendered(screen);
      check('hole at ' + x + ',' + y + ' is empty in pixels and picking', pixel.a === 0 && !hits.some(hit => hit.feature.id === 'area'), { pixel, hits });
    }
    map.destroy();
    const distribution = values => { const sorted = values.slice().sort((a, b) => a - b); return { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted.at(-1), samples: values }; };
    return { checks, measurements: { backend: '${options.webgpu ? 'webgpu' : options.basic ? 'webgl1-basic' : 'webgl1'}', importMs, firstPaintMs,
      heapDeltaMiB: heap0 === null || heap1 === null ? null : (heap1 - heap0) / 1048576, gpuBytes: stats.gpuBytes, drawCalls: stats.drawCalls,
      panMs: distribution(panMs), editMs: distribution(editMs) } };
  })()`);
  for (const check of result.checks) expect.ok(check.pass, `${check.name}: ${JSON.stringify(check.detail ?? null)}`);
  console.log(`\n    dense-geometry measurements: ${JSON.stringify(result.measurements)}`);
}
