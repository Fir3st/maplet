import test from 'node:test';
import assert from 'node:assert/strict';

import { locateFailureMessage, locateViewOption } from '../../src/ui/controls.ts';

test('UI-11: locate failures map to specific status messages', () => {
  assert.equal(locateFailureMessage('permission'), 'Location permission denied');
  assert.equal(locateFailureMessage('timeout'), 'Location request timed out');
  assert.equal(locateFailureMessage('unavailable'), 'Location unavailable');
  assert.equal(locateFailureMessage('unsupported'), 'Location is not supported');
});

test('UI-11: locate view options preserve opt-out and optional zoom', () => {
  assert.equal(locateViewOption({}), true);
  assert.equal(locateViewOption({ setView: true }), true);
  assert.equal(locateViewOption({ setView: false }), false);
  assert.equal(locateViewOption({ setView: false, zoom: 12 }), false);
  assert.deepEqual(locateViewOption({ zoom: 12 }), { zoom: 12 });
});
