import test from 'node:test';
import assert from 'node:assert/strict';

import { attributionsForLayers, dedupeAttributions } from '../../src/ui/attribution.ts';

test('UI-03: duplicate attributions are deduplicated in first-seen order', () => {
  assert.deepEqual(dedupeAttributions(['© A', '© B', '© A']), ['© A', '© B']);
  assert.deepEqual(dedupeAttributions(['', '   ', undefined, null, ' © A ']), ['© A']);
  assert.deepEqual(dedupeAttributions([]), []);
});

test('UI-03: only sources used by a layer contribute to the notice', () => {
  const sources = [
    { sourceId: 'a', attribution: '© A' },
    { sourceId: 'b', attribution: '© B' },
    { sourceId: 'unused', attribution: '© UNUSED' },
    { sourceId: 'vector', attribution: null },
  ];
  assert.deepEqual(
    attributionsForLayers(sources, [{ sourceId: 'a' }, { sourceId: 'b' }, { sourceId: 'vector' }]),
    ['© A', '© B'],
  );
});

test('UI-03: a notice shared by two sources survives removing one of them', () => {
  const sources = [
    { sourceId: 'a', attribution: '© SHARED' },
    { sourceId: 'b', attribution: '© B' },
    { sourceId: 'c', attribution: '© SHARED' },
  ];
  assert.deepEqual(
    attributionsForLayers(sources, [{ sourceId: 'a' }, { sourceId: 'b' }, { sourceId: 'c' }]),
    ['© SHARED', '© B'],
  );
  // Source a (and its layer) is removed; c still carries the shared notice.
  assert.deepEqual(
    attributionsForLayers(sources, [{ sourceId: 'b' }, { sourceId: 'c' }]),
    ['© B', '© SHARED'],
  );
  // Removing the last source with the shared notice removes it.
  assert.deepEqual(attributionsForLayers(sources, [{ sourceId: 'b' }]), ['© B']);
  assert.deepEqual(attributionsForLayers(sources, []), []);
});
