/**
 * Media sources: a decoded bitmap (image) or a live video frame stream placed
 * into explicit bounds (MEDIA-01..06).
 *
 * The source owns its decoded content and its placement; a `raster` layer draws
 * it. Descriptor changes (URL, bounds) bump `revision` and publish a scene
 * state change, so the plan and every dependent layer see the new placement.
 * Pixel changes (decoded bitmap, `updateRegion`, a new video frame) bump
 * `pixelVersion` and only request a repaint: the placement does not change and
 * the backends re-upload just the changed regions (MEDIA-03).
 *
 * A failed load never masquerades as an empty success: the state is `error`
 * with a message, and the previously decoded pixels stay visible (no flash)
 * until a new URL decodes or the source is removed (MEDIA-08 in spirit).
 */

import { fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import {
  isGeoPosition,
  isPlanarPosition,
  type Position,
  type SubscribeOptions,
  type Unsubscribe,
} from '../api/types.ts';

export type MediaSourceKind = 'image' | 'video';
export type MediaState = 'loading' | 'ready' | 'error';
/** Uploadable media element: an image, a writable canvas or a video frame source. */
export type MediaElement = HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;

export interface MediaBounds {
  readonly southwest: Position;
  readonly northeast: Position;
}

export interface MediaRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MediaPixelData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

export interface ImageSourceOptions {
  readonly id: string;
  /** Exactly one of `url`/`pixels` is required. */
  readonly url?: string;
  readonly pixels?: MediaPixelData;
  readonly bounds: MediaBounds;
  /** Placement rotation in degrees clockwise about the bounds centre; default 0. */
  readonly rotate?: number;
}

export interface VideoSourceOptions {
  readonly id: string;
  readonly url: string;
  readonly bounds: MediaBounds;
  /** Play the stream in a loop; default false. */
  readonly loop?: boolean;
  /** Placement rotation in degrees clockwise about the bounds centre; default 0. */
  readonly rotate?: number;
}

export interface MediaSourceSnapshot {
  readonly sourceId: string;
  readonly kind: MediaSourceKind;
  /** Descriptor revision (URL/bounds/rotation); changes rebuild the frame plan. */
  readonly revision: number;
  /** Pixel revision (decoded bitmap, region update, video frame). */
  readonly pixelVersion: number;
  readonly state: MediaState;
  readonly error: string | null;
  /** Set when `play()` was rejected (autoplay policy); never a silent stall. */
  readonly playError: string | null;
  /** Intrinsic content size in pixels (0 until ready). */
  readonly width: number;
  readonly height: number;
  readonly bounds: MediaBounds;
  /** Placement rotation in degrees clockwise about the bounds centre. */
  readonly rotate: number;
}

/** Sorts bounds into south-west/north-east and rejects non-positions. */
export function normalizeMediaBounds(bounds: MediaBounds): MediaBounds {
  const { southwest, northeast } = bounds ?? ({} as MediaBounds);
  const geo = isGeoPosition(southwest) && isGeoPosition(northeast);
  const planar = isPlanarPosition(southwest) && isPlanarPosition(northeast);
  if (!geo && !planar) {
    fail('invalid-argument', 'media bounds require two positions of the same kind', {});
  }
  if (geo) {
    const a = southwest as { lat: number; lng: number };
    const b = northeast as { lat: number; lng: number };
    if (
      !Number.isFinite(a.lat) ||
      !Number.isFinite(a.lng) ||
      !Number.isFinite(b.lat) ||
      !Number.isFinite(b.lng)
    ) {
      fail('invalid-argument', 'media bounds contain a non-finite coordinate', {});
    }
    return {
      southwest: { lat: Math.min(a.lat, b.lat), lng: Math.min(a.lng, b.lng) },
      northeast: { lat: Math.max(a.lat, b.lat), lng: Math.max(a.lng, b.lng) },
    };
  }
  const a = southwest as { x: number; y: number };
  const b = northeast as { x: number; y: number };
  if (
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y)
  ) {
    fail('invalid-argument', 'media bounds contain a non-finite coordinate', {});
  }
  return {
    southwest: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    northeast: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

/**
 * Validates a media placement rotation: degrees clockwise about the bounds
 * centre, the same convention as sprite and label rotation. Zero (the default)
 * keeps the placement axis-aligned.
 */
export function normalizeMediaRotation(rotate: number | undefined): number {
  if (rotate === undefined) return 0;
  if (typeof rotate !== 'number' || !Number.isFinite(rotate)) {
    fail('invalid-argument', 'media rotation must be a finite number of degrees', {});
  }
  return rotate;
}

/**
 * Validates an `updateRegion` before anything is mutated (MEDIA-04):
 * the region must lie inside the bitmap, the stride must cover a row and the
 * buffer must be long enough for every row. Returns the effective stride.
 */
export function validateMediaRegion(
  region: MediaRegion,
  buffer: { readonly stride?: number | undefined; readonly length: number },
  size: { readonly width: number; readonly height: number },
): { readonly stride: number } {
  const integer = (value: number): boolean => Number.isInteger(value);
  if (
    !integer(region.x) ||
    !integer(region.y) ||
    !integer(region.width) ||
    !integer(region.height) ||
    region.width < 1 ||
    region.height < 1
  ) {
    fail('invalid-region', 'updateRegion requires integer x/y/width/height >= 1', {
      region: { ...region },
    });
  }
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > size.width ||
    region.y + region.height > size.height
  ) {
    fail('invalid-region', 'updateRegion region lies outside the bitmap', {
      region: { ...region },
      size: { width: size.width, height: size.height },
    });
  }
  const stride = buffer.stride ?? region.width * 4;
  if (!integer(stride) || stride < region.width * 4) {
    fail('invalid-region', 'updateRegion requires a stride of at least width * 4 pixels', {
      stride,
      minimum: region.width * 4,
    });
  }
  const required = (region.height - 1) * stride + region.width * 4;
  if (buffer.length < required) {
    fail('invalid-region', 'updateRegion pixel buffer is too short for the region and stride', {
      length: buffer.length,
      required,
    });
  }
  return { stride };
}

/** Premultiplied RGBA rows of a region, for partial GPU uploads. */
export function premultiplyRegion(
  pixels: Uint8ClampedArray | Uint8Array,
  stride: number,
  region: MediaRegion,
): Uint8Array {
  const out = new Uint8Array(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    let source = row * stride;
    let target = row * region.width * 4;
    for (let column = 0; column < region.width; column++) {
      const alpha = pixels[source + 3]!;
      out[target] = Math.round((pixels[source]! * alpha) / 255);
      out[target + 1] = Math.round((pixels[source + 1]! * alpha) / 255);
      out[target + 2] = Math.round((pixels[source + 2]! * alpha) / 255);
      out[target + 3] = alpha;
      source += 4;
      target += 4;
    }
  }
  return out;
}

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

export class MediaSourceImpl {
  readonly id: string;
  readonly kind: MediaSourceKind;
  url: string | null;
  bounds: MediaBounds;
  /** Placement rotation in degrees clockwise about the bounds centre. */
  rotate = 0;
  revision = 0;
  pixelVersion = 0;
  state: MediaState = 'loading';
  error: string | null = null;
  playError: string | null = null;
  /** GPU upload source: `<img>`/`<canvas>` for images, `<video>` for video. */
  element: MediaElement | null = null;
  width = 0;
  height = 0;
  readonly emitter = new Emitter<{ change: MediaSourceSnapshot; frame: MediaSourceSnapshot }>();

  private image: HTMLImageElement | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private playing = false;
  /** Invalidates queued frame callbacks when the pump stops or restarts (MEDIA-05/09). */
  private pumpEpoch = 0;
  /** Video load generation: a stale play() or load event never wins (MEDIA-09). */
  private loadSeq = 0;
  /** Detaches the current video load's listeners; one load owns the element at a time. */
  private videoCleanup: (() => void) | null = null;
  private frameToken: number | null = null;
  private rafToken: number | null = null;
  private dirty: MediaRegion[] = [];
  private destroyed = false;

  constructor(options: ImageSourceOptions | VideoSourceOptions, kind: MediaSourceKind) {
    this.id = options.id;
    this.kind = kind;
    this.bounds = normalizeMediaBounds(options.bounds);
    this.rotate = normalizeMediaRotation(options.rotate);
    const url = (options as { url?: string }).url ?? null;
    this.url = url;
    if (typeof document === 'undefined') {
      this.state = 'error';
      this.error = 'media decoding is not available in this environment';
      return;
    }
    if (kind === 'video') {
      if (!url) fail('invalid-argument', 'video sources require a url', { sourceId: this.id });
      this.video = document.createElement('video');
      const video = this.video;
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.loop = (options as VideoSourceOptions).loop ?? false;
      video.addEventListener('ended', () => {
        if (this.destroyed || !this.playing || this.state !== 'ready') return;
        this.stopPump();
        this.playing = false;
        // No lost final update: the last decoded frame is re-uploaded once.
        this.pixelVersion++;
        this.emitter.emit('frame', this.snapshot());
      });
      this.beginVideoLoad(url);
      return;
    }
    const pixels = (options as ImageSourceOptions).pixels;
    if (pixels && url)
      fail('invalid-argument', 'image sources take either url or pixels', { sourceId: this.id });
    if (pixels) {
      if (
        !Number.isInteger(pixels.width) ||
        !Number.isInteger(pixels.height) ||
        pixels.width < 1 ||
        pixels.height < 1 ||
        pixels.width * pixels.height * 4 > MAX_MEDIA_BYTES
      ) {
        fail('invalid-argument', 'image pixels require positive integer width/height', {
          sourceId: this.id,
        });
      }
      if (pixels.data.length !== pixels.width * pixels.height * 4) {
        fail('invalid-argument', 'image pixels data must hold width * height * 4 RGBA bytes', {
          sourceId: this.id,
          length: pixels.data.length,
        });
      }
      this.canvas = document.createElement('canvas');
      this.canvas.width = pixels.width;
      this.canvas.height = pixels.height;
      this.context = this.canvas.getContext('2d');
      if (!this.context) {
        this.failState('2D context for image pixels is not available');
        return;
      }
      this.context.putImageData(
        new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height),
        0,
        0,
      );
      this.element = this.canvas;
      this.width = pixels.width;
      this.height = pixels.height;
      this.state = 'ready';
      return;
    }
    if (!url)
      fail('invalid-argument', 'image sources require a url or pixels', { sourceId: this.id });
    this.loadImage(url);
  }

  hasPixels(): boolean {
    return this.element !== null && this.width > 0 && this.height > 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Descriptor update: URL (images and video), bounds and rotation. Pixel updates use `updateRegion`. */
  update(patch: {
    readonly url?: string;
    readonly bounds?: MediaBounds;
    readonly rotate?: number;
  }): void {
    if (this.destroyed)
      fail('destroyed', 'the media source has been destroyed', { sourceId: this.id });
    if (patch.bounds) {
      this.bounds = normalizeMediaBounds(patch.bounds);
      this.revision++;
    }
    if (patch.rotate !== undefined) {
      this.rotate = normalizeMediaRotation(patch.rotate);
      this.revision++;
    }
    if (patch.url !== undefined) {
      if (typeof patch.url !== 'string' || patch.url.length === 0) {
        fail('invalid-argument', 'media url must be a non-empty string', { sourceId: this.id });
      }
      this.url = patch.url;
      this.revision++;
      if (this.kind === 'video') this.beginVideoLoad(patch.url);
      else this.loadImage(patch.url);
    }
    this.emitter.emit('change', this.snapshot());
  }

  /**
   * Starts a video load (construction or a URL update, MEDIA-09). Load
   * listeners belong to exactly one load: starting the next load removes them
   * first, so an aborted load can never report an error for its successor.
   * The requested playback state survives: a video that was playing resumes
   * when the new source is ready, while a `pause()` during the load keeps it
   * paused. Until then the previous pixels stay uploaded: no `pixelVersion`
   * changes, so the backends keep the last decoded frame on screen.
   */
  private beginVideoLoad(url: string): void {
    const video = this.video;
    if (!video) return; // no DOM: the constructor already reported the environment error
    this.loadSeq++;
    this.videoCleanup?.();
    this.videoCleanup = null;
    this.stopPump();
    video.pause();
    this.url = url;
    this.state = 'loading';
    this.error = null;
    const onLoaded = (): void => {
      cleanup();
      if (this.destroyed) return;
      this.width = video.videoWidth;
      this.height = video.videoHeight;
      if (this.width === 0 || this.height === 0) {
        this.playing = false;
        this.failState('decoded video has no intrinsic size');
        return;
      }
      this.element = video;
      this.state = 'ready';
      this.error = null;
      this.pixelVersion++;
      this.emitter.emit('change', this.snapshot());
      if (this.playing) this.play();
    };
    const onError = (): void => {
      cleanup();
      if (this.destroyed) return;
      this.playing = false;
      this.stopPump();
      this.failState(`failed to load video ${url}`);
    };
    const cleanup = (): void => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      if (this.videoCleanup === cleanup) this.videoCleanup = null;
    };
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('error', onError);
    this.videoCleanup = cleanup;
    video.src = url;
  }

  private loadImage(url: string): void {
    this.state = 'loading';
    this.error = null;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (this.destroyed || this.image !== image) return; // stale load (MEDIA-06)
      if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        this.failState('decoded image has no intrinsic size');
        return;
      }
      this.width = image.naturalWidth;
      this.height = image.naturalHeight;
      if (this.context && this.canvas) {
        // Region updates exist: keep the writable canvas as the upload source.
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.context.drawImage(image, 0, 0);
        this.element = this.canvas;
      } else {
        this.element = image;
      }
      this.state = 'ready';
      this.error = null;
      this.pixelVersion++;
      this.emitter.emit('change', this.snapshot());
    };
    image.onerror = () => {
      if (this.destroyed || this.image !== image) return;
      this.failState(`failed to load image ${url}`);
    };
    this.image = image;
    image.src = url;
  }

  /**
   * Replaces a rectangle of the bitmap (MEDIA-03). Validation runs before any
   * mutation (MEDIA-04); the changed rectangles are handed to the active
   * backend so the upload stays partial.
   */
  updateRegion(
    region: MediaRegion,
    pixels: Uint8Array | Uint8ClampedArray,
    options?: { readonly stride?: number },
  ): void {
    if (this.destroyed)
      fail('destroyed', 'the media source has been destroyed', { sourceId: this.id });
    if (this.kind !== 'image') {
      fail('invalid-state', `media source ${this.id} is not an image source`, {
        sourceId: this.id,
      });
    }
    if (this.state !== 'ready' || !this.element) {
      fail('invalid-state', `media source ${this.id} is not ready for region updates`, {
        sourceId: this.id,
        state: this.state,
      });
    }
    const { stride } = validateMediaRegion(
      region,
      { stride: options?.stride, length: pixels.length },
      {
        width: this.width,
        height: this.height,
      },
    );
    if (!this.context || !this.canvas) {
      if (!(typeof document !== 'undefined' && this.element instanceof HTMLImageElement)) {
        fail('invalid-state', `media source ${this.id} has no writable pixel store`, {
          sourceId: this.id,
        });
      }
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.context = this.canvas.getContext('2d');
      if (!this.context) {
        fail('invalid-state', `media source ${this.id} cannot create a writable pixel store`, {
          sourceId: this.id,
        });
      }
      this.context.drawImage(this.element, 0, 0);
      this.element = this.canvas;
    }
    const contiguous =
      region.width * 4 === stride && pixels.length === region.width * region.height * 4;
    const source = contiguous ? pixels : gatherRows(pixels, stride, region);
    this.context.putImageData(
      new ImageData(new Uint8ClampedArray(source), region.width, region.height),
      region.x,
      region.y,
    );
    this.dirty.push({ ...region });
    this.pixelVersion++;
    this.emitter.emit('frame', this.snapshot());
  }

  /** Rectangles changed since the last backend upload; the caller owns them. */
  takeDirtyRegions(): MediaRegion[] {
    if (this.dirty.length === 0) return [];
    const regions = this.dirty;
    this.dirty = [];
    return regions;
  }

  /** Premultiplied RGBA rows of a region for partial texture uploads. */
  regionPixels(region: MediaRegion): Uint8Array | null {
    if (!this.context) return null;
    const data = this.context.getImageData(region.x, region.y, region.width, region.height).data;
    return premultiplyRegion(data, region.width * 4, region);
  }

  play(): void {
    if (this.destroyed)
      fail('destroyed', 'the media source has been destroyed', { sourceId: this.id });
    const video = this.video;
    if (!video) {
      fail('invalid-state', `media source ${this.id} is not a video source`, { sourceId: this.id });
    }
    this.playing = true;
    const seq = this.loadSeq;
    const promise = video.play() as Promise<void> | undefined;
    if (promise && typeof promise.then === 'function') {
      void promise
        .then(() => {
          // A superseded load interrupted this request; its own ready handler resumes.
          if (this.destroyed || seq !== this.loadSeq) return;
          this.playError = null;
          this.startPump();
        })
        .catch((error: unknown) => {
          if (this.destroyed || seq !== this.loadSeq) return;
          this.playing = false;
          this.playError = String(error);
          this.emitter.emit('change', this.snapshot());
        });
    } else {
      this.startPump();
    }
  }

  pause(): void {
    if (this.destroyed) return;
    const video = this.video;
    if (!video) {
      fail('invalid-state', `media source ${this.id} is not a video source`, { sourceId: this.id });
    }
    this.playing = false;
    this.stopPump();
    video.pause();
    // No lost final update: the current frame is re-uploaded once, then idle.
    // During a URL load there is no decoded frame; the uploaded pixels stay.
    if (this.state === 'ready') {
      this.pixelVersion++;
      this.emitter.emit('frame', this.snapshot());
    }
  }

  /**
   * Frame pump while playing: `requestVideoFrameCallback` when available (one
   * callback per decoded frame), otherwise an rAF loop. Stopping the pump on
   * pause is what returns the scheduler to idle (LIFE-05).
   */
  private startPump(): void {
    const video = this.video;
    if (!video || this.destroyed) return;
    const epoch = ++this.pumpEpoch;
    const live = (): boolean =>
      !this.destroyed && this.playing && this.state === 'ready' && epoch === this.pumpEpoch;
    const videoWithCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    const frameCallback = videoWithCallback.requestVideoFrameCallback?.bind(video);
    if (typeof frameCallback === 'function') {
      const step = (): void => {
        if (!live()) return;
        this.frameToken = frameCallback(() => {
          this.frameToken = null;
          if (!live()) return;
          this.onFrame();
          step();
        });
      };
      step();
      return;
    }
    if (typeof requestAnimationFrame !== 'function') return;
    const step = (): void => {
      if (!live()) return;
      this.onFrame();
      this.rafToken = requestAnimationFrame(step);
    };
    step();
  }

  private stopPump(): void {
    // Invalidate queued callbacks first: a cancelled rVFC token is best-effort
    // (older browsers lack cancelVideoFrameCallback) and a stale callback must
    // not upload a frame from before a pause or a URL switch.
    this.pumpEpoch++;
    const video = this.video;
    if (this.frameToken !== null && video) {
      (
        video as HTMLVideoElement & { cancelVideoFrameCallback?: (token: number) => void }
      ).cancelVideoFrameCallback?.(this.frameToken);
      this.frameToken = null;
    }
    if (this.rafToken !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafToken);
      this.rafToken = null;
    }
  }

  private onFrame(): void {
    if (this.destroyed) return;
    this.pixelVersion++;
    this.emitter.emit('frame', this.snapshot());
  }

  private failState(message: string): void {
    this.state = 'error';
    this.error = message;
    this.emitter.emit('change', this.snapshot());
  }

  snapshot(): MediaSourceSnapshot {
    return {
      sourceId: this.id,
      kind: this.kind,
      revision: this.revision,
      pixelVersion: this.pixelVersion,
      state: this.state,
      error: this.error,
      playError: this.playError,
      width: this.width,
      height: this.height,
      bounds: this.bounds,
      rotate: this.rotate,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playing = false;
    this.stopPump();
    this.videoCleanup?.();
    this.videoCleanup = null;
    const video = this.video;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.image = null;
    this.video = null;
    this.canvas = null;
    this.context = null;
    this.element = null;
    this.dirty = [];
    this.emitter.clear();
  }
}

function gatherRows(
  pixels: Uint8Array | Uint8ClampedArray,
  stride: number,
  region: MediaRegion,
): Uint8Array | Uint8ClampedArray {
  const rowBytes = region.width * 4;
  if (stride === rowBytes) return pixels;
  const out = new Uint8ClampedArray(rowBytes * region.height);
  for (let row = 0; row < region.height; row++) {
    out.set(pixels.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
  }
  return out;
}

export function createMediaSourceHandle(impl: MediaSourceImpl): MediaSourceHandle {
  return {
    id: impl.id,
    type: 'media',
    kind: impl.kind,
    get playing() {
      return impl.isPlaying;
    },
    snapshot() {
      return impl.snapshot();
    },
    ready() {
      if (impl.state !== 'loading') return Promise.resolve(impl.snapshot());
      return new Promise((resolve) => {
        const unsubscribe = impl.emitter.on('change', (snapshot) => {
          if (snapshot.state === 'loading') return;
          unsubscribe();
          resolve(snapshot);
        });
      });
    },
    update(patch) {
      impl.update(patch);
    },
    updateRegion(region, pixels, options) {
      impl.updateRegion(region, pixels, options);
    },
    play() {
      impl.play();
    },
    pause() {
      impl.pause();
    },
    subscribe(fn, options) {
      fn(impl.snapshot());
      return impl.emitter.on('change', fn, options);
    },
  };
}

export interface MediaSourceHandle {
  readonly id: string;
  readonly type: 'media';
  readonly kind: MediaSourceKind;
  readonly playing: boolean;
  snapshot(): MediaSourceSnapshot;
  /** Resolves once the media is usable or failed. */
  ready(): Promise<MediaSourceSnapshot>;
  /** Descriptor update: `url` (images and video), `bounds` and `rotate`. */
  update(patch: {
    readonly url?: string;
    readonly bounds?: MediaBounds;
    readonly rotate?: number;
  }): void;
  /** Image pixel update; validation rejects invalid regions before any change. */
  updateRegion(
    region: MediaRegion,
    pixels: Uint8Array | Uint8ClampedArray,
    options?: { readonly stride?: number },
  ): void;
  play(): void;
  pause(): void;
  subscribe(fn: (snapshot: MediaSourceSnapshot) => void, options?: SubscribeOptions): Unsubscribe;
}
