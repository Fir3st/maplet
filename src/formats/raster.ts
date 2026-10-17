/**
 * Raster tile descriptors: XYZ/TMS/retina URL math and WMS request building.
 *
 * These are pure functions: the loader and the renderer share them, and the tests
 * compare URLs and BBOX order against an independent expectation list
 * (RASTER-01..RASTER-06, WMS-01..WMS-06).
 */

import { assertArgument, fail } from '../api/errors.ts';
import type { Bounds, GeoBounds } from '../math/bounds.ts';
import type { GeoPosition } from '../api/types.ts';
import { latToUnitY, lngToUnitX } from '../math/crs.ts';

export type TileScheme = 'xyz' | 'tms';

export interface RasterTilesOptions {
  readonly id: string;
  /** URL template with `{z}` `{x}` `{y}`; supports `{-y}` and `{s}` subdomains. */
  readonly url: string;
  readonly tileSize?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Highest zoom actually available on the server; above it tiles are scaled up. */
  readonly nativeZoom?: number;
  readonly tms?: boolean;
  readonly wrap?: boolean;
  readonly bounds?: Bounds | null;
  readonly opacity?: number;
  readonly attribution?: string;
  readonly retina?: boolean;
  readonly errorTileUrl?: string;
  readonly subdomains?: readonly string[];
}

export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface TileGridOptions {
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly nativeZoom?: number;
  readonly retina: boolean;
  readonly tms: boolean;
  readonly wrap: boolean;
}

export function tileGridOptions(options: RasterTilesOptions): TileGridOptions {
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 24;
  assertArgument(
    Number.isInteger(minZoom) && Number.isInteger(maxZoom) && minZoom <= maxZoom,
    'invalid tile zoom limits',
    { minZoom, maxZoom },
  );
  if (options.nativeZoom !== undefined) {
    assertArgument(
      Number.isInteger(options.nativeZoom) && options.nativeZoom >= minZoom,
      'nativeZoom must be an integer within the tile zoom limits',
      { nativeZoom: options.nativeZoom },
    );
  }
  return {
    tileSize: options.tileSize ?? 256,
    minZoom,
    maxZoom,
    ...(options.nativeZoom === undefined ? {} : { nativeZoom: options.nativeZoom }),
    retina: options.retina ?? false,
    tms: options.tms ?? false,
    wrap: options.wrap ?? false,
  };
}

/** Integer tile zoom for a fractional view zoom; retina requests one level deeper. */
export function tileZoomForView(viewZoom: number, grid: TileGridOptions): number {
  const requested = Math.floor(viewZoom) + (grid.retina ? 1 : 0);
  const ceiling = Math.min(grid.maxZoom, grid.nativeZoom ?? grid.maxZoom);
  return Math.max(grid.minZoom, Math.min(requested, ceiling));
}

/** The flip used by TMS: y_tms = 2^z - 1 - y_xyz. */
export function flipTileY(z: number, y: number): number {
  return 2 ** z - 1 - y;
}

export function formatTileUrl(
  options: Pick<RasterTilesOptions, 'url' | 'subdomains'>,
  coord: TileCoord,
  grid: Pick<TileGridOptions, 'tms'>,
): string {
  const y = grid.tms ? flipTileY(coord.z, coord.y) : coord.y;
  let url = options.url;
  const subdomains = options.subdomains ?? [];
  if (subdomains.length > 0) {
    const index = Math.abs(coord.x + coord.y) % subdomains.length;
    url = url.replaceAll('{s}', subdomains[index]!);
  }
  return url
    .replaceAll('{z}', String(coord.z))
    .replaceAll('{x}', String(coord.x))
    .replaceAll('{y}', String(y))
    .replaceAll('{-y}', String(flipTileY(coord.z, coord.y)));
}

/** Tile coords covering a world-space rectangle at the given integer tile zoom. */
export function tilesForWorldRect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  zoom: number,
  tileSize: number,
  options: { wrap: boolean; minZoom: number; maxZoom: number } = {
    wrap: false,
    minZoom: 0,
    maxZoom: 24,
  },
): TileCoord[] {
  const tiles = 2 ** zoom;
  const worldTiles = (256 * 2 ** zoom) / tileSize;
  const tileWorldSize = 256 / worldTiles; // world units per tile
  const clamp = (value: number): number => Math.max(0, Math.min(tiles - 1, value));
  let x0 = Math.floor(minX / tileWorldSize);
  let x1 = Math.floor((maxX - 1e-9) / tileWorldSize);
  let y0 = Math.floor(minY / tileWorldSize);
  let y1 = Math.floor((maxY - 1e-9) / tileWorldSize);
  if (options.wrap) {
    x1 = Math.max(x1, x0);
  } else {
    x0 = clamp(x0);
    x1 = clamp(x1);
  }
  y0 = clamp(y0);
  y1 = clamp(y1);
  const result: TileCoord[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const wrappedX = options.wrap ? ((x % tiles) + tiles) % tiles : x;
      result.push({ z: zoom, x: wrappedX, y });
    }
  }
  return result;
}

/** Geographic bounds of an XYZ tile; a double oracle for image-placement checks. */
export function tileGeoBounds(coord: TileCoord): GeoBounds {
  const tiles = 2 ** coord.z;
  const lng = (x: number): number => (x / tiles) * 360 - 180;
  const lat = (y: number): number => {
    const n = Math.PI - (2 * Math.PI * y) / tiles;
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
  };
  return {
    southwest: { lat: lat(coord.y + 1), lng: lng(coord.x) },
    northeast: { lat: lat(coord.y), lng: lng(coord.x + 1) },
  };
}

/* -------------------------------------------------------------------------- */
/* WMS                                                                         */
/* -------------------------------------------------------------------------- */

export interface WmsOptions {
  readonly id: string;
  readonly url: string;
  readonly layers: string;
  readonly styles?: string;
  readonly format?: string;
  readonly transparent?: boolean;
  readonly version?: '1.1.1' | '1.3.0';
  /** SRS/CRS identifier used in the request; axis order follows the WMS version. */
  readonly crs?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly opacity?: number;
  readonly attribution?: string;
  /** Pixel size of one GetMap tile; the geographic grid is the 256px XYZ grid. */
  readonly tileSize?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export interface WmsRequest {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * CRS values whose BBOX this library can request correctly (WMS-06): degrees
 * lng/lat for CRS:84 and the version-dependent EPSG:4326 axis order, projected
 * metres for EPSG:3857. A projected national grid has no implementation here,
 * so it is refused instead of being sent with degree coordinates.
 */
export const WMS_REQUEST_CRS = ['CRS:84', 'EPSG:4326', 'EPSG:3857'] as const;

export type WmsRequestCrs = (typeof WMS_REQUEST_CRS)[number];

/** Validates a CRS value (case-insensitive) and returns its canonical spelling. */
export function assertSupportedWmsCrs(crs: string): WmsRequestCrs {
  const canonical = crs.trim().toUpperCase();
  if ((WMS_REQUEST_CRS as readonly string[]).includes(canonical)) return canonical as WmsRequestCrs;
  fail('invalid-argument', `WMS CRS ${crs} is not supported`, {
    crs,
    supported: [...WMS_REQUEST_CRS],
  });
}

/**
 * Tile grid of a WMS source: the standard 256px XYZ grid, because every GetMap
 * request is exactly one tile of it. Tile size, zoom limits and (absence of)
 * TMS/wrap/retina follow the shared grid vocabulary (RASTER-01..06).
 */
export function wmsTileGridOptions(options: WmsOptions): TileGridOptions {
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 24;
  assertArgument(
    Number.isInteger(minZoom) && Number.isInteger(maxZoom) && minZoom <= maxZoom,
    'invalid WMS zoom limits',
    { minZoom, maxZoom },
  );
  return {
    tileSize: options.tileSize ?? 256,
    minZoom,
    maxZoom,
    retina: false,
    tms: false,
    wrap: false,
  };
}

/**
 * One tile of a WMS source: the GetMap request for the tile's geographic extent,
 * so the plan, the cache, ancestor stand-ins and the pick surface all speak the
 * same tile language as XYZ layers.
 */
export function formatWmsTileUrl(options: WmsOptions, coord: TileCoord, tileSize: number): string {
  return wmsGetMapUrl(options, tileGeoBounds(coord), tileSize, tileSize).url;
}

function encodeParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * WMS GetMap URL. BBOX units follow the declared CRS (degrees or projected
 * metres), the axis order follows the version/CRS combination:
 * - 1.3.0 + EPSG:4326 -> BBOX=lat,lng (the classic axis trap);
 * - 1.3.0 + CRS:84    -> BBOX=lng,lat;
 * - EPSG:3857 (both versions) -> projected metres x,y; latitude uses the true
 *   spherical Mercator (a linear degrees->metres factor is ~612 km off at 45°);
 * - 1.1.1 + geographic CRS -> SRS, BBOX=lng,lat.
 * Only the CRS values in `WMS_REQUEST_CRS` are accepted; anything else fails
 * with `invalid-argument` rather than being sent with degree coordinates.
 * WMS-01..WMS-06.
 */
export function wmsGetMapUrl(
  options: WmsOptions,
  bounds: Bounds<GeoPosition>,
  width: number,
  height: number,
): WmsRequest {
  assertArgument(width > 0 && height > 0, 'WMS width/height must be positive', { width, height });
  const version = options.version ?? '1.3.0';
  const canonical = assertSupportedWmsCrs(options.crs ?? 'EPSG:4326');
  const { southwest, northeast } = bounds;
  const minLng = Math.min(southwest.lng, northeast.lng);
  const maxLng = Math.max(southwest.lng, northeast.lng);
  const swLat = Math.min(southwest.lat, northeast.lat);
  const neLat = Math.max(southwest.lat, northeast.lat);
  let bbox: [number, number, number, number];
  if (version === '1.3.0' && canonical === 'EPSG:4326') {
    bbox = [swLat, minLng, neLat, maxLng];
  } else if (canonical === 'EPSG:3857') {
    // Same verified spherical Mercator as the CRS itself (`latToUnitY` clamps
    // to the Mercator limit); metres per world unit = 2 * pi * R.
    const metersPerWorldUnit = 2 * Math.PI * 6378137;
    const x = (lng: number): number => (lngToUnitX(lng) - 0.5) * metersPerWorldUnit;
    const y = (lat: number): number => (0.5 - latToUnitY(lat)) * metersPerWorldUnit;
    const [x1, x2] = [x(minLng), x(maxLng)];
    const [y1, y2] = [y(swLat), y(neLat)];
    bbox = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  } else {
    bbox = [minLng, swLat, maxLng, neLat];
  }
  const params: Record<string, string> = {
    service: 'WMS',
    request: 'GetMap',
    version,
    layers: options.layers,
    styles: options.styles ?? '',
    format: options.format ?? 'image/png',
    transparent: options.transparent === false ? 'false' : 'true',
    width: String(width),
    height: String(height),
    bbox: bbox.join(','),
    ...(options.params ?? {}),
  };
  if (version === '1.3.0') {
    params['crs'] = canonical;
  } else {
    params['srs'] = canonical;
  }
  const base = options.url;
  const separator = base.includes('?') ? '&' : '?';
  return { url: `${base}${separator}${encodeParams(params)}`, width, height };
}

export function assertRasterSourceExists(value: unknown, what: string): void {
  if (!value) fail('not-found', `${what} not found`);
}
