import test from 'node:test';
import assert from 'node:assert/strict';

import { isMapletError } from '../../src/api/errors.ts';
import {
  MediaSourceImpl,
  normalizeMediaBounds,
  premultiplyRegion,
  validateMediaRegion,
} from '../../src/scene/media-source.ts';

test('MEDIA-04: region validation rejects out-of-bounds, bad stride and short buffers', () => {
  const size = { width: 8, height: 8 };
  // Valid region with an explicit row stride.
  assert.deepEqual(
    validateMediaRegion({ x: 2, y: 2, width: 2, height: 2 }, { stride: 16, length: 32 }, size),
    { stride: 16 },
  );
  // Default stride = width * 4.
  assert.deepEqual(validateMediaRegion({ x: 0, y: 0, width: 3, height: 4 }, { length: 48 }, size), {
    stride: 12,
  });
  const rejects = (run: () => void, why: string): void => {
    assert.throws(
      run,
      (error: unknown) => isMapletError(error) && error.code === 'invalid-region',
      why,
    );
  };
  rejects(
    () => validateMediaRegion({ x: 7, y: 7, width: 2, height: 2 }, { length: 16 }, size),
    'region outside the bitmap',
  );
  rejects(
    () => validateMediaRegion({ x: 0, y: 0, width: 2, height: 2 }, { stride: 4, length: 16 }, size),
    'stride below width * 4',
  );
  rejects(
    () => validateMediaRegion({ x: 0, y: 0, width: 2, height: 2 }, { length: 8 }, size),
    'short pixel buffer',
  );
  rejects(
    () => validateMediaRegion({ x: 0.5, y: 0, width: 2, height: 2 }, { length: 16 }, size),
    'non-integer origin',
  );
  rejects(
    () => validateMediaRegion({ x: 0, y: 0, width: 0, height: 2 }, { length: 0 }, size),
    'zero-width region',
  );
});

test('MEDIA-01: bounds are normalized and mixed position kinds are rejected', () => {
  assert.deepEqual(
    normalizeMediaBounds({
      southwest: { lat: 50.2, lng: 14.6 },
      northeast: { lat: 50.0, lng: 14.3 },
    }),
    {
      southwest: { lat: 50.0, lng: 14.3 },
      northeast: { lat: 50.2, lng: 14.6 },
    },
  );
  assert.deepEqual(
    normalizeMediaBounds({ southwest: { x: 10, y: 20 }, northeast: { x: 0, y: 5 } }),
    { southwest: { x: 0, y: 5 }, northeast: { x: 10, y: 20 } },
  );
  assert.throws(
    () =>
      normalizeMediaBounds({
        southwest: { lat: 50, lng: 14 },
        northeast: { x: 10, y: 20 } as never,
      }),
    (error: unknown) => isMapletError(error) && error.code === 'invalid-argument',
  );
  assert.throws(
    () => normalizeMediaBounds({ southwest: { lat: Number.NaN, lng: 14 }, northeast: { lat: 50, lng: 15 } }),
    (error: unknown) => isMapletError(error) && error.code === 'invalid-argument',
  );
});

test('MEDIA-08: media creation degrades to an explicit error without DOM', () => {
  const source = new MediaSourceImpl(
    {
      id: 'image',
      url: './image.png',
      bounds: { southwest: { lat: 50, lng: 14 }, northeast: { lat: 50.1, lng: 14.1 } },
    },
    'image',
  );
  const snapshot = source.snapshot();
  assert.equal(snapshot.state, 'error');
  assert.match(snapshot.error ?? '', /not available/);
  assert.equal(snapshot.kind, 'image');
  assert.equal(source.hasPixels(), false);
  // Region updates on a non-ready source are refused before any state change.
  assert.throws(
    () => source.updateRegion({ x: 0, y: 0, width: 1, height: 1 }, new Uint8Array(4)),
    (error: unknown) => isMapletError(error) && error.code === 'invalid-state',
  );
  source.destroy();
});

test('MEDIA-03: region pixels are premultiplied row by row for partial uploads', () => {
  // 2x2 region with a stride of 12 (3 pixels per row), only the first 2 used.
  const stride = 12;
  const pixels = new Uint8Array([
    200, 100, 50, 255, 0, 100, 200, 128, 9, 9, 9, 9,
    10, 20, 30, 0, 255, 255, 255, 128, 7, 7, 7, 7,
  ]);
  const region = { x: 0, y: 0, width: 2, height: 2 };
  assert.deepEqual([...premultiplyRegion(pixels, stride, region)], [
    200, 100, 50, 255, 0, 50, 100, 128,
    0, 0, 0, 0, 128, 128, 128, 128,
  ]);
});
