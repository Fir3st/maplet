/**
 * Heatmap (HEAT-10): an opt-in plugin that renders weighted points as a smooth
 * heat field over the map.
 *
 * The plugin owns one absolutely positioned canvas and draws through the public
 * after-frame hook, so it works with every backend (and with a custom renderer)
 * without sharing GPU state with the renderer. Samples are defined through the
 * API (`setPoints`, `addPoint`, `addPoints`, `clear`) and the appearance through
 * `setOptions`; every change schedules a new frame with `render.invalidate()`.
 * Each frame splats the visible samples into a bounded offscreen field and
 * colorizes it through a 256-entry ramp, so per-frame cost stays bounded even on
 * large maps, and a map with no heatmap adds no DOM, listeners or work.
 */

import { normalizePosition, type PositionInput } from '../api/coordinates.ts';
import { assertArgument, fail } from '../api/errors.ts';
import { isArrayValue, isGeoPosition, isPlanarPosition, type Position } from '../api/types.ts';
import type { Crs } from '../math/crs.ts';
import type { Plugin } from '../plugins.ts';

/** One weighted sample of the heat field. */
export interface HeatPoint {
  /** Position in the map CRS, or a `[lat, lng]` tuple on a geographic map. */
  readonly position: PositionInput;
  /** Relative intensity; default `1`. Non-positive weights are ignored. */
  readonly weight?: number;
}

export interface HeatmapOptions {
  /** Initial samples. */
  readonly points?: readonly HeatPoint[];
  /** Splat radius in CSS pixels; default `25`. */
  readonly radius?: number;
  /** Soft edge width in CSS pixels; default `15`. */
  readonly blur?: number;
  /** Intensity that reaches the top of the ramp; `null` (default) uses the largest weight. */
  readonly max?: number | null;
  /** Smallest splat alpha; default `0.05`. */
  readonly minOpacity?: number;
  /** Largest splat alpha; default `1`. */
  readonly maxOpacity?: number;
  /** Color ramp as `[offset, cssColor]` stops with offsets in `0…1`; `null` restores the default. */
  readonly gradient?: readonly (readonly [number, string])[] | null;
  /** CSS `z-index` of the overlay surface; default `1` (above the map, under controls). */
  readonly zIndex?: number;
}

/** Appearance-only update accepted by `setOptions`; data comes from `setPoints`/`addPoint`. */
export type HeatmapUpdate = Partial<Omit<HeatmapOptions, 'points'>>;

export interface HeatmapApi {
  /** Defined samples, including weights that are ignored and points outside the view. */
  readonly count: number;
  /** Replaces every sample. */
  setPoints(points: readonly HeatPoint[]): void;
  addPoint(position: PositionInput, weight?: number): void;
  addPoints(points: readonly HeatPoint[]): void;
  /** Removes every sample; the field disappears on the next frame. */
  clear(): void;
  setOptions(options: HeatmapUpdate): void;
}

/** The field buffer never exceeds this many pixels, bounding the per-frame colorize pass. */
const MAX_FIELD_PIXELS = 1_000_000;
/** The field buffer never exceeds this many device pixels per CSS pixel. */
const MAX_FIELD_SCALE = 1.5;
/** Very large views still keep a usable field resolution. */
const MIN_FIELD_SCALE = 0.1;
const DEFAULT_RADIUS = 25;
const DEFAULT_BLUR = 15;
const DEFAULT_MIN_OPACITY = 0.05;
const DEFAULT_MAX_OPACITY = 1;
const DEFAULT_Z_INDEX = 1;
/** Default ramp: blue (faint) through cyan and lime to yellow and red (strong). */
const DEFAULT_GRADIENT: readonly (readonly [number, string])[] = [
  [0, '#1d4ed8'],
  [0.35, '#06b6d4'],
  [0.6, '#84cc16'],
  [0.8, '#facc15'],
  [1, '#ef4444'],
];
const LUT_SIZE = 256;
/** Packed-RGBA byte order of the color ramp; both orders occur on real platforms. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function packRgba(red: number, green: number, blue: number, alpha: number): number {
  return LITTLE_ENDIAN
    ? (alpha << 24) | (blue << 16) | (green << 8) | red
    : (red << 24) | (green << 16) | (blue << 8) | alpha;
}

function assertNumber(value: number, message: string): number {
  assertArgument(typeof value === 'number' && Number.isFinite(value), message);
  return value;
}

function normalizeGradient(
  gradient: readonly (readonly [number, string])[] | null | undefined,
): readonly (readonly [number, string])[] {
  if (gradient === undefined || gradient === null) return DEFAULT_GRADIENT;
  assertArgument(
    isArrayValue(gradient) && gradient.length >= 2,
    'heatmap gradient needs at least two [offset, color] stops',
  );
  const stops = gradient.map((stop) => {
    assertArgument(
      isArrayValue(stop) && stop.length === 2,
      'heatmap gradient stops are [offset, color] pairs',
    );
    const offset = assertNumber(stop[0], 'heatmap gradient offsets must be finite numbers');
    assertArgument(
      typeof stop[1] === 'string' && stop[1].length > 0,
      'heatmap gradient colors must be non-empty CSS color strings',
    );
    return [Math.min(1, Math.max(0, offset)), stop[1]] as const;
  });
  return stops.sort((left, right) => left[0] - right[0]);
}

function isHeatPosition(value: unknown): boolean {
  if (Array.isArray(value)) {
    return (
      value.length === 2 &&
      value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    );
  }
  if (isGeoPosition(value)) return Number.isFinite(value.lat) && Number.isFinite(value.lng);
  if (isPlanarPosition(value)) return Number.isFinite(value.x) && Number.isFinite(value.y);
  return false;
}

/** Validates one sample and keeps only the declared fields. */
function normalizePoint(point: HeatPoint): HeatPoint {
  assertArgument(
    typeof point === 'object' && point !== null,
    'heatmap points are { position, weight? } objects',
  );
  assertArgument(
    isHeatPosition(point.position),
    'heatmap positions must be finite { lat, lng }, { x, y } or [lat, lng] values',
  );
  if (point.weight === undefined) return { position: point.position };
  return {
    position: point.position,
    weight: assertNumber(point.weight, 'heatmap weights must be finite numbers'),
  };
}

/** Renders the ramp into a 256-entry packed-RGBA lookup; alpha follows intensity. */
function createPalette(
  document: Document,
  stops: readonly (readonly [number, string])[],
): Uint32Array {
  const canvas = document.createElement('canvas');
  canvas.width = LUT_SIZE;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) fail('unsupported-capability', 'heatmap requires a 2D canvas context', {});
  const gradient = context.createLinearGradient(0, 0, LUT_SIZE - 1, 0);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, LUT_SIZE, 1);
  const pixels = context.getImageData(0, 0, LUT_SIZE, 1).data;
  const palette = new Uint32Array(LUT_SIZE);
  for (let index = 0; index < LUT_SIZE; index += 1) {
    const base = index * 4;
    palette[index] = packRgba(pixels[base]!, pixels[base + 1]!, pixels[base + 2]!, index);
  }
  return palette;
}

/** One alpha-only splat stamp: full intensity in the center, fading out at `radius`. */
function createStamp(document: Document, radius: number, blur: number): HTMLCanvasElement {
  const size = Math.max(1, Math.ceil(radius * 2));
  const stamp = document.createElement('canvas');
  stamp.width = size;
  stamp.height = size;
  const context = stamp.getContext('2d');
  if (!context) fail('unsupported-capability', 'heatmap requires a 2D canvas context', {});
  const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
  const solid = blur <= 0 ? 1 : Math.max(0, (radius - blur) / radius);
  if (solid > 0) gradient.addColorStop(solid, 'rgba(0, 0, 0, 1)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return stamp;
}

export function heatmap(options: HeatmapOptions = {}): Plugin<HeatmapApi> {
  return (context) => {
    const container = context.container;
    if (!container) fail('unsupported-capability', 'heatmap requires a map container', {});
    const document = container.ownerDocument;
    const canvas = document.createElement('canvas');
    const overlay = canvas.getContext('2d', { willReadFrequently: true });
    if (!overlay) fail('unsupported-capability', 'heatmap requires a 2D canvas context', {});
    canvas.dataset.mapletHeatmap = 'true';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;z-index:${DEFAULT_Z_INDEX};`;
    let restorePosition: (() => void) | null = null;
    if (getComputedStyle(container).position === 'static') {
      const previous = container.style.position;
      container.style.position = 'relative';
      restorePosition = () => {
        container.style.position = previous;
      };
    }
    container.appendChild(canvas);
    context.onCleanup(() => {
      canvas.remove();
      restorePosition?.();
    });

    let points: HeatPoint[] = [];
    let radius = DEFAULT_RADIUS;
    let blur = DEFAULT_BLUR;
    let minOpacity = DEFAULT_MIN_OPACITY;
    let maxOpacity = DEFAULT_MAX_OPACITY;
    let peak: number | null = null;
    let gradient = DEFAULT_GRADIENT;
    let stamp: HTMLCanvasElement | null = null;
    let palette: Uint32Array | null = null;
    /** Bumped by every data or appearance change; drives re-preparation. */
    let epoch = 0;
    let prepared: {
      readonly epoch: number;
      readonly samples: readonly { readonly position: Position; readonly alpha: number }[];
    } | null = null;

    const invalidate = (): void => {
      epoch += 1;
      context.render.invalidate();
    };
    const setOptions = (update: HeatmapUpdate): void => {
      // Validate the whole patch before committing anything: a failed update
      // must not leave a partially applied state behind.
      let nextRadius = radius;
      if (update.radius !== undefined) {
        nextRadius = assertNumber(update.radius, 'heatmap radius must be a finite number');
        assertArgument(nextRadius > 0, 'heatmap radius must be greater than zero');
      }
      let nextBlur = blur;
      if (update.blur !== undefined) {
        nextBlur = assertNumber(update.blur, 'heatmap blur must be a finite number');
        assertArgument(nextBlur >= 0, 'heatmap blur cannot be negative');
      }
      let nextPeak = peak;
      if (update.max !== undefined) {
        nextPeak =
          update.max === null
            ? null
            : assertNumber(update.max, 'heatmap max must be a finite number or null');
        assertArgument(nextPeak === null || nextPeak > 0, 'heatmap max must be greater than zero');
      }
      let nextMinOpacity = minOpacity;
      if (update.minOpacity !== undefined) {
        nextMinOpacity = assertNumber(
          update.minOpacity,
          'heatmap minOpacity must be a finite number',
        );
        assertArgument(
          nextMinOpacity >= 0 && nextMinOpacity <= 1,
          'heatmap minOpacity must be between 0 and 1',
        );
      }
      let nextMaxOpacity = maxOpacity;
      if (update.maxOpacity !== undefined) {
        nextMaxOpacity = assertNumber(
          update.maxOpacity,
          'heatmap maxOpacity must be a finite number',
        );
        assertArgument(
          nextMaxOpacity >= 0 && nextMaxOpacity <= 1,
          'heatmap maxOpacity must be between 0 and 1',
        );
      }
      assertArgument(
        nextMinOpacity <= nextMaxOpacity,
        'heatmap minOpacity cannot exceed maxOpacity',
      );
      const nextGradient =
        update.gradient === undefined ? gradient : normalizeGradient(update.gradient);
      let nextZIndex: number | null = null;
      if (update.zIndex !== undefined)
        nextZIndex = assertNumber(update.zIndex, 'heatmap zIndex must be a finite number');

      if (nextRadius !== radius || nextBlur !== blur) stamp = null;
      if (nextGradient !== gradient) palette = null;
      if (nextZIndex !== null) canvas.style.zIndex = String(nextZIndex);
      radius = nextRadius;
      blur = nextBlur;
      peak = nextPeak;
      minOpacity = nextMinOpacity;
      maxOpacity = nextMaxOpacity;
      gradient = nextGradient;
      invalidate();
    };
    const setPoints = (next: readonly HeatPoint[]): void => {
      assertArgument(Array.isArray(next), 'heatmap setPoints expects an array of points');
      points = next.map(normalizePoint);
      invalidate();
    };
    const addPoints = (next: readonly HeatPoint[]): void => {
      assertArgument(Array.isArray(next), 'heatmap addPoints expects an array of points');
      if (!next.length) return;
      // Validate everything first so a rejected sample appends nothing.
      const validated = next.map(normalizePoint);
      for (const point of validated) points.push(point);
      invalidate();
    };
    /** Normalizes positions and weights once per change, not once per frame. */
    const prepare = (
      crs: Crs,
    ): readonly { readonly position: Position; readonly alpha: number }[] => {
      if (prepared && prepared.epoch === epoch) return prepared.samples;
      const weighted: { position: Position; weight: number }[] = [];
      let largest = 0;
      for (const point of points) {
        const weight = point.weight ?? 1;
        if (!(weight > 0)) continue;
        weighted.push({ position: normalizePosition(point.position, crs), weight });
        if (weight > largest) largest = weight;
      }
      const scale = peak ?? (largest > 0 ? largest : 1);
      const samples = weighted.map((sample) => ({
        position: sample.position,
        alpha: Math.min(maxOpacity, Math.max(minOpacity, sample.weight / scale)),
      }));
      prepared = { epoch, samples };
      return samples;
    };

    context.render.onFrame((frame) => {
      const { plan } = frame;
      const width = plan.view.width;
      const height = plan.view.height;
      if (!(width > 0) || !(height > 0) || !(plan.deviceWidth > 0) || !(plan.deviceHeight > 0))
        return;
      const scale = Math.max(
        MIN_FIELD_SCALE,
        Math.min(plan.dpr, MAX_FIELD_SCALE, Math.sqrt(MAX_FIELD_PIXELS / (width * height))),
      );
      const fieldWidth = Math.max(1, Math.round(width * scale));
      const fieldHeight = Math.max(1, Math.round(height * scale));
      if (canvas.width !== fieldWidth || canvas.height !== fieldHeight) {
        canvas.width = fieldWidth;
        canvas.height = fieldHeight;
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      overlay.setTransform(scale, 0, 0, scale, 0, 0);
      overlay.clearRect(0, 0, width, height);
      const samples = prepare(plan.view.crs);
      if (samples.length) {
        stamp ??= createStamp(document, radius, blur);
        overlay.globalCompositeOperation = 'lighter';
        for (const sample of samples) {
          const screen = frame.positionToScreen(sample.position);
          if (
            screen.x < -radius ||
            screen.y < -radius ||
            screen.x > width + radius ||
            screen.y > height + radius
          ) {
            continue;
          }
          overlay.globalAlpha = sample.alpha;
          overlay.drawImage(stamp, screen.x - radius, screen.y - radius, radius * 2, radius * 2);
        }
        overlay.globalAlpha = 1;
        overlay.globalCompositeOperation = 'source-over';
      }
      overlay.setTransform(1, 0, 0, 1, 0, 0);
      if (!samples.length) return;
      palette ??= createPalette(document, gradient);
      const image = overlay.getImageData(0, 0, fieldWidth, fieldHeight);
      const bytes = image.data;
      const pixels = new Uint32Array(bytes.buffer);
      for (let index = 0; index < pixels.length; index += 1) {
        pixels[index] = palette[bytes[index * 4 + 3]!]!;
      }
      overlay.putImageData(image, 0, 0);
    });

    setOptions(options);
    if (options.points) setPoints(options.points);

    return {
      get count() {
        return points.length;
      },
      setPoints,
      addPoint(position, weight) {
        points.push(normalizePoint(weight === undefined ? { position } : { position, weight }));
        invalidate();
      },
      addPoints,
      clear() {
        if (!points.length) return;
        points = [];
        invalidate();
      },
      setOptions,
    };
  };
}
