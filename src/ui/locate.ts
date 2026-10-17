/**
 * Geolocation (UI-07): typed one-shot and watch results over the browser
 * geolocation API, with a stable cancel contract — after `cancel()` (or map
 * destroy) no further update is delivered, even if the browser reports later.
 */

export interface GeolocationPositionLike {
  readonly coords: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy: number;
  };
}

export interface GeolocationErrorLike {
  readonly code: number;
  readonly message?: string;
}

export interface GeolocationBrowserOptions {
  readonly enableHighAccuracy?: boolean;
  readonly timeout?: number;
  readonly maximumAge?: number;
}

export interface GeolocationLike {
  getCurrentPosition(
    success: (position: GeolocationPositionLike) => void,
    error: (error: GeolocationErrorLike) => void,
    options?: GeolocationBrowserOptions,
  ): void;
  watchPosition(
    success: (position: GeolocationPositionLike) => void,
    error: (error: GeolocationErrorLike) => void,
    options?: GeolocationBrowserOptions,
  ): number;
  clearWatch(id: number): void;
}

export interface LocateOptions {
  readonly enableHighAccuracy?: boolean;
  readonly timeoutMs?: number;
  readonly maximumAgeMs?: number;
  /**
   * Move the view to the located position (only meaningful for a geographic
   * CRS; a planar projection ignores it rather than misinterpreting lat/lng).
   */
  readonly setView?: boolean | { readonly zoom?: number };
}

export interface LocatedPosition {
  readonly lat: number;
  readonly lng: number;
  readonly accuracy: number;
}

export type LocateErrorCode = 'permission' | 'timeout' | 'unavailable' | 'unsupported';

export type LocateResult =
  | { readonly ok: true; readonly position: LocatedPosition }
  | { readonly ok: false; readonly code: LocateErrorCode; readonly message: string };

export interface LocateWatch {
  readonly active: boolean;
  cancel(): void;
}

export interface LocateWatchOptions extends LocateOptions {
  readonly onUpdate?: (result: LocateResult) => void;
}

export interface Locator {
  locate(options?: LocateOptions): Promise<LocateResult>;
  watch(options: LocateWatchOptions): LocateWatch;
}

/** Maps a browser geolocation error to a typed result. */
export function locateErrorResult(error: GeolocationErrorLike): LocateResult {
  const code: LocateErrorCode =
    error.code === 1 ? 'permission' : error.code === 3 ? 'timeout' : 'unavailable';
  return { ok: false, code, message: error.message ?? `geolocation error ${error.code}` };
}

export function createLocator(getProvider: () => GeolocationLike | null | undefined): Locator {
  const browserOptions = (options?: LocateOptions): GeolocationBrowserOptions => {
    const result: {
      enableHighAccuracy?: boolean;
      timeout?: number;
      maximumAge?: number;
    } = {};
    if (options?.enableHighAccuracy !== undefined)
      result.enableHighAccuracy = options.enableHighAccuracy;
    if (options?.timeoutMs !== undefined) result.timeout = options.timeoutMs;
    if (options?.maximumAgeMs !== undefined) result.maximumAge = options.maximumAgeMs;
    return result;
  };

  const toResult = (position: GeolocationPositionLike): LocateResult => ({
    ok: true,
    position: {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
    },
  });

  const locate = (options?: LocateOptions): Promise<LocateResult> => {
    const provider = getProvider();
    if (!provider) {
      return Promise.resolve({
        ok: false,
        code: 'unsupported',
        message: 'geolocation is not available in this environment',
      });
    }
    return new Promise<LocateResult>((resolve) => {
      let settled = false;
      const finish = (result: LocateResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        provider.getCurrentPosition(
          (position) => finish(toResult(position)),
          (error) => finish(locateErrorResult(error)),
          browserOptions(options),
        );
      } catch (error) {
        finish({ ok: false, code: 'unavailable', message: String(error) });
      }
    });
  };

  const watch = (options: LocateWatchOptions): LocateWatch => {
    const provider = getProvider();
    const onUpdate = options.onUpdate;
    if (!provider) {
      onUpdate?.({
        ok: false,
        code: 'unsupported',
        message: 'geolocation is not available in this environment',
      });
      return { active: false, cancel() {} };
    }
    let active = true;
    let watchId: number | null = null;
    const deliver = (result: LocateResult): void => {
      if (!active) return;
      onUpdate?.(result);
    };
    try {
      watchId = provider.watchPosition(
        (position) => deliver(toResult(position)),
        (error) => deliver(locateErrorResult(error)),
        browserOptions(options),
      );
    } catch (error) {
      active = false;
      onUpdate?.({ ok: false, code: 'unavailable', message: String(error) });
      return { active: false, cancel() {} };
    }
    return {
      get active() {
        return active;
      },
      cancel() {
        if (!active) return;
        active = false;
        if (watchId !== null) {
          try {
            provider.clearWatch(watchId);
          } catch {
            // A failing clearWatch must not resurrect the watch.
          }
        }
      },
    };
  };

  return { locate, watch };
}
