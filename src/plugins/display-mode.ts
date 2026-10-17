/**
 * Fullscreen mode plugin: an opt-in toggle for the browser's Fullscreen API.
 *
 * The module file is `display-mode.ts`, not `fullscreen.ts`: script URLs ending
 * in `fullscreen.js` are blocked by some content filters and security suites
 * (fullscreen-overlay adware uses that name), which took every example page down
 * for those browsers. The exported plugin and its API keep their names.
 *
 * The plugin keeps its state in sync with `fullscreenchange` (including exits
 * started by the browser, Escape or the user), optionally adds a corner button,
 * and reports failed or unsupported requests instead of pretending the mode
 * changed. `api.mode` distinguishes the real Fullscreen API (`'native'`) from
 * the viewport fallback (`'fallback'`), which covers the window with CSS when
 * the API is missing or denied. The engine resizes the map through its container
 * observer, so no manual resize call is needed. Removing the plugin exits.
 */

import { fail } from '../api/errors.ts';
import type { Plugin } from '../plugins.ts';
import type { ControlPosition } from '../ui/controls.ts';

export interface FullscreenControlOptions {
  /** Corner of the optional button; default `'top-right'`. */
  readonly position?: ControlPosition;
  /** Accessible label and tooltip; default from the state. */
  readonly label?: string;
}

export interface FullscreenOptions {
  /** Element to make fullscreen; defaults to the map container. */
  readonly target?: HTMLElement;
  /** Add a corner button; `true` uses the default corner. */
  readonly control?: boolean | FullscreenControlOptions;
  /** Cover the viewport with CSS when the API is missing or denied; default true. */
  readonly fallback?: boolean;
  /** Called on every state change, including browser-initiated exits. */
  readonly onChange?: (active: boolean) => void;
}

/** `'native'` uses the Fullscreen API, `'fallback'` covers the viewport with CSS. */
export type FullscreenMode = 'native' | 'fallback' | null;

export interface FullscreenApi {
  readonly supported: boolean;
  readonly active: boolean;
  readonly mode: FullscreenMode;
  /** Resolves true when the target is fullscreen (either mode) afterwards. */
  enter(): Promise<boolean>;
  /** Resolves true when the target is not fullscreen afterwards. */
  exit(): Promise<boolean>;
  toggle(): Promise<boolean>;
  /** The fullscreen element while active, otherwise null. */
  element(): HTMLElement | null;
}

const CORNER_OFFSET: Record<ControlPosition, string> = {
  'top-left': 'top:10px;left:10px;',
  'top-right': 'top:10px;right:10px;',
  'bottom-left': 'bottom:10px;left:10px;',
  'bottom-right': 'bottom:10px;right:10px;',
};
const BLOCKED_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel', 'contextmenu'];
const FALLBACK_STYLE = {
  position: 'fixed',
  inset: '0',
  zIndex: '2147483647',
  overflow: 'hidden',
  background: '#ffffff',
} as const;
// Trusted constants: never built from user input.
const ICON_ENTER =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>';
const ICON_EXIT =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4"/></svg>';

export function fullscreenMode(options: FullscreenOptions = {}): Plugin<FullscreenApi> {
  return (context) => {
    const container = context.container;
    if (!container) fail('unsupported-capability', 'fullscreenMode requires a map container', {});
    const target = options.target ?? container;
    const doc = target.ownerDocument;
    const supported =
      typeof target.requestFullscreen === 'function' && typeof doc.exitFullscreen === 'function';
    const fallbackAllowed = options.fallback !== false;
    let mode: FullscreenMode = doc.fullscreenElement === target ? 'native' : null;
    let fallback = false;
    let previousStyles: Record<string, string> | null = null;
    let button: HTMLButtonElement | null = null;
    let restorePosition: (() => void) | null = null;

    const updateButton = (): void => {
      if (!button) return;
      button.innerHTML = mode === null ? ICON_ENTER : ICON_EXIT;
      button.setAttribute('aria-label', mode === null ? 'Enter fullscreen' : 'Exit fullscreen');
      button.title =
        mode === 'fallback'
          ? 'Exit fullscreen (viewport fallback)'
          : mode === 'native'
            ? 'Exit fullscreen'
            : 'Enter fullscreen';
    };
    const currentMode = (): FullscreenMode =>
      doc.fullscreenElement === target ? 'native' : fallback ? 'fallback' : null;
    const sync = (notify: boolean): FullscreenMode => {
      const next = currentMode();
      if (next === mode) return mode;
      mode = next;
      updateButton();
      if (notify) options.onChange?.(mode !== null);
      return mode;
    };
    const onFullscreenChange = (): void => {
      sync(true);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && fallback) void exit();
    };
    doc.addEventListener('fullscreenchange', onFullscreenChange);

    const enterFallback = (): void => {
      if (fallback) return;
      previousStyles = {
        position: target.style.position,
        inset: target.style.inset,
        zIndex: target.style.zIndex,
        overflow: target.style.overflow,
        background: target.style.background,
      };
      target.dataset.mapletFullscreenFallback = 'true';
      target.style.position = FALLBACK_STYLE.position;
      target.style.inset = FALLBACK_STYLE.inset;
      target.style.zIndex = FALLBACK_STYLE.zIndex;
      target.style.overflow = FALLBACK_STYLE.overflow;
      target.style.background = FALLBACK_STYLE.background;
      fallback = true;
      doc.addEventListener('keydown', onKeyDown);
    };
    const exitFallback = (): void => {
      if (!fallback) return;
      fallback = false;
      doc.removeEventListener('keydown', onKeyDown);
      if (previousStyles) {
        target.style.position = previousStyles['position']!;
        target.style.inset = previousStyles['inset']!;
        target.style.zIndex = previousStyles['zIndex']!;
        target.style.overflow = previousStyles['overflow']!;
        target.style.background = previousStyles['background']!;
        previousStyles = null;
      }
      delete target.dataset.mapletFullscreenFallback;
    };

    const enter = async (): Promise<boolean> => {
      if (mode !== null) return true;
      if (supported) {
        try {
          await target.requestFullscreen();
        } catch {
          /* denied or unavailable: fall through to the fallback */
        }
        if (sync(true) === 'native') return true;
      }
      if (!fallbackAllowed) return false;
      enterFallback();
      sync(true);
      return true;
    };
    const exit = async (): Promise<boolean> => {
      if (mode === 'native') {
        try {
          await doc.exitFullscreen();
        } catch {
          return false;
        }
        sync(true);
      }
      if (fallback) {
        exitFallback();
        sync(true);
      }
      return mode === null;
    };

    if (options.control) {
      const control = options.control === true ? {} : options.control;
      const position = control.position ?? 'top-right';
      if (getComputedStyle(container).position === 'static') {
        const previous = container.style.position;
        container.style.position = 'relative';
        restorePosition = () => {
          container.style.position = previous;
        };
      }
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.mapletControl = 'fullscreen';
      button.style.cssText =
        'position:absolute;z-index:10;display:flex;align-items:center;justify-content:center;' +
        'width:34px;height:34px;border:0;border-radius:6px;background:#ffffff;color:#111827;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer;padding:0;pointer-events:auto;' +
        CORNER_OFFSET[position];
      for (const type of BLOCKED_EVENTS) {
        button.addEventListener(type, (event) => event.stopPropagation());
      }
      button.addEventListener('click', () => {
        void (mode === null ? enter() : exit());
      });
      if (control.label) {
        button.setAttribute('aria-label', control.label);
        button.title = control.label;
      }
      container.appendChild(button);
      updateButton();
    }

    context.onCleanup(() => {
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      exitFallback();
      button?.remove();
      restorePosition?.();
      if (mode === 'native') void doc.exitFullscreen();
    });

    return {
      get supported() {
        return supported;
      },
      get active() {
        return mode !== null;
      },
      get mode() {
        return mode;
      },
      enter,
      exit,
      toggle: () => (mode === null ? enter() : exit()),
      element: () => (mode === null ? null : target),
    };
  };
}
