/**
 * Gesture guard (INPUT-09): an opt-in plugin that keeps accidental gestures from
 * moving the map — the usual scrolling hazard of a map embedded in a page.
 *
 * Touch gestures apply only while at least `touchPointers` fingers are down
 * (default two) and mouse/pen gestures only while the configured modifier key is
 * held (default Alt). The container keeps `touch-action: pan-y` while the guard
 * is installed, so a one-finger vertical drag scrolls the page instead of
 * panning. A blocked attempt shows a short hint overlay (the
 * leaflet-gesture-handling pattern) that explains what to do; applications can
 * allow everything programmatically with `unlock()`/`lock()`.
 */

import { fail } from '../api/errors.ts';
import type { GestureRequest } from '../interaction/interaction.ts';
import type { Plugin } from '../plugins.ts';

/** Modifier key that unlocks mouse/pen gestures; `'none'` never requires one. */
export type GestureModifier = 'alt' | 'control' | 'shift' | 'meta' | 'none';

export interface GestureGuardOverlayOptions {
  /** How long a hint stays visible after the last blocked attempt; default 2200 ms. */
  readonly durationMs?: number;
  /** Custom hint text; defaults describe the finger count or the modifier. */
  readonly message?: (request: GestureRequest) => string;
}

export interface GestureGuardOptions {
  /** Modifier for mouse/pen gestures; default `'alt'`. */
  readonly modifier?: GestureModifier;
  /** Touch pointers required before touch gestures apply; default 2. */
  readonly touchPointers?: number;
  /** Container `touch-action` while the guard is installed; default `'pan-y'`. */
  readonly touchAction?: string;
  /** Start with every gesture allowed; `lock()` still applies; default false. */
  readonly unlocked?: boolean;
  /** Explain blocked attempts with a hint overlay; on by default. */
  readonly overlay?: boolean | GestureGuardOverlayOptions;
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
const MODIFIER_LABEL: Record<Exclude<GestureModifier, 'none'>, string> = {
  alt: 'Alt',
  control: 'Ctrl',
  shift: 'Shift',
  meta: 'Meta',
};
const HINT_STYLE =
  'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:25;pointer-events:none;' +
  'background:rgba(17,24,39,.92);color:#f9fafb;border-radius:8px;padding:10px 14px;text-align:center;' +
  'font:13px/1.45 system-ui,sans-serif;max-width:80%;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
  'transition:opacity .15s ease;opacity:0;';

/** True when the event carries the modifier that unlocks a pointer gesture. */
export function modifierHeld(modifier: GestureModifier, event: Event): boolean {
  if (modifier === 'none') return true;
  return (event as unknown as Record<string, unknown>)[MODIFIER_KEY[modifier]] === true;
}

/** Pure gate decision; exported for tests and custom gates. */
export function gestureAllowed(
  request: GestureRequest,
  state: {
    readonly unlocked: boolean;
    readonly modifier: GestureModifier;
    readonly touchPointers: number;
  },
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

/** Default hint text for a blocked gesture; exported for tests. */
export function defaultGestureHint(
  request: GestureRequest,
  state: { readonly modifier: GestureModifier; readonly touchPointers: number },
): string {
  if (request.pointerType === 'touch') {
    return request.kind === 'featureDrag'
      ? `Use ${state.touchPointers} fingers to move the pin`
      : `Use ${state.touchPointers} fingers to move the map`;
  }
  if (state.modifier === 'none') return 'Gestures are currently locked';
  const modifier = MODIFIER_LABEL[state.modifier];
  switch (request.kind) {
    case 'wheel':
      return `Hold ${modifier} and scroll to zoom the map`;
    case 'doubleClick':
      return `Hold ${modifier} and double-click to zoom`;
    case 'featureDrag':
      return `Hold ${modifier} and drag to move the feature`;
    default:
      return `Hold ${modifier} and drag to move the map`;
  }
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
    if (!interaction)
      fail('unsupported-capability', 'gestureGuard requires interactive gestures', {});
    const doc = container.ownerDocument;
    let modifier = normalizeModifier(options.modifier ?? 'alt');
    const touchPointers = options.touchPointers ?? 2;
    if (!Number.isInteger(touchPointers) || touchPointers < 1) {
      fail('invalid-argument', 'gestureGuard touchPointers must be an integer >= 1', {
        touchPointers,
      });
    }
    const overlayOptions =
      options.overlay === true || options.overlay === undefined
        ? {}
        : options.overlay === false
          ? null
          : options.overlay;
    let unlocked = options.unlocked ?? false;
    const previousTouchAction = container.style.touchAction;
    container.style.touchAction = options.touchAction ?? 'pan-y';
    let restorePosition: (() => void) | null = null;
    let hint: HTMLElement | null = null;
    let hintTimer: ReturnType<typeof setTimeout> | null = null;

    const hideHint = (): void => {
      if (hintTimer !== null) {
        clearTimeout(hintTimer);
        hintTimer = null;
      }
      if (!hint || hint.dataset.visible !== 'true') return;
      hint.dataset.visible = 'false';
      hint.style.opacity = '0';
    };
    const showHint = (request: GestureRequest): void => {
      if (!overlayOptions) return;
      if (!hint) {
        // The overlay exists only after a blocked attempt (like controls).
        if (getComputedStyle(container).position === 'static') {
          const previous = container.style.position;
          container.style.position = 'relative';
          restorePosition = () => {
            container.style.position = previous;
          };
        }
        hint = doc.createElement('div');
        hint.dataset.mapletGestureHint = 'true';
        hint.setAttribute('role', 'status');
        hint.style.cssText = HINT_STYLE;
        container.appendChild(hint);
      }
      const text =
        overlayOptions.message?.(request) ??
        defaultGestureHint(request, { modifier, touchPointers });
      if (hint.textContent !== text) hint.textContent = text;
      hint.dataset.visible = 'true';
      hint.style.opacity = '1';
      if (hintTimer !== null) clearTimeout(hintTimer);
      hintTimer = setTimeout(hideHint, overlayOptions.durationMs ?? 2200);
    };

    interaction.setGestureGate((request) => {
      const allowed = gestureAllowed(request, { unlocked, modifier, touchPointers });
      if (allowed) hideHint();
      else showHint(request);
      return allowed;
    });
    context.onCleanup(() => {
      interaction.setGestureGate(null);
      container.style.touchAction = previousTouchAction;
      hideHint();
      hint?.remove();
      hint = null;
      restorePosition?.();
      restorePosition = null;
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
        hideHint();
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
