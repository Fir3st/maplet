import test from 'node:test';
import assert from 'node:assert/strict';

import type { GeoPosition, PlanarPosition } from '../../src/api/types.ts';
import { representativePosition } from '../../src/ui/detail.ts';

test('UI-05: representative position of every geometry kind', () => {
  assert.deepEqual(representativePosition({ type: 'point', position: { lat: 50, lng: 14 } }), {
    lat: 50,
    lng: 14,
  });
  assert.deepEqual(
    representativePosition({
      type: 'multiPoint',
      positions: [
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
      ],
    }),
    { lat: 1, lng: 2 },
  );
  assert.deepEqual(
    representativePosition({
      type: 'lineString',
      positions: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 0, lng: 2 },
      ],
    }),
    { lat: 0, lng: 1 },
  );
  assert.deepEqual(
    representativePosition({
      type: 'polygon',
      rings: [
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 2 },
          { lat: 2, lng: 2 },
        ],
      ],
    }),
    { lat: 0, lng: 0 },
  );
  assert.deepEqual(
    representativePosition({
      type: 'circle',
      center: { lat: 5, lng: 6 },
      radius: 10,
      unit: 'meters',
    }),
    { lat: 5, lng: 6 },
  );
  assert.deepEqual(
    representativePosition({
      type: 'rectangle',
      southwest: { lat: 0, lng: 0 },
      northeast: { lat: 10, lng: 20 },
    }),
    { lat: 5, lng: 10 },
  );
  assert.deepEqual(
    representativePosition<PlanarPosition>({
      type: 'rectangle',
      southwest: { x: 0, y: 0 },
      northeast: { x: 10, y: 20 },
    }),
    { x: 5, y: 10 },
  );
});

test('UI-05: empty multi geometries have no representative position', () => {
  assert.equal(representativePosition<GeoPosition>({ type: 'multiPoint', positions: [] }), null);
  assert.equal(representativePosition<GeoPosition>({ type: 'lineString', positions: [] }), null);
  assert.equal(representativePosition<GeoPosition>({ type: 'polygon', rings: [] }), null);
  assert.equal(representativePosition<GeoPosition>({ type: 'multiPolygon', polygons: [] }), null);
});
