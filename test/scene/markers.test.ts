import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MARKER_ANCHOR,
  DEFAULT_MARKER_SIZE,
  MARKER_LAYER_STYLE,
  MARKER_PIN_ICON_ID,
  MARKER_PIN_URL,
  fitViewportShift,
  isMarkerInit,
  markerPopup,
  markerTooltip,
} from '../../src/ui/markers.ts';

test('MARKER-07: the viewport shift keeps the popup box and its anchor visible', () => {
  const viewport = { width: 600, height: 400 };
  // Fully inside: no shift.
  assert.deepEqual(
    fitViewportShift({ x: 100, y: 100, width: 200, height: 80 }, { x: 200, y: 180 }, viewport),
    { dx: 0, dy: 0 },
  );
  // Above the top edge: content moves down by exactly the missing margin.
  assert.deepEqual(
    fitViewportShift({ x: 100, y: -20, width: 200, height: 80 }, { x: 200, y: 20 }, viewport),
    { dx: 0, dy: 28 },
  );
  // Left edge overflow.
  assert.deepEqual(
    fitViewportShift({ x: -50, y: 100, width: 200, height: 80 }, { x: 50, y: 180 }, viewport),
    { dx: 58, dy: 0 },
  );
  // Bottom-right overflow, bounded by the anchor clamp.
  assert.deepEqual(
    fitViewportShift({ x: 500, y: 380, width: 200, height: 80 }, { x: 560, y: 420 }, viewport),
    { dx: -108, dy: -68 },
  );
  // The box fits but the anchor does not: the clamp moves content to the margin.
  assert.deepEqual(
    fitViewportShift({ x: 400, y: 100, width: 100, height: 60 }, { x: 595, y: 180 }, viewport),
    { dx: -3, dy: 0 },
  );
  // The anchor clamp wins over the box when both cannot fit.
  assert.deepEqual(
    fitViewportShift({ x: -50, y: 100, width: 200, height: 80 }, { x: 590, y: 180 }, viewport),
    { dx: 2, dy: 0 },
  );
  // A box larger than the viewport aligns to the top-left margin; the anchor
  // clamp still keeps the anchor on screen.
  assert.deepEqual(
    fitViewportShift({ x: 0, y: 0, width: 900, height: 500 }, { x: 300, y: 200 }, viewport),
    { dx: 8, dy: 8 },
  );
});

test('MARKER-05: init objects and plain content are told apart', () => {
  assert.equal(isMarkerInit('text'), false);
  assert.equal(isMarkerInit({}), false);
  assert.equal(isMarkerInit({ content: 'x' }), true);
  assert.equal(isMarkerInit({ content: 'x', permanent: true }), true);
  assert.deepEqual(markerTooltip('hola'), { content: 'hola' });
  assert.deepEqual(markerPopup('x'), { content: 'x' });
  const init = { content: 'x', permanent: true };
  assert.equal(markerTooltip(init), init);
  assert.equal(markerPopup({ content: 'x', autoPan: false }).autoPan, false);
});

test('MARKER-01: the marker layer defaults match the built-in pin constants', () => {
  assert.equal(MARKER_LAYER_STYLE.icon, MARKER_PIN_ICON_ID);
  assert.equal(MARKER_LAYER_STYLE.iconSize, DEFAULT_MARKER_SIZE);
  assert.deepEqual(MARKER_LAYER_STYLE.iconAnchor, { ...DEFAULT_MARKER_ANCHOR });
  assert.equal(MARKER_LAYER_STYLE.radiusPx, 6);
  assert.match(MARKER_PIN_URL, /^data:image\/svg\+xml/);
});
