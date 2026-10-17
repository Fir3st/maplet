/**
 * PICK-12: measured pick stall.
 *
 * The recorder keeps the blocking span of every pick, the blocking readback
 * part and the readback semantics, so the async pick API cannot hide a
 * synchronous `readPixels`. The real WebGL 1/WebGPU numbers are measured in
 * `demo/pick.html`; these tests pin the accounting and the no-backend default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { monotonicNow, PickStallRecorder } from '../../src/render/picking.ts';
import { makeMap } from '../helpers/fixture.ts';

test('PICK-12: the recorder keeps spans, readback split, semantics and totals', () => {
  const recorder = new PickStallRecorder('blocking');
  assert.deepEqual(recorder.snapshot(), {
    picks: 0,
    lastMs: 0,
    maxMs: 0,
    lastReadMs: 0,
    maxReadMs: 0,
    totalMs: 0,
    readback: 'blocking',
  });

  recorder.record(4, 3.5);
  recorder.record(2, 1);
  assert.deepEqual(recorder.snapshot(), {
    picks: 2,
    lastMs: 2,
    maxMs: 4,
    lastReadMs: 1,
    maxReadMs: 3.5,
    totalMs: 6,
    readback: 'blocking',
  });

  const asyncRecorder = new PickStallRecorder('async');
  asyncRecorder.record(0.5, 0.05);
  assert.equal(asyncRecorder.snapshot().readback, 'async');
});

test('PICK-12: monotonicNow advances inside a busy span', () => {
  const before = monotonicNow();
  // Busy-wait for a measurable span; the loop body intentionally does nothing.
  while (monotonicNow() - before < 1) {
    /* spin */
  }
  assert.ok(monotonicNow() - before >= 1, 'the clock advanced at least a millisecond');
});

test('PICK-12: a map without a GPU backend reports no picks and no readback', async () => {
  const { map } = await makeMap();
  assert.equal(map.capabilities().backend, 'none');
  assert.deepEqual(map.stats().picking, {
    picks: 0,
    lastMs: 0,
    maxMs: 0,
    lastReadMs: 0,
    maxReadMs: 0,
    totalMs: 0,
    readback: 'none',
  });
  map.destroy();
});
