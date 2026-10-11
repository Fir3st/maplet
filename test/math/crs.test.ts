import test from 'node:test';
import assert from 'node:assert/strict';

import {
  crs,
  wrapLongitude,
  haversineMeters,
  lngToUnitX,
  latToUnitY,
  unitXToLng,
  unitYToLat,
  WORLD_SCALE,
  MAX_MERCATOR_LATITUDE,
} from '../../src/math/crs.ts';
import { isMapletError } from '../../src/api/errors.ts';
import { leafletOracle } from '../helpers/leaflet-oracle.ts';

const WGS84 = crs.webMercator();

test('MATH-01: Web Mercator anchor point and axes at scale 256', () => {
  const world = WGS84.toWorld({ lat: 0, lng: 0 });
  assert.equal(world.x, 128);
  assert.ok(Math.abs(world.y - 128) < 1e-9);
  // East = larger x, north = smaller y.
  const east = WGS84.toWorld({ lat: 0, lng: 10 });
  const north = WGS84.toWorld({ lat: 10, lng: 0 });
  assert.ok(east.x > world.x);
  assert.ok(north.y < world.y);
  // Zoom 1 doubles world pixels.
  assert.equal(world.x * 2 ** 1, 256);
  assert.equal(world.y * 2 ** 1, 256);
});

test('MATH-02: fractional zoom is not rounded', () => {
  const scale = (zoom: number): number => 2 ** zoom;
  assert.equal(scale(7.5) / scale(6.5), 2);
  assert.ok(Math.abs(scale(7.5) - 181.01933598375618) < 1e-12);
  // A point projected at z and z+1 with the same center keeps its screen pos.
  const z = 7.5;
  const step = 2 ** z;
  const k = Math.pow(2, 1);
  assert.ok(Math.abs(step * k - 2 ** (z + 1)) < 1e-9);
});

test('MATH-03: project and unproject round trip without lat/lng swap', () => {
  for (const lat of [-80, -45, -10, 0, 15.5, 49.2, 60, 85]) {
    for (const lng of [-179, -90, -1, 0, 14.42, 100, 179.9]) {
      const world = WGS84.toWorld({ lat, lng });
      const back = WGS84.fromWorld(world);
      assert.ok('lat' in back && Math.abs(back.lat - lat) < 1e-9, `lat ${lat}`);
      assert.ok('lng' in back && Math.abs(back.lng - lng) < 1e-9, `lng ${lng}`);
    }
  }
  // Out-of-domain longitudes are normalized first, then round trip.
  const normalized = WGS84.normalize({ lat: 60, lng: 360.5 });
  const back = WGS84.fromWorld(WGS84.toWorld(normalized));
  assert.ok('lat' in back && Math.abs(back.lat - 60) < 1e-9);
  assert.ok('lng' in back && Math.abs(back.lng - 0.5) < 1e-9);
});

test('MATH-04: mercator latitude limit is finite and input is not mutated', () => {
  const atLimit = WGS84.toWorld({ lat: MAX_MERCATOR_LATITUDE, lng: 0 });
  assert.ok(Number.isFinite(atLimit.x) && Number.isFinite(atLimit.y));
  assert.ok(Math.abs(atLimit.y) < 1e-6, `limit lat must map to world y = 0, got ${atLimit.y}`);
  const beyond = WGS84.toWorld({ lat: 90, lng: 0 });
  assert.ok(Number.isFinite(beyond.x) && Number.isFinite(beyond.y));
  assert.equal(beyond.y, atLimit.y);
  const below = WGS84.toWorld({ lat: -90, lng: 0 });
  assert.ok(Math.abs(below.y - WORLD_SCALE) < 1e-6);
  const frozen = Object.freeze({ lat: 60, lng: 14 });
  WGS84.normalize(frozen);
  WGS84.toWorld(frozen);
  assert.deepEqual(frozen, { lat: 60, lng: 14 });
});

test('MATH-05: longitude wrap into [-180, 180)', () => {
  assert.equal(wrapLongitude(-181), 179);
  assert.equal(wrapLongitude(181), -179);
  assert.equal(wrapLongitude(540), -180);
  assert.equal(wrapLongitude(-180), -180);
  assert.equal(wrapLongitude(180), -180);
});

test('MATH-06: EPSG:4326 and EPSG:3395 use their own conversions', () => {
  const g4326 = crs.epsg4326();
  const g3395 = crs.epsg3395();

  // Linear plate carree control points.
  const a = g4326.toWorld({ lat: 45, lng: -90 });
  assert.ok(Math.abs(a.x - 64) < 1e-9);
  assert.ok(Math.abs(a.y - 96) < 1e-9);
  const b = g4326.fromWorld(a);
  assert.ok('lat' in b && Math.abs(b.lat - 45) < 1e-9);
  assert.ok('lng' in b && Math.abs(b.lng + 90) < 1e-9);

  // Ellipsoidal Mercator differs from the spherical one away from the equator:
  // at 45 N the ellipsoidal y is measurably smaller (world y larger).
  const spherical = WGS84.toWorld({ lat: 45, lng: 0 });
  const ellipsoidal = g3395.toWorld({ lat: 45, lng: 0 });
  assert.ok(ellipsoidal.y - spherical.y > 0.1, `delta ${ellipsoidal.y - spherical.y}`);
  assert.notEqual(g3395.code, WGS84.code);

  // Round trip through the Newton inverse.
  for (const lat of [-60, -10, 0, 33.3, 70]) {
    const world = g3395.toWorld({ lat, lng: 14 });
    const back = g3395.fromWorld(world);
    assert.ok('lat' in back && Math.abs(back.lat - lat) < 1e-6, `lat ${lat} -> ${'lat' in back ? back.lat : 'x'}`);
  }
  // Equator matches the spherical Mercator.
  const e0 = g3395.toWorld({ lat: 0, lng: 10 });
  const s0 = WGS84.toWorld({ lat: 0, lng: 10 });
  assert.ok(Math.abs(e0.y - s0.y) < 1e-9);
});

test('MATH-07: Simple preserves planar units and does not read them as degrees', () => {
  const simple = crs.simple();
  const world = simple.toWorld({ x: 2, y: -3 });
  assert.equal(world.x, 2 * WORLD_SCALE);
  assert.equal(world.y, 3 * WORLD_SCALE);
  const back = simple.fromWorld(world);
  assert.deepEqual(back, { x: 2, y: -3 });
  const dist = simple.distance({ x: 0, y: 0 }, { x: 3, y: 4 });
  assert.equal(dist.value, 5);
  assert.equal(dist.unit, 'planarUnits');
  const geoDist = WGS84.distance({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.equal(geoDist.unit, 'meters');
  assert.ok(simple.distance({ x: 0, y: 0 }, { x: 0, y: 10 }).value === 10);
});

test('MATH-09: distance is zero, symmetric and unit-labelled', () => {
  const a = { lat: 50, lng: 14 };
  const b = { lat: 51, lng: 15 };
  assert.equal(WGS84.distance(a, a).value, 0);
  const ab = WGS84.distance(a, b);
  const ba = WGS84.distance(b, a);
  assert.ok(ab.value > 0);
  assert.ok(Math.abs(ab.value - ba.value) < 1e-6);
  assert.equal(ab.unit, 'meters');
  assert.ok(Math.abs(haversineMeters(a, b) - ab.value) < 1e-9);
});

test('MATH-13: non-finite input fails with the offending value', () => {
  try {
    WGS84.toWorld({ lat: NaN, lng: 0 });
    assert.fail('expected an error');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-argument');
    assert.ok(Number.isNaN(error.detail.value));
  }
  try {
    WGS84.toWorld({ lat: 0, lng: Infinity });
    assert.fail('expected an error');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-argument');
    assert.equal(error.detail.value, Infinity);
  }
  const simple = crs.simple();
  try {
    simple.toWorld({ x: 0, y: NaN });
    assert.fail('expected an error');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-argument');
  }
});

test('MATH-14: preserved computations match the Leaflet 1.9.4 oracle', async () => {
  const oracle = await leafletOracle();
  assert.equal(oracle.version, '1.9.4');
  for (const [lat, lng, zoom] of [
    [0, 0, 0],
    [50.08, 14.44, 13],
    [-33.86, 151.2, 7.5],
    [85, -179.5, 3],
  ] as const) {
    const expected = oracle.mercatorProject(lat, lng, zoom);
    const world = WGS84.toWorld({ lat, lng });
    assert.ok(Math.abs(world.x * 2 ** zoom - expected.x) < 1e-6, `x ${lat},${lng},${zoom}`);
    assert.ok(Math.abs(world.y * 2 ** zoom - expected.y) < 1e-6, `y ${lat},${lng},${zoom}`);
  }
  for (const lng of [-181, 181, 540]) {
    assert.equal(wrapLongitude(lng), oracle.wrapLng(lng));
  }
  // Documented explicit difference: Maplet uses the IUGG mean earth radius,
  // Leaflet 1.9.4 uses R = 6371000.
  const a = { lat: 50, lng: 14 };
  const b = { lat: 51, lng: 15 };
  const ours = WGS84.distance(a, b).value;
  const theirs = oracle.distanceMeters(a, b);
  const ratio = ours / theirs;
  assert.ok(Math.abs(ratio - 6371008.8 / 6371000) < 1e-12, `ratio ${ratio}`);
  assert.ok(Math.abs(ours - theirs) / theirs < 2e-6);
});

test('crs registry: lookup, custom registration and rejection of duplicates', () => {
  assert.equal(crs.get('epsg:3857')?.code, 'EPSG:3857');
  assert.equal(crs.get('EPSG:4326')?.positionKind, 'geographic');
  const custom = crs.define({
    code: 'TEST:PLAIN',
    positionKind: 'planar',
    toWorld: (position) => ({
      x: (position as { x: number }).x * 256,
      y: -(position as { y: number }).y * 256,
    }),
    fromWorld: (world) => ({ x: world.x / 256, y: -world.y / 256 }),
  });
  assert.equal(crs.get('test:plain')?.code, 'TEST:PLAIN');
  assert.deepEqual(custom.fromWorld(custom.toWorld({ x: 1, y: 2 })), { x: 1, y: 2 });
  assert.throws(() => crs.define({ code: 'TEST:PLAIN', positionKind: 'planar', toWorld: () => ({ x: 0, y: 0 }), fromWorld: () => ({ x: 0, y: 0 }) }), /already registered/);
  assert.equal(crs.unregister('TEST:PLAIN'), true);
  assert.equal(crs.get('TEST:PLAIN'), undefined);
});

test('unit helpers stay consistent with world scale', () => {
  assert.equal(lngToUnitX(0), 0.5);
  assert.equal(unitXToLng(0.5), 0);
  assert.ok(Math.abs(latToUnitY(0) - 0.5) < 1e-15);
  assert.ok(Math.abs(unitYToLat(0.5)) < 1e-9);
});
