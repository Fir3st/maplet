/**
 * GPU backend factory.
 *
 * Both backends share the frame plan, identity, styles and picking contract; they
 * differ in device creation, resources, pipelines, draw passes and readback
 * (plan: "Backendová hranice zahrnuje skutečné rozdíly").
 */

import { fail, MapletError } from '../api/errors.ts';
import type { BackendKind, ScreenPoint } from '../api/types.ts';
import type { Crs } from '../math/crs.ts';
import type { FrameDriver, Scene } from '../scene/scene.ts';
import type { PickResult } from './picking.ts';
import { WebGl1Backend } from './webgl1/backend.ts';
import { createWebGpuBackend } from './webgpu/backend.ts';

export interface BackendInitOptions {
  readonly container: HTMLElement;
  readonly crs: Crs;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface MapBackend extends FrameDriver {
  readonly kind: 'webgl1' | 'webgpu';
  /** Capability notes gathered at initialization (extensions, precision, limits). */
  readonly notes: readonly string[];
  attach(scene: Scene): void;
  resize(width: number, height: number): void;
  setVisible(visible: boolean): void;
  pick(
    scene: Scene,
    point: ScreenPoint,
    options: { readonly limit: number },
  ): Promise<readonly PickResult[]>;
  /** Diagnostics: renders one frame and reads a single pixel from the back buffer. */
  samplePixel(
    scene: Scene,
    point: ScreenPoint,
  ): Promise<{ r: number; g: number; b: number; a: number }>;
  destroy(): void;
  /**
   * Registers the device/context loss callback. A lost backend stops rendering;
   * the map replaces it (same kind first, then the configured fallback), so this
   * backend never renders again after the callback fires (GPU-07..09).
   */
  onLost(listener: (message: string) => void): void;
  /**
   * Diagnostics: forces a device/context loss so the recovery path can be
   * exercised; the map runs the same recovery as for a real loss.
   */
  simulateLoss(): void;
}

/**
 * Creates a backend. Device acquisition is asynchronous on WebGPU, so callers
 * await this; creation failures surface as `gpu-unavailable` and drive the
 * configured fallback.
 */
export async function createBackend(
  kind: BackendKind,
  options: BackendInitOptions,
): Promise<MapBackend> {
  switch (kind) {
    case 'webgl1':
      return new WebGl1Backend(options);
    case 'webgpu':
      return createWebGpuBackend(options);
    case 'none':
      throw new MapletError(
        'invalid-argument',
        'the "none" backend is not created through the factory',
      );
  }
  fail('gpu-unavailable', `unknown backend: ${String(kind)}`, {});
}
