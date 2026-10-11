/**
 * GPU picking contract shared by the backends, plus the measured stall
 * accounting (PICK-12).
 *
 * A pick result always carries the logical feature reference and the layer it was
 * picked in; the GPU pick slot is never exposed as a public feature id (PICK-01).
 * The result records the rendered revision it belongs to so callers never mix a
 * stale hit with newer data (PICK-10, PICK-11).
 */

import type { FeatureRef, PickStallStats, ScreenPoint } from '../api/types.ts';

export interface PickResult {
  readonly feature: FeatureRef;
  readonly layerId: string;
  readonly sourceId: string;
  readonly screen: ScreenPoint;
  readonly revision: number;
}

/** Monotonic clock for stall measurement (browsers, workers and Node). */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Accumulates measured pick stalls (PICK-12). One instance per backend: every
 * pick records its blocking span and the blocking readback part, and publishes
 * the snapshot through `scene.setPickStats`. The numbers are measured, never
 * inferred from the Promise signature — a WebGL 1 `readPixels` blocks the
 * caller even though the pick API is async.
 */
export class PickStallRecorder {
  private readonly readback: 'blocking' | 'async';
  private picks = 0;
  private totalMs = 0;
  private lastMs = 0;
  private maxMs = 0;
  private lastReadMs = 0;
  private maxReadMs = 0;

  constructor(readback: 'blocking' | 'async') {
    this.readback = readback;
  }

  record(pickMs: number, readMs: number): void {
    this.picks++;
    this.totalMs += pickMs;
    this.lastMs = pickMs;
    if (pickMs > this.maxMs) this.maxMs = pickMs;
    this.lastReadMs = readMs;
    if (readMs > this.maxReadMs) this.maxReadMs = readMs;
  }

  snapshot(): PickStallStats {
    return {
      picks: this.picks,
      lastMs: this.lastMs,
      maxMs: this.maxMs,
      lastReadMs: this.lastReadMs,
      maxReadMs: this.maxReadMs,
      totalMs: this.totalMs,
      readback: this.readback,
    };
  }
}
