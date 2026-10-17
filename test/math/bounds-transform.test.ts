import test from 'node:test';
import assert from 'node:assert/strict';

import {
  crs,
  EARTH_RADIUS_METERS,
  boundsFromPositions,
  boundsCenter,
  boundsSize,
  boundsContains,
  boundsIntersect,
  boundsLongitudeSpan,
  mergeBounds,
  extendBounds,
  tightestLongitudeInterval,
  positionToScreen,
  screenToPosition,
  metricCircleScreenRadius,
  type ViewTransform,
  type Bounds,
  type GeoBounds,
  type Position,
} from '../../src/math/index.ts';
import { scaleBar, metersPerPixel } from '../../src/math/measure.ts';
import { leafletOracle } from '../helpers/leaflet-oracle.ts';

const WGS84 = crs.webMercator();

function assertGeoBounds(bounds: Bounds<Position> | null): asserts bounds is GeoBounds {
  assert.ok(bounds, 'expected bounds');
  assert.ok('lat' in bounds.southwest, 'expected geographic bounds');
}

function assertPlanarBounds(
  bounds: Bounds<Position> | null,
): asserts bounds is Bounds<Position> & { southwest: { x: number; y: number } } {
  assert.ok(bounds, 'expected bounds');
  assert.ok('x' in bounds.southwest, 'expected planar bounds');
}

function transform(
  lat: number,
  lng: number,
  zoom: number,
  width = 800,
  height = 600,
): ViewTransform {
  return {
    crs: WGS84,
    width,
    height,
    centerWorld: WGS84.toWorld({ lat, lng }),
    zoom,
  };
}

test('MATH-08: screen -> geo -> screen round trip across sizes and DPR-independent CSS px', () => {
  for (const [width, height] of [
    [800, 600],
    [400, 300],
    [1234, 567],
  ] as const) {
    const view = transform(50.08, 14.44, 13, width, height);
    const center = positionToScreen(view, { lat: 50.08, lng: 14.44 });
    assert.ok(Math.abs(center.x - width / 2) < 1e-9);
    assert.ok(Math.abs(center.y - height / 2) < 1e-9);
    for (const point of [
      { x: 0, y: 0 },
      { x: width - 1, y: height - 1 },
      { x: 200, y: 150 },
      { x: width / 3, y: (2 * height) / 3 },
    ]) {
      const back = positionToScreen(view, screenToPosition(view, point));
      assert.ok(Math.abs(back.x - point.x) < 1e-6, `x at ${JSON.stringify(point)}`);
      assert.ok(Math.abs(back.y - point.y) < 1e-6, `y at ${JSON.stringify(point)}`);
    }
  }
  // Simple CRS uses planar positions on the same transform path.
  const simpleView: ViewTransform = {
    crs: crs.simple(),
    width: 640,
    height: 480,
    centerWorld: crs.simple().toWorld({ x: 0, y: 0 }),
    zoom: 2,
  };
  const planar = screenToPosition(simpleView, { x: 100, y: 80 });
  assert.ok('x' in planar && 'y' in planar && !('lat' in planar));
  const back = positionToScreen(simpleView, planar);
  assert.ok(Math.abs(back.x - 100) < 1e-9 && Math.abs(back.y - 80) < 1e-9);
});

test('MATH-10: pixel circles are style radii; metric circles use the geographic calculation', () => {
  // A pixel radius is constant CSS px by definition of the points layer style;
  // this test pins the metric path that converts metres to screen radii.
  const r0 = metricCircleScreenRadius(WGS84, { lat: 0, lng: 14 }, 100, 10);
  const r0z = metricCircleScreenRadius(WGS84, { lat: 0, lng: 14 }, 100, 11);
  assert.ok(Math.abs(r0z.rx - r0.rx * 2) < 1e-6, 'metric radius doubles with one zoom level');
  assert.ok(Math.abs(r0z.ry - r0.ry * 2) < 1e-6);
  const rHighLat = metricCircleScreenRadius(WGS84, { lat: 60, lng: 14 }, 100, 10);
  assert.ok(rHighLat.rx > r0.rx * 1.5, 'longitude radians shrink with cos(lat)');
  assert.ok(Number.isFinite(rHighLat.ry) && rHighLat.ry > 0);

  const planar = metricCircleScreenRadius(crs.simple(), { x: 0, y: 0 }, 2, 3);
  assert.equal(planar.rx, 2 * 256 * 2 ** 3);

  // Leaflet oracle: a 100 m circle at the equator in Web Mercator, using the
  // declared earth radius of the new package.
  const oracleRadiusPx = 100 / ((2 * Math.PI * EARTH_RADIUS_METERS) / (256 * 2 ** 10));
  assert.ok(Math.abs(r0.rx - oracleRadiusPx) < 1e-9, `rx ${r0.rx} vs ${oracleRadiusPx}`);
});

test('MATH-11: bounds of several points, empty set and a single point', () => {
  const bounds = boundsFromPositions([
    { lat: 40, lng: 14 },
    { lat: 50, lng: 20 },
    { lat: 45, lng: 10 },
  ]);
  assertGeoBounds(bounds);
  assert.equal(bounds.southwest.lat, 40);
  assert.equal(bounds.northeast.lat, 50);
  assert.equal(bounds.southwest.lng, 10);
  assert.equal(bounds.northeast.lng, 20);

  assert.equal(boundsFromPositions([]), null);

  const single = boundsFromPositions([{ lat: 50, lng: 14 }]);
  assertGeoBounds(single);
  assert.equal(single.southwest.lat, 50);
  assert.equal(single.northeast.lat, 50);
  const center = boundsCenter(single);
  assert.ok('lat' in center && center.lat === 50 && center.lng === 14);
  assert.deepEqual(boundsSize(single), { width: 0, height: 0 });

  const extended = extendBounds(single, { lat: 52, lng: 16 });
  assertGeoBounds(extended);
  assert.equal(extended.northeast.lat, 52);
  const merged = mergeBounds(bounds, extended);
  assertGeoBounds(merged);
  assert.equal(merged.northeast.lat, 52);
  assert.equal(mergeBounds(null, null), null);
  const planar = boundsFromPositions([
    { x: 0, y: -1 },
    { x: 5, y: -3 },
  ]);
  assertPlanarBounds(planar);
  assert.equal(planar.southwest.y, -3);
  assert.equal(boundsContains(planar, { x: 1, y: -2 }), true);
  assert.equal(boundsContains(planar, { x: 6, y: -2 }), false);
});

test('MATH-12: antimeridian bounds pick the short allowed interval', () => {
  const naive = boundsFromPositions([
    { lat: 60, lng: 170 },
    { lat: 62, lng: -170 },
  ]);
  assertGeoBounds(naive);
  assert.equal(boundsLongitudeSpan(naive), 340);

  const wrapped = boundsFromPositions(
    [
      { lat: 60, lng: 170 },
      { lat: 62, lng: -170 },
    ],
    { wrapAntimeridian: true },
  );
  assertGeoBounds(wrapped);
  assert.equal(wrapped.crossesAntimeridian, true);
  assert.equal(wrapped.southwest.lng, 170);
  assert.equal(wrapped.northeast.lng, -170);
  assert.equal(boundsLongitudeSpan(wrapped), 20);
  assert.equal(boundsContains(wrapped, { lat: 61, lng: 175 }), true);
  assert.equal(boundsContains(wrapped, { lat: 61, lng: -175 }), true);
  assert.equal(boundsContains(wrapped, { lat: 61, lng: 0 }), false);

  const other = boundsFromPositions([{ lat: 61, lng: 178 }], { wrapAntimeridian: true });
  assert.ok(other);
  assert.equal(boundsIntersect(wrapped, other), true);
  const nowhere = boundsFromPositions([{ lat: 61, lng: 10 }]);
  assert.ok(nowhere);
  assert.equal(boundsIntersect(wrapped, nowhere), false);

  const [west, east, crosses] = tightestLongitudeInterval([170, -170]);
  assert.equal(west, 170);
  assert.equal(east, -170);
  assert.equal(crosses, true);
});

test('MATH-14: bounds and wrap match the Leaflet oracle for preserved contracts', async () => {
  const oracle = await leafletOracle();
  const points = [oracle.latLng(40, 14), oracle.latLng(50, 20), oracle.latLng(45, 10)];
  const expected = oracle.boundsOf(points);
  const bounds = boundsFromPositions([
    { lat: 40, lng: 14 },
    { lat: 50, lng: 20 },
    { lat: 45, lng: 10 },
  ]);
  assertGeoBounds(bounds);
  assert.ok(Math.abs(bounds.southwest.lat - expected.sw.lat) < 1e-9);
  assert.ok(Math.abs(bounds.northeast.lng - expected.ne.lng) < 1e-9);
});

test('UI-04: scale bar uses the CRS unit and doubles with zoom', () => {
  const geo = scaleBar(WGS84, { lat: 50, lng: 14 }, 10, 120);
  assert.equal(geo.unit, 'meters');
  assert.ok(geo.pixels <= 121 && geo.pixels > 0);
  assert.match(geo.label, /(km|m)$/);

  const metersAt = metersPerPixel(WGS84, { lat: 50, lng: 14 }, 10).value;
  const metersUp = metersPerPixel(WGS84, { lat: 50, lng: 14 }, 11).value;
  assert.ok(Math.abs(metersUp * 2 - metersAt) < 1e-9);

  const planar = scaleBar(crs.simple(), { x: 0, y: 0 }, 4, 120);
  assert.equal(planar.unit, 'planarUnits');
  assert.match(planar.label, /u$/);
});
