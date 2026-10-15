/**
 * Gesture guard (INPUT-09): an opt-in plugin that keeps accidental gestures from
 * moving the map — the usual scrolling hazard of a map embedded in a page.
 *
 * Touch gestures apply only while at least `touchPointers` fingers are down
 * (default two) and mouse/pen gestures only while the configured modifier key is
 * held (default Alt). The container keeps `touch-action: pan-y` while the guard
 * is installed, so a one-finger vertical drag scrolls the page instead of
 * panning. Applications can allow everything programmatically with
 * `unlock()`/`lock()` (for example from their own button or shortcut).
 */

import { fail } from '../api/errors.ts';
import type { GestureRequest } from '../interaction/interaction.ts';
import type { Plugin } from '../plugins.ts';

/** Modifier key that unlocks mouse/pen gestures; `'none'` never requires one. */
export type GestureModifier = 'alt' | 'control' | 'shift' | 'meta' | 'none';

export interface GestureGuardOptions {
  /** Modifier for mouse/pen gestures; default `'alt'`. */
  readonly modifier?: GestureModifier;
  /** Touch pointers required before touch gestures apply; default 2. */
  readonly touchPointers?: number;
  /** Container `touch-action` while the guard is installed; default `'pan-y'`. */
  readonly touchAction?: string;
  /** Start with every gesture allowed; `lock()` still applies; default false. */
  readonly unlocked?: boolean;
  /** Called whenever `unlock()`/`lock()` change the state. */
  readonly onChange?: (state: { readonly unlocked: boolean }) => void;
}

export interface GestureGuardApi {
  readonly unlocked: boolean;
  readonly modifier: GestureModifier;
  readonly touchPointers: number;
  setModifier(modifier: GestureModifier): void;
  /** Allow every gesture, ignoring the modifier and pointer count. */
  unlock(): void;
  lock(): void;
}

const MODIFIERS: readonly GestureModifier[] = ['alt', 'control', 'shift', 'meta', 'none'];
const MODIFIER_KEY = {
  alt: 'altKey',
  control: 'ctrlKey',
  shift: 'shiftKey',
  meta: 'metaKey',
} as const;

/** True when the event carries the modifier that unlocks a pointer gesture. */
export function modifierHeld(modifier: GestureModifier, event: Event): boolean {
  if (modifier === 'none') return true;
  return (event as unknown as Record<string, unknown>)[MODIFIER_KEY[modifier]] === true;
}

/** Pure gate decision; exported for tests and custom gates. */
export function gestureAllowed(
  request: GestureRequest,
  state: { readonly unlocked: boolean; readonly modifier: GestureModifier; readonly touchPointers: number },
): boolean {
  if (state.unlocked) return true;
  // Continuous gestures follow the finger rule on touch surfaces; discrete
  // events (wheel, double-click) always follow the modifier, so a double-tap
  // cannot zoom unless the guard is unlocked or the modifier is 'none'.
  if (request.kind === 'pan' || request.kind === 'pinch' || request.kind === 'featureDrag') {
    if (request.pointerType === 'touch') return request.pointers >= state.touchPointers;
  }
  return modifierHeld(state.modifier, request.originalEvent);
}

function normalizeModifier(modifier: GestureModifier): GestureModifier {
  if (!MODIFIERS.includes(modifier)) {
    fail('invalid-argument', 'gestureGuard modifier must be alt, control, shift, meta or none', {
      modifier: String(modifier),
    });
  }
  return modifier;
}

export function gestureGuard(options: GestureGuardOptions = {}): Plugin<GestureGuardApi> {
  return (context) => {
    const container = context.container;
    const interaction = context.map.interaction;
    if (!container) fail('unsupported-capability', 'gestureGuard requires a map container', {});
    if (!interaction) fail('unsupported-capability', 'gestureGuard requires interactive gestures', {});
    let modifier = normalizeModifier(options.modifier ?? 'alt');
    const touchPointers = options.touchPointers ?? 2;
    if (!Number.isInteger(touchPointers) || touchPointers < 1) {
      fail('invalid-argument', 'gestureGuard touchPointers must be an integer >= 1', { touchPointers });
    }
    let unlocked = options.unlocked ?? false;
    const previousTouchAction = container.style.touchAction;
    container.style.touchAction = options.touchAction ?? 'pan-y';
    interaction.setGestureGate((request) => gestureAllowed(request, { unlocked, modifier, touchPointers }));
    context.onCleanup(() => {
      interaction.setGestureGate(null);
      container.style.touchAction = previousTouchAction;
    });
    return {
      get unlocked() {
        return unlocked;
      },
      get modifier() {
        return modifier;
      },
      get touchPointers() {
        return touchPointers;
      },
      setModifier(next) {
        modifier = normalizeModifier(next);
      },
      unlock() {
        if (unlocked) return;
        unlocked = true;
        options.onChange?.({ unlocked });
      },
      lock() {
        if (!unlocked) return;
        unlocked = false;
        options.onChange?.({ unlocked });
      },
    };
  };
}
