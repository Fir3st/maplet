/**
 * Scale control math (UI-04).
 *
 * A scale must never present earth meters as units of a planar CRS: geographic
 * projections derive meters per pixel from the earth circumference at the view
 * latitude, while planar ones keep their own world units and are labelled as
 * such. The chosen step is a nice 1/2/5×10ⁿ value that fits the maximum width.
 */

const EARTH_CIRCUMFERENCE_M = 40075016.686;
/** World units per full turn (Web Mercator/equirect world is 256 units wide). */
const WORLD_UNITS = 256;

export interface ScaleStep {
  /** Distance value in display units (meters/kilometers, or planar units). */
  readonly value: number;
  readonly unit: 'm' | 'km' | 'u';
  /** Human-readable label, e.g. `500 km`. */
  readonly label: string;
  /** Width of the scale line in CSS px. */
  readonly widthPx: number;
}

/** Earth meters per CSS pixel at the given zoom and latitude (geographic CRS). */
export function metersPerPixel(zoom: number, latitudeDeg: number): number {
  return (
    ((EARTH_CIRCUMFERENCE_M / WORLD_UNITS) * Math.cos((latitudeDeg * Math.PI) / 180)) / 2 ** zoom
  );
}

/** World units per CSS pixel at the given zoom (planar CRS). */
export function unitsPerPixel(zoom: number): number {
  return 1 / 2 ** zoom;
}

/** Largest 1/2/5×10ⁿ step that is ≤ `raw`. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  for (let exp = Math.floor(Math.log10(raw)); exp >= Math.floor(Math.log10(raw)) - 1; exp--) {
    for (const factor of [5, 2, 1]) {
      const candidate = factor * 10 ** exp;
      if (candidate <= raw) return candidate;
    }
  }
  return 0;
}

/** Scale for a geographic projection: meters below 1 km, kilometers above. */
export function geographicScale(zoom: number, latitudeDeg: number, maxWidthPx = 100): ScaleStep {
  const distancePerPixel = metersPerPixel(zoom, latitudeDeg);
  const step = niceStep(distancePerPixel * maxWidthPx);
  const widthPx = step > 0 ? step / distancePerPixel : maxWidthPx;
  if (step >= 1000) {
    const value = step / 1000;
    return { value, unit: 'km', label: `${formatNumber(value)} km`, widthPx };
  }
  return { value: step, unit: 'm', label: `${formatNumber(step)} m`, widthPx };
}

/** Scale for a planar projection: labelled in CRS units, never earth meters. */
export function planarScale(zoom: number, maxWidthPx = 100): ScaleStep {
  const distancePerPixel = unitsPerPixel(zoom);
  const step = niceStep(distancePerPixel * maxWidthPx);
  const widthPx = step > 0 ? step / distancePerPixel : maxWidthPx;
  return { value: step, unit: 'u', label: `${formatNumber(step)} u`, widthPx };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
