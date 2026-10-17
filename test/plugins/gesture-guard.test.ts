import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultGestureHint,
  gestureAllowed,
  gestureGuard,
  modifierHeld,
  type GestureGuardApi,
} from '../../src/plugins/gesture-guard.ts';
import type { GestureRequest } from '../../src/interaction/interaction.ts';
import type { PluginContext } from '../../src/plugins.ts';

const request = (patch: Partial<GestureRequest>): GestureRequest => ({
  kind: 'pan',
  pointerType: 'mouse',
  pointers: 1,
  originalEvent: {} as Event,
  ...patch,
});

test('INPUT-09: touch gestures need the configured finger count', () => {
  const state = { unlocked: false, modifier: 'alt' as const, touchPointers: 2 };
  assert.equal(gestureAllowed(request({ pointerType: 'touch', pointers: 1 }), state), false);
  assert.equal(
    gestureAllowed(request({ pointerType: 'touch', pointers: 2, kind: 'pinch' }), state),
    true,
  );
  assert.equal(
    gestureAllowed(request({ pointerType: 'touch', pointers: 1, kind: 'featureDrag' }), state),
    false,
  );
  assert.equal(
    gestureAllowed(request({ pointerType: 'touch', pointers: 2, kind: 'featureDrag' }), state),
    true,
  );
  assert.equal(
    gestureAllowed(request({ pointerType: 'touch', pointers: 2 }), { ...state, touchPointers: 3 }),
    false,
  );
  assert.equal(
    gestureAllowed(request({ pointerType: 'touch', pointers: 3 }), { ...state, touchPointers: 3 }),
    true,
  );
});

test('INPUT-09: mouse, pen, wheel and double-click need the modifier', () => {
  const state = { unlocked: false, modifier: 'alt' as const, touchPointers: 2 };
  assert.equal(gestureAllowed(request({}), state), false);
  assert.equal(
    gestureAllowed(request({ originalEvent: { altKey: true } as unknown as Event }), state),
    true,
  );
  assert.equal(
    gestureAllowed(
      request({ kind: 'wheel', originalEvent: { altKey: false } as unknown as Event }),
      state,
    ),
    false,
  );
  assert.equal(
    gestureAllowed(
      request({ kind: 'wheel', originalEvent: { altKey: true } as unknown as Event }),
      state,
    ),
    true,
  );
  // A touch double-tap reports 'mouse' as a double-click and needs the modifier.
  assert.equal(gestureAllowed(request({ kind: 'doubleClick' }), state), false);
  assert.equal(
    gestureAllowed(
      request({ kind: 'doubleClick', originalEvent: { altKey: true } as unknown as Event }),
      state,
    ),
    true,
  );
  assert.equal(gestureAllowed(request({ pointerType: 'pen' }), state), false);
  assert.equal(gestureAllowed(request({}), { ...state, unlocked: true }), true);
  assert.equal(gestureAllowed(request({}), { ...state, modifier: 'none' }), true);
  // `none` removes the modifier requirement; it never bypasses the finger rule.
  assert.equal(
    gestureAllowed(request({ kind: 'pan', pointerType: 'touch', pointers: 1 }), {
      ...state,
      modifier: 'none',
    }),
    false,
  );
});

test('INPUT-09: modifierHeld reads the matching event flag', () => {
  const event = {
    altKey: true,
    ctrlKey: false,
    shiftKey: true,
    metaKey: false,
  } as unknown as Event;
  assert.equal(modifierHeld('alt', event), true);
  assert.equal(modifierHeld('control', event), false);
  assert.equal(modifierHeld('shift', event), true);
  assert.equal(modifierHeld('meta', event), false);
  assert.equal(modifierHeld('none', event), true);
});

test('INPUT-09: hint text names the finger count or the modifier', () => {
  const state = { modifier: 'alt' as const, touchPointers: 2 };
  assert.equal(
    defaultGestureHint(request({ pointerType: 'touch' }), state),
    'Use 2 fingers to move the map',
  );
  assert.equal(
    defaultGestureHint(request({ pointerType: 'touch', kind: 'featureDrag' }), state),
    'Use 2 fingers to move the pin',
  );
  assert.equal(
    defaultGestureHint(request({ kind: 'wheel' }), state),
    'Hold Alt and scroll to zoom the map',
  );
  assert.equal(
    defaultGestureHint(request({ kind: 'doubleClick' }), { ...state, modifier: 'control' }),
    'Hold Ctrl and double-click to zoom',
  );
  assert.equal(
    defaultGestureHint(request({ kind: 'featureDrag' }), { ...state, modifier: 'meta' }),
    'Hold Meta and drag to move the feature',
  );
  assert.equal(
    defaultGestureHint(request({}), { ...state, modifier: 'none' }),
    'Gestures are currently locked',
  );
});

interface FakeContainer {
  style: Record<string, string>;
}

function fakeContext(
  container: FakeContainer | null,
  interaction: { setGestureGate: (gate: unknown) => void } | null,
): {
  context: PluginContext;
  cleanups: (() => void)[];
} {
  const cleanups: (() => void)[] = [];
  const context = {
    map: { interaction },
    container,
    render: {},
    signal: new AbortController().signal,
    onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
  } as unknown as PluginContext;
  return { context, cleanups };
}

test('INPUT-09: the plugin installs the gate, manages touch-action and unlocks', () => {
  let gate: ((request: GestureRequest) => boolean) | null = null;
  const interaction = {
    setGestureGate: (next: unknown) => {
      gate = next as typeof gate;
    },
  };
  const container: FakeContainer = { style: { touchAction: 'none' } };
  const { context, cleanups } = fakeContext(container, interaction);
  const changes: boolean[] = [];
  const api: GestureGuardApi = gestureGuard({
    overlay: false,
    onChange: (state) => changes.push(state.unlocked),
  })(context);
  assert.equal(container.style['touchAction'], 'pan-y');
  assert.ok(gate, 'the gate must be installed');
  const allow = (request: Partial<GestureRequest>): boolean => gate!(request as GestureRequest);

  assert.equal(api.unlocked, false);
  assert.equal(allow({ kind: 'pan', pointerType: 'touch', pointers: 1 }), false);
  assert.equal(allow({ kind: 'pinch', pointerType: 'touch', pointers: 2 }), true);
  api.unlock();
  assert.deepEqual(changes, [true]);
  assert.equal(allow({ kind: 'pan', pointerType: 'touch', pointers: 1 }), true);
  api.lock();
  assert.deepEqual(changes, [true, false]);
  assert.equal(allow({ kind: 'pan', pointerType: 'touch', pointers: 1 }), false);

  api.setModifier('control');
  assert.equal(
    allow({
      kind: 'pan',
      pointerType: 'mouse',
      originalEvent: { ctrlKey: true } as unknown as Event,
    }),
    true,
  );
  assert.equal(
    allow({
      kind: 'pan',
      pointerType: 'mouse',
      originalEvent: { altKey: true } as unknown as Event,
    }),
    false,
  );

  for (const cleanup of cleanups) cleanup();
  assert.equal(gate, null, 'cleanup must clear the gate');
  assert.equal(container.style['touchAction'], 'none', 'cleanup must restore touch-action');
});

test('INPUT-09: blocked attempts show the hint overlay and allowed ones hide it', async () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'static' });
  try {
    const elements: {
      dataset: Record<string, string>;
      style: Record<string, string>;
      textContent: string;
      removed: boolean;
    }[] = [];
    const fakeDoc = {
      createElement: () => {
        const element = {
          dataset: {} as Record<string, string>,
          style: {} as Record<string, string>,
          textContent: '',
          removed: false,
          setAttribute: () => {},
          remove() {
            this.removed = true;
          },
        };
        elements.push(element);
        return element;
      },
    };
    let gate: ((request: GestureRequest) => boolean) | null = null;
    const interaction = {
      setGestureGate: (next: unknown) => {
        gate = next as typeof gate;
      },
    };
    const appended: unknown[] = [];
    const container = {
      style: { touchAction: 'none', position: '' } as Record<string, string>,
      ownerDocument: fakeDoc,
      appendChild: (element: unknown) => appended.push(element),
    };
    const { context, cleanups } = fakeContext(container, interaction);
    gestureGuard({ overlay: { durationMs: 20 } })(context);
    const hint = (): (typeof elements)[number] => elements[0]!;

    // The overlay exists only after a blocked attempt.
    assert.equal(appended.length, 0);
    gate!({ kind: 'wheel', pointerType: 'mouse', pointers: 1, originalEvent: {} as Event });
    assert.equal(appended.length, 1);
    assert.equal(hint().dataset['visible'], 'true');
    assert.equal(hint().style['opacity'], '1');
    assert.match(hint().textContent, /Hold Alt and scroll/);
    assert.equal(container.style['position'], 'relative', 'a static container is positioned');

    // The text follows the reason, and an allowed gesture hides the hint again.
    gate!({ kind: 'pan', pointerType: 'touch', pointers: 1, originalEvent: {} as Event });
    assert.match(hint().textContent, /2 fingers/);
    gate!({
      kind: 'pan',
      pointerType: 'mouse',
      pointers: 1,
      originalEvent: { altKey: true } as unknown as Event,
    });
    assert.equal(hint().dataset['visible'], 'false');

    // The hint expires on its own after the configured duration.
    gate!({ kind: 'wheel', pointerType: 'mouse', pointers: 1, originalEvent: {} as Event });
    assert.equal(hint().dataset['visible'], 'true');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(hint().dataset['visible'], 'false');

    for (const cleanup of cleanups) cleanup();
    assert.equal(hint().removed, true, 'cleanup removes the hint element');
    assert.equal(container.style['position'], '', 'cleanup restores the container position');
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('INPUT-09: invalid guard options fail before installing anything', () => {
  const interaction = { setGestureGate: () => {} };
  const container: FakeContainer = { style: { touchAction: 'none' } };
  const { context } = fakeContext(container, interaction);
  assert.throws(
    () => gestureGuard({ modifier: 'hyper' as never })(context),
    (error: unknown) => String((error as { code?: string }).code) === 'invalid-argument',
  );
  assert.throws(
    () => gestureGuard({ touchPointers: 0 })(context),
    (error: unknown) => String((error as { code?: string }).code) === 'invalid-argument',
  );
  const { context: domFree } = fakeContext(null, interaction);
  assert.throws(
    () => gestureGuard()(domFree),
    (error: unknown) => String((error as { code?: string }).code) === 'unsupported-capability',
  );
});
