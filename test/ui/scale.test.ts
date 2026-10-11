import test from 'node:test';
import assert from 'node:assert/strict';

import { geographicScale, metersPerPixel, planarScale, unitsPerPixel } from '../../src/ui/scale.ts';

test('UI-04: meters per pixel follows the earth relation at latitude', () => {
  assert.ok(Math.abs(metersPerPixel(0, 0) - 156543.03392) < 1e-4);
  const equator = metersPerPixel(4, 0);
  const north = metersPerPixel(4, 60);
  // Web Mercator/equirect east-west scale halves at 60° north.
  assert.ok(Math.abs(north - equator * 0.5) < 1e-9);
});

test('UI-04: geographic scale picks nice round distances and labels m/km', () => {
  const step = geographicScale(4, 50);
  // mpp ≈ 6289.6 m; the largest 1/2/5×10ⁿ step within 100 px is 500 km.
  assert.equal(step.unit, 'km');
  assert.equal(step.value, 500);
  assert.equal(step.label, '500 km');
  const expectedWidth = 500000 / metersPerPixel(4, 50);
  assert.ok(Math.abs(step.widthPx - expectedWidth) < 1e-6);
  assert.ok(step.widthPx > 40 && step.widthPx <= 100);

  const closer = geographicScale(12, 50);
  assert.equal(closer.unit, 'km');
  assert.equal(closer.label, '2 km');

  const street = geographicScale(18, 0);
  assert.equal(street.unit, 'm');
  assert.equal(street.label, '50 m');
});

test('UI-04: planar scale uses CRS units, never earth meters', () => {
  assert.equal(unitsPerPixel(4), 1 / 16);
  const step = planarScale(4);
  assert.equal(step.unit, 'u');
  assert.equal(step.label, '5 u');
  assert.ok(Math.abs(step.widthPx - 5 / unitsPerPixel(4)) < 1e-6);

  const exact = planarScale(0);
  assert.equal(exact.label, '100 u');
  assert.equal(exact.unit, 'u');
  for (const zoom of [0, 2, 6, 12]) {
    assert.notEqual(planarScale(zoom).unit, 'm');
    assert.notEqual(planarScale(zoom).unit, 'km');
  }
});

test('UI-04: scale width stays within the requested bound across zooms and latitudes', () => {
  for (const zoom of [0, 3, 7, 12, 18]) {
    for (const lat of [0, 35, 60, -45]) {
      const step = geographicScale(zoom, lat, 80);
      assert.ok(step.widthPx > 0 && step.widthPx <= 80 + 1e-9, `width ${step.widthPx}`);
      assert.ok(step.value > 0);
    }
  }
});
