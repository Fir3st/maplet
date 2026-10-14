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
import type { Bounds } from '../../src/math/bounds.ts';
import type { GeoPosition } from '../../src/index.ts';

const XYZ = { url: 'https://tiles.example/{z}/{x}/{y}.png' };
// Centre of tile (z2, x1, y1); a view there places that tile at the view centre.
const TILE_2_1_1_CENTER = { lat: 40.97989806962013, lng: -45 };

test('RASTER-01: XYZ URLs substitute z/x/y and subdomains', () => {
  assert.equal(
    formatTileUrl(XYZ, { z: 12, x: 2200, y: 1343 }, { tms: false }),
    'https://tiles.example/12/2200/1343.png',
  );
  assert.equal(
    formatTileUrl({ url: 'https://{s}.example/{z}/{x}/{y}.png', subdomains: ['a', 'b'] }, { z: 1, x: 1, y: 0 }, { tms: false }),
    'https://b.example/1/1/0.png',
  );
  // The template is codec-agnostic: PNG, SVG and Esri's {z}/{y}/{x} order all
  // resolve to the same tile coordinates (checked in demo/tiles.html).
  assert.equal(
    formatTileUrl({ url: 'https://tiles.example/{z}/{x}/{y}.svg' }, { z: 2, x: 1, y: 1 }, { tms: false }),
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
    formatTileUrl({ url: 'https://example/{z}/{x}/{-y}.png' }, { z: 3, x: 4, y: 2 }, { tms: false }),
    'https://example/3/4/5.png',
  );
});

test('RASTER-03: native zoom caps the requested tile level', () => {
  const grid = tileGridOptions({ id: 't', url: XYZ.url, minZoom: 0, maxZoom: 18, nativeZoom: 12 });
  assert.equal(tileZoomForView(13.5, grid), 12);
  assert.equal(tileZoomForView(11.2, grid), 11);
  assert.equal(tileZoomForView(5, grid), 5);
  const retina = tileGridOptions({ id: 't', url: XYZ.url, minZoom: 0, maxZoom: 18, nativeZoom: 12, retina: true });
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
  const coords = tilesForWorldRect(0, 0, 256, 256, 1, 256, { wrap: false, minZoom: 0, maxZoom: 24 });
  assert.equal(coords.length, 4);
  assert.deepEqual(
    coords.map((c) => `${c.z}/${c.x}/${c.y}`).sort(),
    ['1/0/0', '1/0/1', '1/1/0', '1/1/1'],
  );
  // Wrapping world copies reuse the same tile identity (x = 4..5 wraps to 0..1).
  const wrapped = tilesForWorldRect(512, 0, 768, 256, 1, 256, { wrap: true, minZoom: 0, maxZoom: 24 });
  assert.deepEqual(wrapped.map((c) => c.x), [0, 1, 0, 1]);
  // Without wrap, the same rect clamps to the last column (2 rows x 1 column).
  const clampedX = tilesForWorldRect(512, 0, 768, 256, 1, 256, { wrap: false, minZoom: 0, maxZoom: 24 });
  assert.deepEqual(clampedX.map((c) => c.x), [1, 1]);
  // Without wrap, requests stay inside the grid.
  const clamped = tilesForWorldRect(-256, -256, 0, 0, 1, 256, { wrap: false, minZoom: 0, maxZoom: 24 });
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
    { id: 'w', url: 'https://wms.example/ows', layers: 'roads', version: '1.3.0', crs: 'EPSG:3857' },
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
    { id: 'w', url: 'https://wms.example/ows', layers: 'roads', version: '1.3.0', crs: 'EPSG:3857' },
    { southwest: { lat: -33.9, lng: 0 }, northeast: { lat: 0, lng: 0 } },
    256,
    256,
  );
  const southBbox = new URL(south.url).searchParams.get('bbox')!.split(',').map(Number);
  assert.ok(Math.abs(southBbox[1]! - -4015382.3600731594) < 1e-6, 'southern ymin');
  assert.ok(Math.abs(southBbox[3]! - 0) < 1e-6, 'southern ymax');
  // 1.1.1 keeps the SRS parameter but the BBOX units still follow the CRS.
  const legacy = wmsGetMapUrl(
    { id: 'w', url: 'https://wms.example/ows', layers: 'roads', version: '1.1.1', crs: 'EPSG:3857' },
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

test('RASTER-07: a source update repaints immediately and rebuilds the plan with the new URL', async () => {
  const { map } = await makeMap({ center: TILE_2_1_1_CENTER, zoom: 2 });
  const source = map.data.rasterTiles({ id: 'base', url: 'https://a.example/{z}/{x}/{y}.png' });
  map.addLayer({ id: 'basemap', type: 'raster', source });
  assert.ok(map.debug.layerTiles('basemap').every((tile) => tile.url.startsWith('https://a.example/')));

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
  const source = map.data.rasterTiles({ id: 'chain', url: 'https://t.example/{z}/{x}/{y}.png', minZoom: 0 });
  map.addLayer({ id: 'chain', type: 'raster', source });
  const tile = map.debug.layerTiles('chain').find((entry) => entry.tileKey === '2/1/1');
  assert.ok(tile, 'the centre tile is planned');
  assert.equal(tile.url, 'https://t.example/2/1/1.png');
  assert.deepEqual(
    tile.fallbacks.map((fallback) => [fallback.url, fallback.u0, fallback.v0, fallback.u1, fallback.v1]),
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
  assert.equal((wms.getOptions() as { params?: Record<string, string> }).params?.time, '2026-10-10');
  await assert.rejects(
    (async () => {
      tiles.setParams({ time: 'x' });
    })(),
    /not a WMS source/,
  );
  map.destroy();
});

test('WMS-01/03: the plan requests the view bounds with the source CRS semantics', async () => {
  const { map } = await makeMap({ center: { lat: 50, lng: 14 }, zoom: 8 });
  const source = map.data.wms({
    id: 'wms',
    url: 'https://wms.example/ows',
    layers: 'roads',
    version: '1.1.1',
    crs: 'EPSG:4326',
  });
  map.addLayer({ id: 'wms', type: 'raster', source });
  // The fixture map uses the default geographic CRS, so the view bounds are lng/lat.
  const bounds = map.getBounds() as Bounds<GeoPosition>;
  const [placement] = map.debug.layerTiles('wms');
  assert.ok(placement, 'one GetMap request covers the viewport');
  const url = new URL(placement.url);
  assert.equal(url.searchParams.get('service'), 'WMS');
  assert.equal(url.searchParams.get('request'), 'GetMap');
  assert.equal(url.searchParams.get('version'), '1.1.1');
  assert.equal(url.searchParams.get('srs'), 'EPSG:4326');
  assert.equal(url.searchParams.get('crs'), null);
  const bbox = url.searchParams.get('bbox')!.split(',').map(Number);
  assert.ok(Math.abs(bbox[0]! - bounds.southwest.lng) < 1e-9, '1.1.1 BBOX starts with lng');
  assert.ok(Math.abs(bbox[1]! - bounds.southwest.lat) < 1e-9);
  assert.ok(Math.abs(bbox[2]! - bounds.northeast.lng) < 1e-9);
  assert.ok(Math.abs(bbox[3]! - bounds.northeast.lat) < 1e-9);
  // Request size is the viewport rounded up to whole 256 px tiles.
  assert.equal(url.searchParams.get('width'), '1024');
  assert.equal(url.searchParams.get('height'), '768');
  // The single placement covers the whole viewport in CSS pixels.
  assert.ok(Math.abs(placement.sx) < 1e-6 && Math.abs(placement.sy) < 1e-6);
  assert.ok(Math.abs(placement.sw - 800) < 1e-6 && Math.abs(placement.sh - 600) < 1e-6);

  source.update({ version: '1.3.0' });
  const flipped = new URL(map.debug.layerTiles('wms')[0]!.url).searchParams.get('bbox')!.split(',').map(Number);
  assert.ok(Math.abs(flipped[0]! - bounds.southwest.lat) < 1e-9, '1.3.0 EPSG:4326 flips to lat,lng');
  assert.ok(Math.abs(flipped[1]! - bounds.southwest.lng) < 1e-9);

  source.update({ crs: 'EPSG:3857' });
  const projected = new URL(map.debug.layerTiles('wms')[0]!.url).searchParams.get('bbox')!.split(',').map(Number);
  // Independent oracle for the northing of the south bound.
  const oracleY =
    6378137 * Math.log(Math.tan(Math.PI / 4 + (bounds.southwest.lat * Math.PI) / 360));
  assert.ok(Math.abs(projected[1]! - oracleY) < 1e-6, '3857 BBOX uses projected metres');
  map.destroy();
});
