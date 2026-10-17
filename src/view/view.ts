/**
 * Camera / view state.
 *
 * The view owns zoom, center and container size, and has its own revision.
 * Published view changes also advance the scene revision so `whenRendered`
 * can refer to a frame that contains the new camera. VIEW-01..VIEW-10.
 *
 * Animation is driven by an injectable clock; tests use a manual clock.
 */

import { assertArgument } from '../api/errors.ts';
import type { Bounds } from '../math/bounds.ts';
import { isGeoBounds } from '../math/bounds.ts';
import type { GeoBounds } from '../math/bounds.ts';
import type { Crs } from '../math/crs.ts';
import type { Position, ScreenPoint, WorldPoint, Commit } from '../api/types.ts';
import {
  positionToScreen,
  screenToPosition,
  transformOrigin,
  worldScaleAt,
  type ViewTransform,
} from '../math/transform.ts';

export interface Clock {
  now(): number;
  /** Schedules `callback` after `delayMs`; returns a cancel function. */
  schedule(callback: () => void, delayMs: number): () => void;
}

export function defaultClock(): Clock {
  const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number })
    .requestAnimationFrame;
  return {
    now(): number {
      const perf = (globalThis as { performance?: { now(): number } }).performance;
      return perf ? perf.now() : Date.now();
    },
    schedule(callback, delayMs) {
      if (raf && delayMs < 40) {
        const id = raf(() => callback());
        return () => {
          const cancel = (globalThis as { cancelAnimationFrame?: (id: number) => void })
            .cancelAnimationFrame;
          cancel?.(id);
        };
      }
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

export interface ViewSnapshot {
  readonly center: Position;
  readonly zoom: number;
  readonly revision: number;
  readonly size: { readonly width: number; readonly height: number };
  readonly bounds: Bounds<Position> | null;
}

export interface ViewOptions {
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly maxBounds?: Bounds<Position> | null;
  readonly width: number;
  readonly height: number;
}

export interface FitPadding {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

export interface FitOptions {
  readonly padding?: number | FitPadding;
  readonly maxZoom?: number;
  readonly animate?: boolean;
  readonly duration?: number;
}

export interface FlyOptions {
  readonly duration?: number;
  readonly ease?: (t: number) => number;
}

export interface ViewHost {
  /** Publishes a view change: bump scene revision, emit events, request a frame. */
  publishViewChange(kind: 'start' | 'change' | 'end'): void;
  readonly sceneRevision: number;
}

export interface ViewUpdate {
  readonly center?: Position;
  readonly zoom?: number;
}

export class ViewImpl {
  private centerWorld: WorldPoint;
  private zoomValue: number;
  private widthValue: number;
  private heightValue: number;
  private revisionValue = 0;
  private minZoom: number;
  private maxZoom: number;
  private maxBounds: Bounds<Position> | null;
  private readonly clock: Clock;
  private readonly crs: Crs;
  private readonly host: ViewHost;
  private animation: { cancel(): void; resolve(): void } | null = null;

  constructor(
    crs: Crs,
    host: ViewHost,
    options: ViewOptions,
    center: Position,
    zoom: number,
    clock: Clock,
  ) {
    this.crs = crs;
    this.host = host;
    this.clock = clock;
    this.widthValue = options.width;
    this.heightValue = options.height;
    this.minZoom = options.minZoom ?? 0;
    this.maxZoom = options.maxZoom ?? 24;
    this.maxBounds = options.maxBounds ?? null;
    assertArgument(
      Number.isFinite(zoom) && zoom >= this.minZoom && zoom <= this.maxZoom,
      `view zoom must be a finite number within [${this.minZoom}, ${this.maxZoom}]`,
      { zoom },
    );
    this.centerWorld = this.crs.toWorld(this.crs.normalize(center));
    this.zoomValue = zoom;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get zoom(): number {
    return this.zoomValue;
  }

  get size(): { readonly width: number; readonly height: number } {
    return { width: this.widthValue, height: this.heightValue };
  }

  setLimits(minZoom: number, maxZoom: number, maxBounds: Bounds<Position> | null): void {
    assertArgument(
      Number.isFinite(minZoom) && Number.isFinite(maxZoom) && minZoom <= maxZoom,
      'invalid zoom limits',
      { minZoom, maxZoom },
    );
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.maxBounds = maxBounds;
    this.zoomValue = clamp(this.zoomValue, minZoom, maxZoom);
  }

  transform(): ViewTransform {
    return {
      crs: this.crs,
      width: this.widthValue,
      height: this.heightValue,
      centerWorld: this.centerWorld,
      zoom: this.zoomValue,
    };
  }

  private clamped(center: WorldPoint, zoom: number): { center: WorldPoint; zoom: number } {
    const nextZoom = clamp(zoom, this.minZoom, this.maxZoom);
    let nextCenter = center;
    if (this.maxBounds) {
      const boundsWorld = this.boundsToWorldRect(this.maxBounds);
      const viewHalfWidth = this.widthValue / (2 * worldScaleAt(nextZoom));
      const viewHalfHeight = this.heightValue / (2 * worldScaleAt(nextZoom));
      const boundsWidth = boundsWorld.maxX - boundsWorld.minX;
      const boundsHeight = boundsWorld.maxY - boundsWorld.minY;
      if (boundsWidth <= viewHalfWidth * 2) {
        nextCenter = { ...nextCenter, x: (boundsWorld.minX + boundsWorld.maxX) / 2 };
      } else {
        nextCenter = {
          ...nextCenter,
          x: clamp(
            nextCenter.x,
            boundsWorld.minX + viewHalfWidth,
            boundsWorld.maxX - viewHalfWidth,
          ),
        };
      }
      if (boundsHeight <= viewHalfHeight * 2) {
        nextCenter = { ...nextCenter, y: (boundsWorld.minY + boundsWorld.maxY) / 2 };
      } else {
        nextCenter = {
          ...nextCenter,
          y: clamp(
            nextCenter.y,
            boundsWorld.minY + viewHalfHeight,
            boundsWorld.maxY - viewHalfHeight,
          ),
        };
      }
    }
    return { center: nextCenter, zoom: nextZoom };
  }

  private boundsToWorldRect(bounds: Bounds<Position>): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } {
    const sw = this.crs.toWorld(bounds.southwest);
    const ne = this.crs.toWorld(bounds.northeast);
    if (isGeoBounds(bounds) && bounds.crossesAntimeridian) {
      // The covered interval runs through the antimeridian; use the long way
      // for the clamp rectangle so both sides stay allowed.
      return {
        minX: Math.min(sw.x, ne.x - 256),
        minY: Math.min(sw.y, ne.y),
        maxX: Math.max(sw.x, ne.x),
        maxY: Math.max(sw.y, ne.y),
      };
    }
    return {
      minX: Math.min(sw.x, ne.x),
      minY: Math.min(sw.y, ne.y),
      maxX: Math.max(sw.x, ne.x),
      maxY: Math.max(sw.y, ne.y),
    };
  }

  getSnapshot(): ViewSnapshot {
    return Object.freeze({
      center: Object.freeze(this.crs.fromWorld(this.centerWorld)) as Position,
      zoom: this.zoomValue,
      revision: this.revisionValue,
      size: Object.freeze({ width: this.widthValue, height: this.heightValue }),
      bounds: this.getBounds(),
    });
  }

  /** Configured zoom limits, used by the zoom control's disabled states (UI-01). */
  get zoomLimits(): { readonly minZoom: number; readonly maxZoom: number } {
    return Object.freeze({ minZoom: this.minZoom, maxZoom: this.maxZoom });
  }

  /** Applies a view update. Returns the commit revision of the published frame state. */
  set(update: ViewUpdate): Commit {
    const requestedZoom = update.zoom ?? this.zoomValue;
    assertArgument(Number.isFinite(requestedZoom), 'view zoom must be a finite number', {
      zoom: update.zoom,
    });
    let requestedCenter = this.centerWorld;
    if (update.center !== undefined) {
      requestedCenter = this.crs.toWorld(this.crs.normalize(update.center));
    }
    const next = this.clamped(requestedCenter, requestedZoom);
    const changed =
      next.zoom !== this.zoomValue ||
      next.center.x !== this.centerWorld.x ||
      next.center.y !== this.centerWorld.y;
    this.stopAnimation(true);
    if (changed) {
      this.centerWorld = next.center;
      this.zoomValue = next.zoom;
      this.revisionValue++;
      this.host.publishViewChange('change');
    }
    return { revision: this.host.sceneRevision };
  }

  /** Zooms around a fixed container point. VIEW-05. */
  zoomAround(screen: ScreenPoint, deltaZoom: number): Commit {
    const before = this.screenToPosition(screen);
    const nextZoom = clamp(this.zoomValue + deltaZoom, this.minZoom, this.maxZoom);
    if (nextZoom === this.zoomValue) {
      return { revision: this.host.sceneRevision };
    }
    const beforeWorld = this.crs.toWorld(before);
    // Keep `before` under the same screen point at the new zoom.
    const scale = worldScaleAt(nextZoom);
    const newCenterWorld = {
      x: beforeWorld.x - (screen.x - this.widthValue / 2) / scale,
      y: beforeWorld.y - (screen.y - this.heightValue / 2) / scale,
    };
    const next = this.clamped(newCenterWorld, nextZoom);
    this.stopAnimation(true);
    this.centerWorld = next.center;
    this.zoomValue = next.zoom;
    this.revisionValue++;
    this.host.publishViewChange('change');
    return { revision: this.host.sceneRevision };
  }

  fit(bounds: Bounds<Position> | null, options: FitOptions = {}): Commit {
    if (!bounds) return { revision: this.host.sceneRevision };
    const padding = normalizePadding(options.padding);
    const availableWidth = Math.max(this.widthValue - padding.left - padding.right, 1);
    const availableHeight = Math.max(this.heightValue - padding.top - padding.bottom, 1);
    const rect = this.boundsToWorldRect(bounds);
    const widthWorld = rect.maxX - rect.minX;
    const heightWorld = rect.maxY - rect.minY;
    const maxZoom = options.maxZoom ?? this.maxZoom;
    let zoom: number;
    if (widthWorld <= 0 || heightWorld <= 0) {
      zoom = Math.min(maxZoom, this.maxZoom);
    } else {
      const scale = Math.min(availableWidth / widthWorld, availableHeight / heightWorld);
      zoom = Math.log2(scale);
      zoom = Math.min(zoom, maxZoom, this.maxZoom);
      zoom = Math.max(zoom, this.minZoom);
    }
    // Center of the padded area, expressed in world coordinates.
    const centerXWorld = (rect.minX + rect.maxX) / 2;
    const centerYWorld = (rect.minY + rect.maxY) / 2;
    const scale = worldScaleAt(zoom);
    const paddedCenterX = (padding.left + (this.widthValue - padding.right)) / 2;
    const paddedCenterY = (padding.top + (this.heightValue - padding.bottom)) / 2;
    const centerWorld = {
      x: centerXWorld - (paddedCenterX - this.widthValue / 2) / scale,
      y: centerYWorld - (paddedCenterY - this.heightValue / 2) / scale,
    };
    const next = this.clamped(centerWorld, zoom);
    this.stopAnimation(true);
    this.centerWorld = next.center;
    this.zoomValue = next.zoom;
    this.revisionValue++;
    this.host.publishViewChange('change');
    return { revision: this.host.sceneRevision };
  }

  /**
   * Animates to a target view; continuous interpolation with an exact end.
   * VIEW-06, VIEW-07. Returns a promise resolved when the animation ends or is
   * stopped; `stop()` ends at the current interpolated view.
   */
  flyTo(target: ViewUpdate, options: FlyOptions = {}): Promise<void> {
    const duration = Math.max(0, options.duration ?? 500);
    const ease = options.ease ?? easeInOutQuad;
    const targetZoom = clamp(target.zoom ?? this.zoomValue, this.minZoom, this.maxZoom);
    const targetCenter = target.center
      ? this.crs.toWorld(this.crs.normalize(target.center))
      : this.centerWorld;
    this.stopAnimation(true);
    if (duration === 0) {
      const next = this.clamped(targetCenter, targetZoom);
      this.centerWorld = next.center;
      this.zoomValue = next.zoom;
      this.revisionValue++;
      this.host.publishViewChange('end');
      return Promise.resolve();
    }
    const startCenter = this.centerWorld;
    const startZoom = this.zoomValue;
    const startTime = this.clock.now();
    this.host.publishViewChange('start');
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.animation = null;
        resolve();
      };
      const tick = (): void => {
        if (done) return;
        const t = duration <= 0 ? 1 : Math.min(1, (this.clock.now() - startTime) / duration);
        const k = ease(t);
        const center = {
          x: startCenter.x + (targetCenter.x - startCenter.x) * k,
          y: startCenter.y + (targetCenter.y - startCenter.y) * k,
        };
        const zoom = startZoom + (targetZoom - startZoom) * k;
        const next = this.clamped(center, zoom);
        this.centerWorld = next.center;
        this.zoomValue = next.zoom;
        this.revisionValue++;
        if (t >= 1) {
          this.centerWorld = this.clamped(targetCenter, targetZoom).center;
          this.zoomValue = clamp(targetZoom, this.minZoom, this.maxZoom);
          this.host.publishViewChange('end');
          finish();
          return;
        }
        this.host.publishViewChange('change');
        schedule();
      };
      let cancelScheduled: (() => void) | null = null;
      const schedule = (): void => {
        cancelScheduled = this.clock.schedule(tick, 16);
      };
      this.animation = {
        cancel: () => {
          cancelScheduled?.();
        },
        resolve: finish,
      };
      schedule();
    });
  }

  /** Ends a running animation at the current interpolated view. */
  stop(): void {
    this.stopAnimation(true);
  }

  private stopAnimation(publishEnd: boolean): void {
    const animation = this.animation;
    if (!animation) return;
    this.animation = null;
    animation.cancel();
    if (publishEnd) {
      this.host.publishViewChange('end');
    }
    animation.resolve();
  }

  resize(width: number, height: number): void {
    if (width < 0 || height < 0 || !Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width === this.widthValue && height === this.heightValue) return;
    this.widthValue = width;
    this.heightValue = height;
    this.host.publishViewChange('change');
  }

  positionToScreen(position: Position): ScreenPoint {
    return positionToScreen(this.transform(), position);
  }

  screenToPosition(screen: ScreenPoint): Position {
    return screenToPosition(this.transform(), screen);
  }

  getBounds(): Bounds<Position> | null {
    if (this.widthValue === 0 || this.heightValue === 0) return null;
    const origin = transformOrigin(this.transform());
    return worldRectToBounds(this.crs, origin, this.widthValue, this.heightValue, this.zoomValue);
  }
}

export function worldRectToBounds(
  crs: Crs,
  origin: WorldPoint,
  width: number,
  height: number,
  zoom: number,
): Bounds<Position> {
  const scale = worldScaleAt(zoom);
  const widthWorld = width / scale;
  const heightWorld = height / scale;
  const southWest = crs.fromWorld({ x: origin.x, y: origin.y + heightWorld });
  const northEast = crs.fromWorld({ x: origin.x + widthWorld, y: origin.y });
  if (crs.positionKind !== 'geographic') {
    return { southwest: southWest, northeast: northEast };
  }
  const sw = southWest as { lat: number; lng: number };
  const ne = northEast as { lat: number; lng: number };
  if (widthWorld >= 256) {
    return {
      southwest: { lat: sw.lat, lng: -180 },
      northeast: { lat: ne.lat, lng: 180 },
    };
  }
  const west = wrap180(sw.lng);
  const east = wrap180(ne.lng);
  const bounds: GeoBounds = {
    southwest: { lat: sw.lat, lng: west },
    northeast: { lat: ne.lat, lng: east },
  };
  return east < west ? { ...bounds, crossesAntimeridian: true } : bounds;
}

function wrap180(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function normalizePadding(padding: number | FitPadding | undefined): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === 'number') {
    assertArgument(Number.isFinite(padding) && padding >= 0, 'padding must be >= 0', { padding });
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  const top = padding.top ?? 0;
  const right = padding.right ?? 0;
  const bottom = padding.bottom ?? 0;
  const left = padding.left ?? 0;
  for (const value of [top, right, bottom, left]) {
    assertArgument(Number.isFinite(value) && value >= 0, 'padding must be >= 0', { padding });
  }
  return { top, right, bottom, left };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
