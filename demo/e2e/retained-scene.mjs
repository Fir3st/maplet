/** Current GPU data, pixels and picking across mixed vectors and atlas symbols. */
export async function retainedScene({ session, expect, options }) {
  const checks = await session.evaluate(`(async () => {
    window.__e2e.map.destroy();
    document.getElementById('map').style.width = '720px';
    document.getElementById('map').style.height = '520px';
    const { createMap, crs } = await import('/dist/index.js');
    const { polygonMeshBuildCount } = await import('/dist/render/polygon-mesh.js');
    const map = await createMap('map', { projection: crs.simple(), size: { width: 720, height: 520 },
    renderer: { primary: '${options.webgpu ? 'webgpu' : 'webgl1'}', fallback: false }, center: { x: 0, y: 0 }, zoom: 0 });
    const source = map.data.vector({ id: 'mixed' });
    const image = document.createElement('canvas'); image.width = 16; image.height = 16;
    const context = image.getContext('2d'); context.fillStyle = '#ee6633'; context.fillRect(4, 4, 8, 8);
    await map.assets.addImage({ id: 'image', src: image.toDataURL() }).ready();
    const position = (x, y) => map.screenToPosition({ x, y });
    const ring = [[80, 100], [240, 100], [240, 260], [80, 260]].map(([x, y]) => position(x, y));
    const hole = [[130, 150], [190, 150], [190, 210], [130, 210]].map(([x, y]) => position(x, y));
    source.features.add([
      { id: 'polygon', geometry: { type: 'polygon', rings: [ring, hole] } },
      { id: 'line', geometry: { type: 'lineString', positions: [position(300, 100), position(620, 100)] } },
      { id: 'icon', geometry: { type: 'point', position: position(400, 250) } },
      { id: 'first', geometry: { type: 'point', position: position(400, 360) }, properties: { name: 'VISIBLE' } },
      { id: 'suppressed', geometry: { type: 'point', position: position(400, 360) }, properties: { name: 'VISIBLE' } },
    ]);
    const fills = map.addLayer({ id: 'fills', type: 'fills', source, filter: { id: 'polygon' }, style: { fillColor: '#2266dd', fillOpacity: 1, strokeWidthPx: 0 } });
    map.addLayer({ id: 'lines', type: 'lines', source, style: { color: '#22aa55', widthPx: 6, dash: [20, 20], cap: 'butt' } });
    map.addLayer({ id: 'icons', type: 'points', source, filter: { id: 'icon' }, style: { icon: 'image', iconSize: 32 } });
    map.addLayer({ id: 'labels', type: 'labels', source, filter: { or: [{ id: 'first' }, { id: 'suppressed' }] }, style: { sizePx: 24, collision: true, color: '#111111' } });
    await map.whenRendered();
    const uploads = [], textureUploads = [], restores = [], result = [];
    const check = (name, pass, detail) => result.push({ name, pass, detail });
    const wrap = (prototype, name, measure) => { const original = prototype[name]; prototype[name] = function (...args) { measure(...args); return original.apply(this, args); }; restores.push(() => prototype[name] = original); };
    if (map.capabilities().backend === 'webgl1') {
      wrap(WebGLRenderingContext.prototype, 'bufferData', (target, data) => uploads.push({ full: true, bytes: data.byteLength }));
      wrap(WebGLRenderingContext.prototype, 'bufferSubData', (target, offset, data) => uploads.push({ full: false, bytes: data.byteLength }));
      wrap(WebGLRenderingContext.prototype, 'texImage2D', () => textureUploads.push(true));
    } else {
      wrap(GPUQueue.prototype, 'writeBuffer', (buffer, offset, data) => { if (buffer.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) uploads.push({ bytes: data.byteLength }); });
      wrap(GPUQueue.prototype, 'copyExternalImageToTexture', () => textureUploads.push(true));
    }
    try {
      const tessellations = polygonMeshBuildCount();
      map.setView({ center: position(370, 265) }); await map.whenRendered();
      check('mixed geometry, sprites and labels pan with no vertex/index upload', uploads.length === 0, uploads.slice());
      const pixel = await map.debug.samplePixel({ x: 90, y: 115 });
      check('retained polygon follows the camera', pixel.b > 180 && (await map.query.rendered({ x: 90, y: 115 }))[0]?.feature.id === 'polygon', pixel);
      check('hole remains empty', !(await map.query.rendered({ x: 150, y: 175 })).some(hit => hit.feature.id === 'polygon'));
      check('dash ink is pickable and the gap is not', (await map.query.rendered({ x: 300, y: 95 })).some(hit => hit.feature.id === 'line') && !(await map.query.rendered({ x: 320, y: 95 })).some(hit => hit.feature.id === 'line'));
      check('sprite transparent pixels do not pick', !(await map.query.rendered({ x: 376, y: 231 })).some(hit => hit.feature.id === 'icon') && (await map.query.rendered({ x: 390, y: 245 }))[0]?.feature.id === 'icon');
      const labelHits = [];
      for (let x = 345; x <= 435; x += 5) labelHits.push(...await map.query.rendered({ x, y: 354 }));
      check('only the visible collision winner can be picked', labelHits.some(hit => hit.feature.id === 'first') && !labelHits.some(hit => hit.feature.id === 'suppressed'), labelHits.map(hit => hit.feature.id));
      uploads.length = 0;
      fills.setFeatureStyle('polygon', { fillColor: '#dd2266' }); await map.whenRendered();
      check('color edit reuses tessellation and localized GPU storage', polygonMeshBuildCount() === tessellations && uploads.length === 1 && uploads[0].bytes < 1024 && !uploads[0].full, uploads.slice());
      const changed = await map.debug.samplePixel({ x: 90, y: 115 });
      check('localized fill color reaches actual pixels', changed.r > 180 && changed.b < 150, changed);
      uploads.length = 0; textureUploads.length = 0;
      map.layers.get('labels').setFeatureStyle('first', { color: '#dd2266' });
      map.layers.get('icons').setFeatureStyle('icon', { opacity: 0 });
      await map.whenRendered();
      check('symbol appearance edits upload only the two quads without atlas/layout rebuild', uploads.length === 2 && uploads.every(upload => upload.bytes === 384 && !upload.full) && textureUploads.length === 0, { uploads: uploads.slice(), textures: textureUploads.length });
      const hiddenIconPixel = await map.debug.samplePixel({ x: 390, y: 245 }), hiddenIconHits = await map.query.rendered({ x: 390, y: 245 });
      check('zero-opacity icon no longer draws or picks', hiddenIconPixel.a === 0 && !hiddenIconHits.some(hit => hit.feature.id === 'icon'), { hiddenIconPixel, hiddenIconHits });
      const coloredText = [];
      for (let x = 345; x <= 435; x += 5) coloredText.push(await map.debug.samplePixel({ x, y: 354 }));
      check('localized text color reaches actual glyph pixels', coloredText.some(pixel => pixel.r > 100 && pixel.r > pixel.g * 2 && pixel.b > pixel.g * 2), coloredText);
      uploads.length = 0;
      map.layers.get('labels').setFeatureStyle('suppressed', { color: '#22aa55' }); await map.whenRendered();
      check('suppressed label appearance cannot allocate visible vertices or become pickable', uploads.length === 0 && !(await map.query.rendered({ x: 390, y: 354 })).some(hit => hit.feature.id === 'suppressed'), uploads.slice());
      uploads.length = 0; textureUploads.length = 0;
      map.layers.get('icons').setFeatureStyle('icon', { opacity: 1, iconTint: '#3366ff' });
      await map.whenRendered();
      check('icon tint edit uploads one quad without atlas upload or relayout', uploads.length === 1 && uploads[0].bytes === 384 && !uploads[0].full && textureUploads.length === 0, { uploads: uploads.slice(), textures: textureUploads.length });
      const tintedIcon = await map.debug.samplePixel({ x: 390, y: 245 });
      check('icon tint reaches actual pixels and stays pickable', Math.abs(tintedIcon.r - 48) <= 12 && Math.abs(tintedIcon.g - 41) <= 12 && Math.abs(tintedIcon.b - 51) <= 12 && (await map.query.rendered({ x: 390, y: 245 }))[0]?.feature.id === 'icon', tintedIcon);
    } finally { for (const restore of restores) restore(); }
    source.features.add([
      { id: 'circle-shape', geometry: { type: 'point', position: position(580, 250) }, properties: { shape: 'circle' } },
      { id: 'diamond-shape', geometry: { type: 'point', position: position(580, 360) }, properties: { shape: 'diamond' } },
      { id: 'triangle-shape', geometry: { type: 'point', position: position(580, 430) }, properties: { shape: 'triangle' } },
      { id: 'square-shape', geometry: { type: 'point', position: position(480, 430) }, properties: { shape: 'square' } },
      { id: 'transparent-shape', geometry: { type: 'point', position: position(320, 430) }, properties: { shape: 'circle' } },
      { id: 'round-line', geometry: { type: 'lineString', positions: [position(100, 420), position(220, 420)] } },
    ]);
    const { style: expr } = await import('/dist/index.js');
    const shapeLayer = map.addLayer({ id: 'shape-proof', type: 'points', source, filter: (_, id) => id.endsWith('-shape'), style: { shape: expr.field('shape'), radiusPx: 40, color: '#2266dd' } });
    shapeLayer.setFeatureStyle('transparent-shape', { opacity: 0 });
    map.addLayer({ id: 'cap-proof', type: 'lines', source, filter: { id: 'round-line' }, style: { widthPx: 40, cap: 'round', color: '#2266dd' } });
    await map.whenRendered();
    const none = async (x, y, id) => !(await map.query.rendered({ x, y })).some(hit => hit.feature.id === id);
    check('circle and diamond picking excludes empty quad corners', await none(615, 285, 'circle-shape') && await none(615, 395, 'diamond-shape'));
    check('triangle picking follows the actual shape; square keeps its corners', await none(615, 395, 'triangle-shape') && (await map.query.rendered({ x: 515, y: 395 }))[0]?.feature.id === 'square-shape');
    check('fully transparent vectors do not pick', await none(320, 430, 'transparent-shape'));
    check('round line caps exclude their empty quad corners', await none(240, 440, 'round-line') && (await map.query.rendered({ x: 230, y: 420 })).some(hit => hit.feature.id === 'round-line'));
    map.layers.remove('shape-proof'); map.layers.remove('cap-proof');
    // Exercise uint-index-free delivery above 65535 vertices, not just a mock.
    map.layers.remove('fills'); map.layers.remove('lines'); map.layers.remove('icons'); map.layers.remove('labels');
    const large = map.data.vector({ id: 'large' });
    const xy = new Float64Array(70000 * 2);
    for (let i = 0; i < 70000; i++) { const a = i * Math.PI * 2 / 70000; xy[i * 2] = Math.cos(a) * 0.8; xy[i * 2 + 1] = Math.sin(a) * 0.8; }
    await large.importColumnar({ kind: 'polygon', positions: xy, partOffsets: Uint32Array.of(0, 70000), ids: ['large'] }, { copy: false });
    map.addLayer({ id: 'large', type: 'fills', source: large, style: { fillColor: '#2266dd', fillOpacity: 1, strokeWidthPx: 0 } });
    map.setView({ center: { x: 0, y: 0 } }); await map.whenRendered();
    const largePixel = await map.debug.samplePixel({ x: 360, y: 260 });
    check('large indexed polygon renders and picks on every profile', largePixel.b > 180 && (await map.query.rendered({ x: 360, y: 260 }))[0]?.feature.id === 'large' && large.features.get('large').geometry.rings[0].length === 70001, largePixel);
    map.destroy();
    return result;
  })()`);
  for (const check of checks)
    expect.ok(check.pass, `${check.name}: ${JSON.stringify(check.detail ?? null)}`);
}
