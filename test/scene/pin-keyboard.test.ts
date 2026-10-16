import test from 'node:test';
import assert from 'node:assert/strict';

import {
  focusAnnouncement,
  pinFocusBox,
  pinFocusVisible,
  pinsStopLabel,
  stepFocusIndex,
} from '../../src/ui/pin-keyboard.ts';

test('MARKER-15: the pins stop label names the group and its size', () => {
  assert.equal(pinsStopLabel(0), 'Map pins (0). Arrow keys move between pins, Enter activates.');
  assert.equal(pinsStopLabel(12), 'Map pins (12). Arrow keys move between pins, Enter activates.');
});

test('MARKER-15: the announcement reads as a named position in the cycle', () => {
  assert.equal(focusAnnouncement('Freight depot', 0, 3), 'Freight depot, 1 of 3');
  assert.equal(focusAnnouncement('22 pins', 2, 5), '22 pins, 3 of 5');
  assert.equal(focusAnnouncement('Pin', 0, 1), 'Pin, 1 of 1');
});

test('MARKER-15: cursor stepping wraps, honours the ends and survives a lost target', () => {
  assert.equal(stepFocusIndex(0, 3, 'next'), 1);
  assert.equal(stepFocusIndex(2, 3, 'next'), 0);
  assert.equal(stepFocusIndex(0, 3, 'previous'), 2);
  assert.equal(stepFocusIndex(1, 3, 'first'), 0);
  assert.equal(stepFocusIndex(1, 3, 'last'), 2);
  // The focused pin left the map (index -1): a step lands on an end.
  assert.equal(stepFocusIndex(-1, 3, 'next'), 0);
  assert.equal(stepFocusIndex(-1, 3, 'previous'), 2);
  assert.equal(stepFocusIndex(0, 0, 'next'), -1);
  assert.equal(stepFocusIndex(0, 0, 'last'), -1);
});

test('MARKER-15: the ring box hugs the sprite and parks outside the container', () => {
  const viewport = { width: 640, height: 480 };
  assert.deepEqual(pinFocusBox({ x: 100, y: 100 }, 32, viewport), {
    left: 84,
    top: 84,
    size: 32,
    visible: true,
  });
  // Exactly on the corner counts as inside; one pixel out parks the ring.
  assert.equal(pinFocusVisible({ x: 640, y: 480 }, viewport), true);
  assert.equal(pinFocusVisible({ x: 640.5, y: 100 }, viewport), false);
  assert.equal(pinFocusVisible({ x: -0.5, y: 100 }, viewport), false);
  assert.equal(pinFocusBox({ x: -20, y: 100 }, 46, viewport).visible, false);
});
