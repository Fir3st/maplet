/**
 * Distances, scales and circle measures with explicit units.
 *
 * "Earth metres" and screen pixels are different units and never mixed silently:
 * `Distance` carries its unit, `scaleBar` uses the CRS's own unit, and metric
 * circles declare their unit in the geometry. MATH-09, MATH-10, UI-04.
 */

import type { Position } from '../api/types.ts';
import { EARTH_RADIUS_METERS, WORLD_SCALE, type Crs, type Distance, type DistanceUnit } from './crs.ts';
import { worldScaleAt } from './transform.ts';

export function distanceBetween(crs: Crs, a: Position, b: Position): Distance {
  return crs.distance(a, b);
}

/**
 * Local metres per CSS pixel at a position and fractional zoom.
 * Geographic CRS: the local metric scale of the sphere along longitude.
 * Simple: planar units per pixel, reported as `planarUnits`.
 */
export function metersPerPixel(crs: Crs, position: Position, zoom: number): Distance {
  const pixelScale = WORLD_SCALE * worldScaleAt(zoom);
  if (crs.positionKind === 'planar') {
    return { value: WORLD_SCALE / pixelScale, unit: 'planarUnits' };
  }
  const geo = position as { lat: number };
  const metersPerDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;
  const cosLat = Math.max(Math.cos((geo.lat * Math.PI) / 180), 1e-6);
  // One pixel spans 360 / pixelScale degrees of longitude.
  const degreesPerPixel = 360 / pixelScale;
  return { value: degreesPerPixel * metersPerDegree * cosLat, unit: 'meters' };
}

export interface ScaleBar {
  /** Rounded distance shown by the control. */
  readonly value: number;
  readonly unit: DistanceUnit;
  /** Width of the bar in CSS pixels. */
  readonly pixels: number;
  readonly label: string;
}

const NICE_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1000, 2000, 5000, 10000, 20000, 50000, 100000,
  200000, 500000, 1000000, 2000000, 5000000,
];

/**
 * Picks a round distance that fits `maxPixels` at the current scale. The unit
 * follows the CRS; Simple reports its planar units, not earth metres. UI-04.
 */
export function scaleBar(
  crs: Crs,
  center: Position,
  zoom: number,
  maxPixels = 120,
): ScaleBar {
  const perPixel = metersPerPixel(crs, center, zoom);
  const targetValue = perPixel.value * maxPixels;
  let value = NICE_STEPS[NICE_STEPS.length - 1]!;
  for (const step of NICE_STEPS) {
    if (step <= targetValue) value = step;
  }
  const pixels = value / perPixel.value;
  const label =
    perPixel.unit === 'meters'
      ? value >= 1000
        ? `${value / 1000} km`
        : `${value} m`
      : `${value} u`;
  return { value, unit: perPixel.unit, pixels, label };
}
