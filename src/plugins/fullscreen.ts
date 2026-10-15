/**
 * Fullscreen mode plugin: an opt-in toggle for the browser's Fullscreen API.
 *
 * The plugin keeps its state in sync with `fullscreenchange` (including exits
 * started by the browser or the user), optionally adds a corner button, and
 * reports failed or unsupported requests instead of pretending the mode
 * changed. The engine resizes the map through its container observer, so no
 * manual resize call is needed. Removing the plugin exits fullscreen.
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
  /** Called on every state change, including browser-initiated exits. */
  readonly onChange?: (active: boolean) => void;
}

export interface FullscreenApi {
  readonly supported: boolean;
  readonly active: boolean;
  /** Resolves true when the target is fullscreen afterwards. */
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
    let active = supported && doc.fullscreenElement === target;
    let button: HTMLButtonElement | null = null;
    let restorePosition: (() => void) | null = null;

    const updateButton = (): void => {
      if (!button) return;
      button.innerHTML = active ? ICON_EXIT : ICON_ENTER;
      button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
      button.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
    };
    const sync = (notify: boolean): boolean => {
      const next = supported && doc.fullscreenElement === target;
      if (next === active) return active;
      active = next;
      updateButton();
      if (notify) options.onChange?.(active);
      return active;
    };
    const onFullscreenChange = (): void => {
      sync(true);
    };
    doc.addEventListener('fullscreenchange', onFullscreenChange);

    const enter = async (): Promise<boolean> => {
      if (!supported) return false;
      if (doc.fullscreenElement === target) return sync(true) || true;
      try {
        await target.requestFullscreen();
      } catch {
        return false;
      }
      return sync(true);
    };
    const exit = async (): Promise<boolean> => {
      if (!supported || doc.fullscreenElement !== target) {
        sync(true);
        return !active;
      }
      try {
        await doc.exitFullscreen();
      } catch {
        return false;
      }
      sync(true);
      return !active;
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
        void (active ? exit() : enter());
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
      button?.remove();
      restorePosition?.();
      if (active) void doc.exitFullscreen();
    });

    return {
      get supported() {
        return supported;
      },
      get active() {
        return active;
      },
      enter,
      exit,
      toggle: () => (active ? exit() : enter()),
      element: () => (active ? target : null),
    };
  };
}
