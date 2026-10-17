import test from 'node:test';
import assert from 'node:assert/strict';
import { ExpandedFill } from '../../src/render/indexed-fill.ts';
import type { PlanBatch } from '../../src/render/frame-plan.ts';

test('wide-index fallback expands once and updates every shared occurrence locally', () => {
  const data = Float32Array.from({ length: 4 * 12 }, (_, i) => i);
  const batch: PlanBatch = {
    layerId: 'a',
    kind: 'fills',
    data,
    indices: Uint32Array.of(0, 1, 2, 2, 1, 3),
    count: 6,
    upload: { version: 0, previousVersion: -1, ranges: [] },
  };
  const expansion = new ExpandedFill(batch),
    first = expansion.batch(batch);
  const oracle = () =>
    Float32Array.from(
      Array.from(batch.indices!).flatMap((vertex) =>
        Array.from(data.subarray(vertex * 12, vertex * 12 + 12)),
      ),
    );
  assert.deepEqual(first.data, oracle());
  assert.equal(expansion.batch(batch).data, first.data);
  data.fill(-1, 12, 24);
  const next = expansion.batch({
    ...batch,
    upload: { version: 1, previousVersion: 0, ranges: [{ start: 12, end: 24 }] },
  });
  assert.equal(next.data, first.data);
  assert.deepEqual(next.data, oracle());
  assert.deepEqual(next.upload!.ranges, [
    { start: 12, end: 24 },
    { start: 48, end: 60 },
  ]);
  data.fill(8);
  const missed = expansion.batch({
    ...batch,
    upload: { version: 5, previousVersion: 4, ranges: [{ start: 0, end: 12 }] },
  });
  assert.deepEqual(
    missed.data,
    oracle(),
    'missed versions upload complete data, never stale occurrences',
  );
  assert.equal(missed.upload!.previousVersion, -1);
});
