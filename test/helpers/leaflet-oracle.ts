/**
 * Independent Leaflet 1.9.4 oracle for preserved computations (MATH-14).
 *
 * The vendored Leaflet ESM build is lazily imported after a minimal DOM shim, so
 * the oracle is the real library, not a re-implementation of the same formulas.
 * Tests use it only for contracts Maplet explicitly keeps; documented differences
 * (own CRS unit spaces, own distance radius) are asserted as explicit deltas.
 */

interface LeafletLatLng {
  lat: number;
  lng: number;
}

interface LeafletPoint {
  x: number;
  y: number;
}

export interface LeafletOracle {
  readonly version: string;
  latLng(lat: number, lng: number): LeafletLatLng;
  /** Projected absolute pixels at the given zoom (scale 256 x 2^zoom). */
  mercatorProject(lat: number, lng: number, zoom: number): LeafletPoint;
  mercatorUnproject(x: number, y: number, zoom: number): LeafletLatLng;
  distanceMeters(a: LeafletLatLng, b: LeafletLatLng): number;
  wrapLng(lng: number): number;
  boundsOf(points: LeafletLatLng[]): { sw: LeafletLatLng; ne: LeafletLatLng };
}

let oraclePromise: Promise<LeafletOracle> | null = null;

function shimDom(): void {
  const global = globalThis as Record<string, unknown>;
  if (global.window === undefined) {
    global.window = globalThis;
    global.devicePixelRatio = 1;
    global.screen = { width: 0, height: 0 };
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'maplet-test', platform: 'maplet-test', maxTouchPoints: 0 },
      configurable: true,
      writable: true,
    });
    global.document = {
      documentElement: { style: {} },
      createElement: () => ({
        style: {},
        getContext: () => null,
        setAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        classList: { add() {}, remove() {} },
      }),
      addEventListener() {},
      removeEventListener() {},
    };
  }
}

export function leafletOracle(): Promise<LeafletOracle> {
  if (!oraclePromise) {
    shimDom();
    // Non-literal specifier: the vendored Leaflet build has no type declarations,
    // so the module is loaded opaquely and described by `LeafletOracle` above.
    const specifier = '../../demo/vendor/leaflet.esm.js';
    oraclePromise = import(specifier).then((L: unknown) => {
      const anyL = L as {
        version: string;
        latLng(lat: number, lng: number): LeafletLatLng;
        CRS: {
          EPSG3857: {
            latLngToPoint(latlng: LeafletLatLng, zoom: number): LeafletPoint;
            pointToLatLng(point: LeafletPoint, zoom: number): LeafletLatLng;
            wrapLatLng(latlng: LeafletLatLng): LeafletLatLng;
          };
          Earth: { distance(a: LeafletLatLng, b: LeafletLatLng): number };
        };
        latLngBounds(points: LeafletLatLng[]): {
          getSouthWest(): LeafletLatLng;
          getNorthEast(): LeafletLatLng;
        };
      };
      return {
        version: anyL.version,
        latLng: (lat, lng) => anyL.latLng(lat, lng),
        mercatorProject: (lat, lng, zoom) =>
          anyL.CRS.EPSG3857.latLngToPoint(anyL.latLng(lat, lng), zoom),
        mercatorUnproject: (x, y, zoom) => anyL.CRS.EPSG3857.pointToLatLng({ x, y }, zoom),
        distanceMeters: (a, b) => anyL.CRS.Earth.distance(a, b),
        wrapLng: (lng) => anyL.CRS.EPSG3857.wrapLatLng(anyL.latLng(0, lng)).lng,
        boundsOf: (points) => {
          const bounds = anyL.latLngBounds(points);
          return { sw: bounds.getSouthWest(), ne: bounds.getNorthEast() };
        },
      };
    });
  }
  return oraclePromise;
}
