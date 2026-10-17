import test from 'node:test';
import assert from 'node:assert/strict';

import {
  flipTileY,
  formatTileUrl,
  tileGeoBounds,
  tileGridOptions,
  tileZoomForView,
  tilesForWorldRect,
  wmsGetMapUrl,
} from '../../src/formats/raster.ts';
import { makeMap, settled } from '../helpers/fixture.ts';
import { isMapletError } from '../../src/api/errors.ts';

const XYZ = { url: 'https://tiles.example/{z}/{x}/{y}.png' };
// Centre of tile (z2, x1, y1); a view there places that tile at the view centre.
const TILE_2_1_1_CENTER = { lat: 40.97989806962013, lng: -45 };

test('RASTER-01: XYZ URLs substitute z/x/y and subdomains', () => {
  assert.equal(
    formatTileUrl(XYZ, { z: 12, x: 2200, y: 1343 }, { tms: false }),
    'https://tiles.example/12/2200/1343.png',
  );
  assert.equal(
    formatTileUrl(
      { url: 'https://{s}.example/{z}/{x}/{y}.png', subdomains: ['a', 'b'] },
      { z: 1, x: 1, y: 0 },
      { tms: false },
    ),
    'https://b.example/1/1/0.png',
  );
  // The template is codec-agnostic: PNG, SVG and Esri's {z}/{y}/{x} order all
  // resolve to the same tile coordinates (checked in demo/tiles.html).
  assert.equal(
    formatTileUrl(
      { url: 'https://tiles.example/{z}/{x}/{y}.svg' },
      { z: 2, x: 1, y: 1 },
      { tms: false },
    ),
    'https://tiles.example/2/1/1.svg',
  );
  assert.equal(
    formatTileUrl(
      { url: 'https://imagery.example/MapServer/tile/{z}/{y}/{x}' },
      { z: 3, x: 4, y: 2 },
      { tms: false },
    ),
    'https://imagery.example/MapServer/tile/3/2/4',
  );
});

test('RASTER-02: TMS flips y by the grid, not by the viewport', () => {
  assert.equal(flipTileY(0, 0), 0);
  assert.equal(flipTileY(1, 0), 1);
  assert.equal(flipTileY(1, 1), 0);
  assert.equal(flipTileY(3, 2), 5);
  assert.equal(
    formatTileUrl(XYZ, { z: 3, x: 4, y: 2 }, { tms: true }),
    'https://tiles.example/3/4/5.png',
  );
  assert.equal(
    formatTileUrl(
      { url: 'https://example/{z}/{x}/{-y}.png' },
      { z: 3, x: 4, y: 2 },
      { tms: false },
    ),
    'https://example/3/4/5.png',
  );
});

test('RASTER-03: native zoom caps the requested tile level', () => {
  const grid = tileGridOptions({ id: 't', url: XYZ.url, minZoom: 0, maxZoom: 18, nativeZoom: 12 });
  assert.equal(tileZoomForView(13.5, grid), 12);
  assert.equal(tileZoomForView(11.2, grid), 11);
  assert.equal(tileZoomForView(5, grid), 5);
  const retina = tileGridOptions({
    id: 't',
    url: XYZ.url,
    minZoom: 0,
    maxZoom: 18,
    nativeZoom: 12,
    retina: true,
  });
  assert.equal(tileZoomForView(10.9, retina), 11, 'retina requests one level deeper');
  assert.equal(tileZoomForView(12.4, retina), 12, 'but never above nativeZoom');
});

test('RASTER-04: tile size changes pixel density, not geographic bounds', () => {
  const bounds256 = tileGeoBounds({ z: 2, x: 1, y: 1 });
  const small = tileGridOptions({ id: 't', url: XYZ.url, tileSize: 256 });
  const large = tileGridOptions({ id: 't', url: XYZ.url, tileSize: 512 });
  assert.equal(small.tileSize, 256);
  assert.equal(large.tileSize, 512);
  assert.ok(Math.abs(bounds256.northeast.lng - 0) < 1e-9);
  assert.ok(Math.abs(bounds256.southwest.lng + 90) < 1e-9);
  assert.ok(Math.abs(bounds256.northeast.lat - 66.51326044311186) < 1e-6);
});

test('RASTER-05/06: visible tiles follow the world rect, wrap and bounds clamping', () => {
  const coords = tilesForWorldRect(0, 0, 256, 256, 1, 256, {
    wrap: false,
    minZoom: 0,
    maxZoom: 24,
  });
  assert.equal(coords.length, 4);
  assert.deepEqual(coords.map((c) => `${c.z}/${c.x}/${c.y}`).sort(), [
    '1/0/0',
    '1/0/1',
    '1/1/0',
    '1/1/1',
  ]);
  // Wrapping world copies reuse the same tile identity (x = 4..5 wraps to 0..1).
  const wrapped = tilesForWorldRect(512, 0, 768, 256, 1, 256, {
    wrap: true,
    minZoom: 0,
    maxZoom: 24,
  });
  assert.deepEqual(
    wrapped.map((c) => c.x),
    [0, 1, 0, 1],
  );
  // Without wrap, the same rect clamps to the last column (2 rows x 1 column).
  const clampedX = tilesForWorldRect(512, 0, 768, 256, 1, 256, {
    wrap: false,
    minZoom: 0,
    maxZoom: 24,
  });
  assert.deepEqual(
    clampedX.map((c) => c.x),
    [1, 1],
  );
  // Without wrap, requests stay inside the grid.
  const clamped = tilesForWorldRect(-256, -256, 0, 0, 1, 256, {
    wrap: false,
    minZoom: 0,
    maxZoom: 24,
  });
  assert.ok(clamped.every((c) => c.x === 0 && c.y === 0));
});

test('WMS-01: WMS 1.1.1 with EPSG:4326 uses SRS and lng/lat BBOX', () => {
  const request = wmsGetMapUrl(
    { id: 'w', url: 'https://wms.example/', layers: 'roads', version: '1.1.1', crs: 'EPSG:4326' },
    { southwest: { lat: 49, lng: 13 }, northeast: { lat: 51, lng: 17 } },
    256,
    256,
  );
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('version'), '1.1.1');
  assert.equal(url.searchParams.get('srs'), 'EPSG:4326');
  assert.equal(url.searchParams.get('crs'), null, 'no duplicate CRS parameter');
  assert.equal(url.searchParams.get('bbox'), '13,49,17,51');
  assert.equal(url.searchParams.get('width'), '256');
  assert.equal(url.searchParams.get('height'), '256');
  assert.equal(url.searchParams.get('transparent'), 'true');
});

test('WMS-02: WMS 1.3.0 axis order follows EPSG:4326 vs CRS:84', () => {
  const bounds = { southwest: { lat: 49, lng: 13 }, northeast: { lat: 51, lng: 17 } };
  const epsg4326 = wmsGetMapUrl(
    { id: 'w', url: 'https://wms.example/', layers: 'roads', version: '1.3.0', crs: 'EPSG:4326' },
    bounds,
    512,
    384,
  );
  const url4326 = new URL(epsg4326.url);
  assert.equal(url4326.searchParams.get('crs'), 'EPSG:4326');
  assert.equal(url4326.searchParams.get('bbox'), '49,13,51,17', '1.3.0 EPSG:4326 is lat,lng');
  const crs84 = wmsGetMapUrl(
    { id: 'w', url: 'https://wms.example/', layers: 'roads', version: '1.3.0', crs: 'CRS:84' },
    bounds,
    512,
    384,
  );
  assert.equal(new URL(crs84.url).searchParams.get('bbox'), '13,49,17,51', 'CRS:84 is lng,lat');
});

test('WMS-03: EPSG:3857 uses projected metres in both versions (true Mercator)', () => {
  const bounds = { southwest: { lat: 0, lng: 0 }, northeast: { lat: 45, lng: 45 } };
  // Independent oracle: x = R * phi_rad, y = R * ln(tan(pi/4 + phi/2)),
  // R = 6378137. A linear degrees->metres latitude factor is ~612 km off here.
  const request = wmsGetMapUrl(
    {
      id: 'w',
      url: 'https://wms.example/ows',
      layers: 'roads',
      version: '1.3.0',
      crs: 'EPSG:3857',
    },
    bounds,
    256,
    256,
  );
  const bbox = new URL(request.url).searchParams.get('bbox')!.split(',').map(Number);
  assert.ok(Math.abs(bbox[0]! - 0) < 1e-6, 'xmin');
  assert.ok(Math.abs(bbox[1]! - 0) < 1e-6, 'ymin');
  assert.ok(Math.abs(bbox[2]! - 5009377.085697311) < 1e-6, 'xmax = R * 45 degrees in radians');
  assert.ok(Math.abs(bbox[3]! - 5621521.486192066) < 1e-6, 'ymax = R * ln(tan(pi/4 + phi/2))');
  // Southern hemisphere keeps the sign and the symmetry.
  const south = wmsGetMapUrl(
    {
      id: 'w',
      url: 'https://wms.example/ows',
      layers: 'roads',
      version: '1.3.0',
      crs: 'EPSG:3857',
    },
    { southwest: { lat: -33.9, lng: 0 }, northeast: { lat: 0, lng: 0 } },
    256,
    256,
  );
  const southBbox = new URL(south.url).searchParams.get('bbox')!.split(',').map(Number);
  assert.ok(Math.abs(southBbox[1]! - -4015382.3600731594) < 1e-6, 'southern ymin');
  assert.ok(Math.abs(southBbox[3]! - 0) < 1e-6, 'southern ymax');
  // 1.1.1 keeps the SRS parameter but the BBOX units still follow the CRS.
  const legacy = wmsGetMapUrl(
    {
      id: 'w',
      url: 'https://wms.example/ows',
      layers: 'roads',
      version: '1.1.1',
      crs: 'EPSG:3857',
    },
    bounds,
    256,
    256,
  );
  const legacyUrl = new URL(legacy.url);
  assert.equal(legacyUrl.searchParams.get('srs'), 'EPSG:3857');
  assert.equal(legacyUrl.searchParams.get('crs'), null);
  assert.equal(legacyUrl.searchParams.get('bbox'), new URL(request.url).searchParams.get('bbox'));
});

test('WMS-04: special characters in layers and styles are URL encoded', () => {
  const request = wmsGetMapUrl(
    {
      id: 'w',
      url: 'https://wms.example/ows?map=/data/a b.map',
      layers: 'roads & rails/1',
      styles: 'bold red',
      version: '1.1.1',
      crs: 'EPSG:4326',
    },
    { southwest: { lat: 49, lng: 13 }, northeast: { lat: 51, lng: 17 } },
    256,
    256,
  );
  assert.match(request.url, /layers=roads%20%26%20rails%2F1/);
  assert.match(request.url, /styles=bold%20red/);
  assert.ok(!/cr[sS]=EPSG:4326.*cr[sS]=EPSG:4326/i.test(request.url), 'no duplicate CRS/SRS');
});

test('WMS-06: an unsupported CRS is refused instead of being sent with degrees', async () => {
  // EPSG:5514 (Krovak) and EPSG:4258 are real WMS CRS values, but this library
  // can only build a correct BBOX for the three in WMS_REQUEST_CRS. Sending a
  // projected grid with degree values would silently render the wrong place.
  assert.throws(
    () =>
      wmsGetMapUrl(
        { id: 'w', url: 'https://wms.example/', layers: 'grid', crs: 'EPSG:5514' },
        { southwest: { lat: 49, lng: 13 }, northeast: { lat: 51, lng: 17 } },
        256,
        256,
      ),
    (error: unknown) =>
      isMapletError(error) &&
      error.code === 'invalid-argument' &&
      (error.detail['supported'] as string[]).join(',') === 'CRS:84,EPSG:4326,EPSG:3857',
  );
  // Case does not matter, and the request carries the canonical spelling.
  const lower = wmsGetMapUrl(
    { id: 'w', url: 'https://wms.example/', layers: 'roads', version: '1.3.0', crs: 'crs:84' },
    { southwest: { lat: 49, lng: 13 }, northeast: { lat: 51, lng: 17 } },
    256,
    256,
  );
  assert.equal(new URL(lower.url).searchParams.get('crs'), 'CRS:84');

  const { map } = await makeMap();
  assert.throws(
    () =>
      map.data.wms({ id: 'bad', url: 'https://wms.example/', layers: 'roads', crs: 'EPSG:5514' }),
    /not supported/,
  );
  const good = map.data.wms({
    id: 'good',
    url: 'https://wms.example/',
    layers: 'roads',
    crs: 'EPSG:3857',
  });
  assert.throws(() => good.update({ crs: 'EPSG:5514' }), /not supported/);
  assert.equal(good.snapshot().revision, 0, 'a refused update changes nothing');
  map.destroy();
});

/** Request extent from a GetMap URL, honoring the 1.3.0 EPSG:4326 axis order. */
function wmsRequestBounds(url: string): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  const params = new URL(url).searchParams;
  const [a, b, c, d] = params.get('bbox')!.split(',').map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (params.get('version') === '1.3.0' && params.get('crs') === 'EPSG:4326') {
    return { south: a, west: b, north: c, east: d };
  }
  return { west: a, south: b, east: c, north: d };
}

test('WMS-10: neighbouring zoom levels stand in through the tile fallback chain', async () => {
  const { map } = await makeMap({ center: { lat: 50, lng: 14 }, zoom: 8 });
  const source = map.data.wms({ id: 'wms', url: 'https://wms.example/ows', layers: 'roads' });
  map.addLayer({ id: 'wms', type: 'raster', source });
  const requested = new Set(map.debug.layerTiles('wms').map((placement) => placement.url));

  // Zoom in one level: every new tile names the previous level's tile that
  // contains it as its nearest stand-in, with the quadrant UV sub-rect. That
  // tile was already requested by the previous view, so the cache can serve it.
  map.setView({ zoom: 9 });
  const zoomed = map.debug.layerTiles('wms');
  assert.ok(zoomed.length > 0);
  for (const placement of zoomed) requested.add(placement.url);
  for (const placement of zoomed) {
    const [z, x, y] = placement.tileKey.split('/').map(Number) as [number, number, number];
    const fallback = placement.fallbacks[0]!;
    assert.ok(
      requested.has(fallback.url),
      `the stand-in was requested before (${placement.tileKey})`,
    );
    const parent = wmsRequestBounds(fallback.url);
    const parentGeo = tileGeoBounds({ z: z - 1, x: x >> 1, y: y >> 1 });
    assert.ok(
      Math.abs(parent.west - parentGeo.southwest.lng) < 1e-6,
      'the stand-in is the containing tile',
    );
    assert.ok(Math.abs(parent.north - parentGeo.northeast.lat) < 1e-6);
    assert.equal(fallback.u0, (x % 2) / 2, 'the UV sub-rect picks the quadrant');
    assert.equal(fallback.u1, ((x % 2) + 1) / 2);
    assert.equal(fallback.v0, (y % 2) / 2);
    assert.equal(fallback.v1, ((y % 2) + 1) / 2);
  }

  // Zooming back out, the same mechanism has the finer tiles as children, so a
  // coarse tile fills its quadrants with what is already decoded.
  map.setView({ zoom: 8 });
  const size = map.size();
  const coarse = map.debug
    .layerTiles('wms')
    .find(
      (placement) =>
        placement.sx <= size.width / 2 &&
        placement.sx + placement.sw >= size.width / 2 &&
        placement.sy <= size.height / 2 &&
        placement.sy + placement.sh >= size.height / 2,
    )!;
  const [cz, cx, cy] = coarse.tileKey.split('/').map(Number) as [number, number, number];
  assert.equal(coarse.children?.length, 4, 'four finer tiles cover the coarser one');
  const child = wmsRequestBounds(coarse.children![0]);
  const childGeo = tileGeoBounds({ z: cz + 1, x: cx * 2, y: cy * 2 });
  assert.ok(
    Math.abs(child.west - childGeo.southwest.lng) < 1e-6,
    'children are the four finer tiles',
  );
  assert.ok(Math.abs(child.east - childGeo.northeast.lng) < 1e-6);
  // Tiles at the coarse view's edge may fall outside the finer view, but the
  // ones it did cover are already decoded.
  assert.ok(
    coarse.children!.some((url) => requested.has(url)),
    'the finer tiles were already requested',
  );
  map.destroy();
});

test('WMS-10: fractional zoom within a level keeps the requested tiles', async () => {
  const { map } = await makeMap({ center: { lat: 50, lng: 14 }, zoom: 8 });
  const source = map.data.wms({ id: 'wms', url: 'https://wms.example/ows', layers: 'roads' });
  map.addLayer({ id: 'wms', type: 'raster', source });
  const before = new Map(
    map.debug.layerTiles('wms').map((placement) => [placement.tileKey, placement.url]),
  );
  map.setView({ zoom: 8.5 });
  const after = map.debug.layerTiles('wms');
  // A partial level requests nothing deeper: the same level covers a smaller
  // area (so fewer tiles), and every tile it keeps is the already issued URL.
  for (const placement of after) {
    assert.ok(placement.tileKey.startsWith('8/'), `still the same level (${placement.tileKey})`);
    assert.equal(
      placement.url,
      before.get(placement.tileKey),
      'tiles are reused, not re-requested',
    );
  }
  assert.ok(Math.abs(after[0]!.sw - 256 * 2 ** 0.5) < 1e-6, 'the same tiles scale with the view');
  map.destroy();
});

test('WMS-10: a parameter change keeps the tile identities while URLs change', async () => {
  const { map } = await makeMap({ center: { lat: 50, lng: 14 }, zoom: 8 });
  const source = map.data.wms({ id: 'wms', url: 'https://wms.example/ows', layers: 'roads' });
  map.addLayer({ id: 'wms', type: 'raster', source });
  const before = map.debug
    .layerTiles('wms')
    .map((placement) => ({ key: placement.tileKey, url: placement.url }));
  source.setParams({ layers: 'alt' });
  const after = map.debug
    .layerTiles('wms')
    .map((placement) => ({ key: placement.tileKey, url: placement.url }));
  assert.deepEqual(
    after.map((entry) => entry.key),
    before.map((entry) => entry.key),
    'the tile set is unchanged',
  );
  assert.ok(
    after.every((entry, index) => entry.url !== before[index]!.url),
    'every URL carries the new parameter',
  );
  assert.ok(after[0]!.url.includes('layers=alt'));
  map.destroy();
});

test('RASTER-07: a source update repaints immediately and rebuilds the plan with the new URL', async () => {
  const { map } = await makeMap({ center: TILE_2_1_1_CENTER, zoom: 2 });
  const source = map.data.rasterTiles({ id: 'base', url: 'https://a.example/{z}/{x}/{y}.png' });
  map.addLayer({ id: 'basemap', type: 'raster', source });
  assert.ok(
    map.debug.layerTiles('basemap').every((tile) => tile.url.startsWith('https://a.example/')),
  );

  const frames = map.stats().frames;
  source.update({ url: 'https://b.example/{z}/{x}/{y}.png' });
  await settled();
  assert.ok(map.stats().frames > frames, 'a descriptor change requests a repaint, no zoom needed');
  assert.ok(
    map.debug.layerTiles('basemap').every((tile) => tile.url.startsWith('https://b.example/')),
    'the rebuilt plan carries the new template',
  );

  const builds = map.debug.planBuildCount();
  map.debug.layerTiles('basemap');
  assert.equal(map.debug.planBuildCount(), builds, 'the plan is cached until something changes');
  source.update({ attribution: 'changed' });
  map.debug.layerTiles('basemap');
  assert.ok(map.debug.planBuildCount() > builds, 'a further descriptor change rebuilds the plan');
  map.destroy();
});

test('RASTER-11: placements carry ancestor/child fallback chains with exact UV sub-rects', async () => {
  const { map } = await makeMap({ center: TILE_2_1_1_CENTER, zoom: 2 });
  const source = map.data.rasterTiles({
    id: 'chain',
    url: 'https://t.example/{z}/{x}/{y}.png',
    minZoom: 0,
  });
  map.addLayer({ id: 'chain', type: 'raster', source });
  const tile = map.debug.layerTiles('chain').find((entry) => entry.tileKey === '2/1/1');
  assert.ok(tile, 'the centre tile is planned');
  assert.equal(tile.url, 'https://t.example/2/1/1.png');
  assert.deepEqual(
    tile.fallbacks.map((fallback) => [
      fallback.url,
      fallback.u0,
      fallback.v0,
      fallback.u1,
      fallback.v1,
    ]),
    [
      ['https://t.example/1/0/0.png', 0.5, 0.5, 1, 1],
      ['https://t.example/0/0/0.png', 0.25, 0.25, 0.5, 0.5],
    ],
    'ancestors are nearest-first and their UV rectangles pick the occupied quadrant',
  );
  assert.deepEqual(tile.children, [
    'https://t.example/3/2/2.png',
    'https://t.example/3/3/2.png',
    'https://t.example/3/2/3.png',
    'https://t.example/3/3/3.png',
  ]);
  map.destroy();
});

test('RASTER-11: fallback chains respect minZoom and nativeZoom limits', async () => {
  const { map } = await makeMap({ center: TILE_2_1_1_CENTER, zoom: 2 });
  const source = map.data.rasterTiles({
    id: 'limits',
    url: 'https://t.example/{z}/{x}/{y}.png',
    minZoom: 2,
    nativeZoom: 2,
    maxZoom: 18,
  });
  map.addLayer({ id: 'limits', type: 'raster', source });
  const tile = map.debug.layerTiles('limits').find((entry) => entry.tileKey === '2/1/1');
  assert.ok(tile);
  assert.equal(tile.fallbacks.length, 0, 'no ancestor requests below minZoom');
  assert.equal(tile.children, null, 'no child requests above nativeZoom');
  map.destroy();
});

test('RASTER-07/09: raster source updates bump the revision for stale-response handling', async () => {
  const { map } = await makeMap();
  const tiles = map.data.rasterTiles({ id: 't', url: XYZ.url });
  assert.equal(tiles.snapshot().revision, 0);
  tiles.update({ url: 'https://other.example/{z}/{x}/{y}.png' });
  assert.equal(tiles.snapshot().revision, 1);
  assert.match(tiles.getOptions().url, /other\.example/);
  const wms = map.data.wms({ id: 'w', url: 'https://wms.example/', layers: 'roads' });
  wms.setParams({ time: '2026-10-10' });
  assert.equal(wms.snapshot().revision, 1);
  assert.equal(
    (wms.getOptions() as { params?: Record<string, string> }).params?.time,
    '2026-10-10',
  );
  assert.throws(() => tiles.setParams({ time: 'x' }), /not a WMS source/);
  map.destroy();
});

test('WMS-01/03: the plan requests one GetMap per tile with the source CRS semantics', async () => {
  const { map } = await makeMap({ center: { lat: 50, lng: 14 }, zoom: 8 });
  const source = map.data.wms({
    id: 'wms',
    url: 'https://wms.example/ows',
    layers: 'roads',
    version: '1.1.1',
    crs: 'EPSG:4326',
  });
  map.addLayer({ id: 'wms', type: 'raster', source });
  const size = map.size();
  const placements = map.debug.layerTiles('wms');
  assert.ok(placements.length > 1, 'the viewport is covered by several tiles');

  // Every tile requests exactly its own geographic extent in the declared CRS
  // (an independent oracle: the tile key maps through tileGeoBounds).
  for (const placement of placements) {
    const [z, x, y] = placement.tileKey.split('/').map(Number) as [number, number, number];
    const url = new URL(placement.url);
    assert.equal(url.searchParams.get('service'), 'WMS');
    assert.equal(url.searchParams.get('request'), 'GetMap');
    assert.equal(url.searchParams.get('version'), '1.1.1');
    assert.equal(url.searchParams.get('srs'), 'EPSG:4326');
    assert.equal(url.searchParams.get('crs'), null);
    assert.equal(url.searchParams.get('width'), '256');
    assert.equal(url.searchParams.get('height'), '256');
    const geo = tileGeoBounds({ z, x, y });
    const bbox = url.searchParams.get('bbox')!.split(',').map(Number);
    assert.ok(Math.abs(bbox[0]! - geo.southwest.lng) < 1e-9, '1.1.1 BBOX starts with lng');
    assert.ok(Math.abs(bbox[1]! - geo.southwest.lat) < 1e-9);
    assert.ok(Math.abs(bbox[2]! - geo.northeast.lng) < 1e-9);
    assert.ok(Math.abs(bbox[3]! - geo.northeast.lat) < 1e-9);
    assert.ok(Math.abs(placement.sw - 256) < 1e-6, 'a tile is 256 px at its own zoom');
    assert.ok(Math.abs(placement.sh - 256) < 1e-6);
  }
  // The tiles cover the padded viewport, so no part of the view is left out.
  const minX = Math.min(...placements.map((placement) => placement.sx));
  const maxX = Math.max(...placements.map((placement) => placement.sx + placement.sw));
  const minY = Math.min(...placements.map((placement) => placement.sy));
  const maxY = Math.max(...placements.map((placement) => placement.sy + placement.sh));
  assert.ok(minX <= 0 && minY <= 0, 'tiles reach the view origin');
  assert.ok(maxX >= size.width && maxY >= size.height, 'tiles reach past the view edges');

  // Version and CRS change the axis order and units of every tile, not the grid.
  source.update({ version: '1.3.0' });
  const axis = map.debug.layerTiles('wms')[0]!;
  const [az, ax, ay] = axis.tileKey.split('/').map(Number) as [number, number, number];
  const flipped = new URL(axis.url);
  assert.equal(flipped.searchParams.get('crs'), 'EPSG:4326');
  assert.equal(flipped.searchParams.get('srs'), null);
  const flippedGeo = tileGeoBounds({ z: az, x: ax, y: ay });
  const flippedBox = flipped.searchParams.get('bbox')!.split(',').map(Number);
  assert.ok(
    Math.abs(flippedBox[0]! - flippedGeo.southwest.lat) < 1e-9,
    '1.3.0 EPSG:4326 flips to lat,lng',
  );
  assert.ok(Math.abs(flippedBox[1]! - flippedGeo.southwest.lng) < 1e-9);

  source.update({ crs: 'EPSG:3857' });
  const projected = map.debug.layerTiles('wms')[0]!;
  const [pz, px, py] = projected.tileKey.split('/').map(Number) as [number, number, number];
  const projectedGeo = tileGeoBounds({ z: pz, x: px, y: py });
  const projectedBox = new URL(projected.url).searchParams.get('bbox')!.split(',').map(Number);
  // Independent oracle for the northing of the south bound.
  const oracleY =
    6378137 * Math.log(Math.tan(Math.PI / 4 + (projectedGeo.southwest.lat * Math.PI) / 360));
  assert.ok(Math.abs(projectedBox[1]! - oracleY) < 1e-6, '3857 BBOX uses projected metres');
  map.destroy();
});
