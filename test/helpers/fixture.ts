/**
 * Shared test helpers: manual clock, map fixture, geometry expectations.
 */

import { createMap, type MapHandle, type MapOptions } from '../../src/index.ts';
import type { Clock } from '../../src/index.ts';

export interface ManualClock extends Clock {
  advance(ms: number): void;
  pending(): number;
}

/** Deterministic clock for flyTo and scheduler tests. */
export function manualClock(): ManualClock {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback, delayMs) {
      const id = nextId++;
      tasks.set(id, { at: now + delayMs, callback });
      return () => {
        tasks.delete(id);
      };
    },
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        let next: { id: number; at: number; callback: () => void } | null = null;
        for (const [id, task] of tasks) {
          if (task.at <= target && (!next || task.at < next.at || (task.at === next.at && id < next.id))) {
            next = { id, at: task.at, callback: task.callback };
          }
        }
        if (!next || guard++ > 10000) break;
        tasks.delete(next.id);
        now = next.at;
        next.callback();
      }
      now = target;
    },
    pending() {
      return tasks.size;
    },
  };
}

export interface MapFixture {
  readonly map: MapHandle;
  readonly clock: ManualClock;
}

export async function makeMap(options: MapOptions = {}): Promise<MapFixture> {
  const clock = manualClock();
  const map = await createMap({
    renderer: { primary: 'none' },
    size: { width: 800, height: 600 },
    view: { center: { lat: 50, lng: 14 }, zoom: 8 },
    clock,
    ...options,
  });
  return { map, clock };
}

/** Waits until the next microtask queue drain (headless "frame"). */
export async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}
