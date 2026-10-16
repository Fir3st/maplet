/**
 * Keyboard focus on pins (MARKER-15): a virtual cursor over the drawn pins.
 *
 * Pins are GPU sprites, so they cannot take DOM focus themselves. The marker
 * controller installs one visually hidden focus stop inside the container
 * ("Map pins") plus a ring overlay, and these helpers keep the parts that do
 * not need a DOM — the stop label, the announcement text, cyclic stepping and
 * the ring box — pure and testable in node.
 */

import type { ScreenPoint } from '../api/types.ts';

/** Where the cursor can move: one step, or the ends of the cycle. */
export type FocusStep = 'next' | 'previous' | 'first' | 'last';

export interface PinFocusBox {
  readonly left: number;
  readonly top: number;
  readonly size: number;
  /** False once the sprite centre leaves the container (the ring parks). */
  readonly visible: boolean;
}

export function pinsStopLabel(count: number): string {
  return `Map pins (${count}). Arrow keys move between pins, Enter activates.`;
}

export function focusAnnouncement(name: string, index: number, count: number): string {
  return `${name}, ${index + 1} of ${count}`;
}

/**
 * Next cursor index; wraps in both directions, falls back to an end when the
 * current index is unknown (the focused pin left the map), and -1 for none.
 */
export function stepFocusIndex(current: number, count: number, step: FocusStep): number {
  if (count <= 0) return -1;
  if (step === 'first') return 0;
  if (step === 'last') return count - 1;
  if (current < 0 || current >= count) return step === 'next' ? 0 : count - 1;
  return (current + (step === 'next' ? 1 : -1) + count) % count;
}

/** A sprite centre is reachable while it lies inside the container. */
export function pinFocusVisible(centre: ScreenPoint, viewport: { readonly width: number; readonly height: number }): boolean {
  return centre.x >= 0 && centre.y >= 0 && centre.x <= viewport.width && centre.y <= viewport.height;
}

/** Ring box wrapping one sprite; the box hugs the sprite, the ring shadows outside it. */
export function pinFocusBox(
  centre: ScreenPoint,
  size: number,
  viewport: { readonly width: number; readonly height: number },
): PinFocusBox {
  return {
    left: centre.x - size / 2,
    top: centre.y - size / 2,
    size,
    visible: pinFocusVisible(centre, viewport),
  };
}
