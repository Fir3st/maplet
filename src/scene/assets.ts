/**
 * Image asset registry (`map.assets`).
 *
 * Assets are registered under a stable id and loaded once; layers reference the
 * id, never a decoded element. Load states are observable (`loading` -> `ready`
 * or `error`) and an error is never presented as a silently empty symbol
 * (MEDIA-08). The registry owns the decoded element; the GPU backend uploads it
 * and the frame plan only carries the id (MEDIA-07: no per-instance element).
 */

import { assertArgument, fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import type { SubscribeOptions, Unsubscribe } from '../api/types.ts';

export type ImageAssetState = 'loading' | 'ready' | 'error';

export interface ImageAssetSnapshot {
  readonly id: string;
  readonly src: string;
  readonly state: ImageAssetState;
  /** Natural size of the decoded image in device pixels (0 until ready). */
  readonly width: number;
  readonly height: number;
  /** Human-readable reason when state is 'error'. */
  readonly error: string | null;
}

export class ImageAssetImpl {
  readonly id: string;
  readonly src: string;
  state: ImageAssetState = 'loading';
  image: HTMLImageElement | null = null;
  error: string | null = null;
  /** Bumped when the element changes; backend texture caches key on it. */
  version = 0;
  readonly emitter = new Emitter<{ change: ImageAssetSnapshot }>();

  constructor(id: string, src: string) {
    this.id = id;
    this.src = src;
  }

  snapshot(): ImageAssetSnapshot {
    return {
      id: this.id,
      src: this.src,
      state: this.state,
      width: this.image?.naturalWidth ?? 0,
      height: this.image?.naturalHeight ?? 0,
      error: this.error,
    };
  }
}

export interface ImageAssetHandle {
  readonly id: string;
  snapshot(): ImageAssetSnapshot;
  /** Resolves once the image is decoded or failed. */
  ready(): Promise<ImageAssetSnapshot>;
  subscribe(fn: (snapshot: ImageAssetSnapshot) => void, options?: SubscribeOptions): Unsubscribe;
}

/* --------------------------------- fonts ---------------------------------- */

export type FontAssetState = 'loading' | 'ready' | 'error';

export interface FontAssetSnapshot {
  readonly id: string;
  /** CSS family name the label styles reference. */
  readonly family: string;
  readonly src: string;
  readonly state: FontAssetState;
  /** Human-readable reason when state is 'error'. */
  readonly error: string | null;
}

export class FontAssetImpl {
  readonly id: string;
  readonly family: string;
  readonly src: string;
  state: FontAssetState = 'loading';
  face: FontFace | null = null;
  error: string | null = null;
  /** Bumped when the face becomes usable; label atlas keys include it (TEXT-05). */
  version = 0;
  readonly emitter = new Emitter<{ change: FontAssetSnapshot }>();

  constructor(id: string, family: string, src: string) {
    this.id = id;
    this.family = family;
    this.src = src;
  }

  snapshot(): FontAssetSnapshot {
    return {
      id: this.id,
      family: this.family,
      src: this.src,
      state: this.state,
      error: this.error,
    };
  }
}

export interface FontAssetHandle {
  readonly id: string;
  readonly family: string;
  snapshot(): FontAssetSnapshot;
  /** Resolves once the font is usable or failed. */
  ready(): Promise<FontAssetSnapshot>;
  subscribe(fn: (snapshot: FontAssetSnapshot) => void, options?: SubscribeOptions): Unsubscribe;
}

export class AssetRegistry {
  private readonly images = new Map<string, ImageAssetImpl>();
  private readonly fonts = new Map<string, FontAssetImpl>();

  addImage(id: string, src: string): ImageAssetImpl {
    assertArgument(typeof id === 'string' && id.length > 0, 'assets.addImage requires an id');
    assertArgument(typeof src === 'string' && src.length > 0, 'assets.addImage requires a src');
    if (this.images.has(id) || this.fonts.has(id)) {
      fail('duplicate-id', `asset already exists: ${id}`, { assetId: id });
    }
    const asset = new ImageAssetImpl(id, src);
    this.images.set(id, asset);
    if (typeof Image === 'function') {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (this.images.get(id) !== asset) return; // removed while loading
        if (image.naturalWidth === 0 || image.naturalHeight === 0) {
          asset.state = 'error';
          asset.error = 'decoded image has no intrinsic size';
        } else {
          asset.state = 'ready';
          asset.error = null;
          asset.image = image;
          asset.version++;
        }
        asset.emitter.emit('change', asset.snapshot());
      };
      image.onerror = () => {
        if (this.images.get(id) !== asset) return;
        asset.state = 'error';
        asset.error = `failed to load ${src}`;
        asset.emitter.emit('change', asset.snapshot());
      };
      image.src = src;
      asset.image = image;
    } else {
      // Headless (no DOM): the asset is visible as an explicit error state.
      asset.state = 'error';
      asset.error = 'image decoding is not available in this environment';
    }
    return asset;
  }

  /**
   * Registers a font family for label rasterization (TEXT-05). `src` is a URL
   * or a CSS font source (`local(...)`/`url(...)`); the face is loaded through
   * `FontFace` and added to `document.fonts` only once usable. While loading or
   * after an error, labels render with the platform fallback and the state is
   * observable through the handle — never a silent success.
   */
  addFont(id: string, family: string, src: string): FontAssetImpl {
    assertArgument(typeof id === 'string' && id.length > 0, 'assets.addFont requires an id');
    assertArgument(typeof family === 'string' && family.length > 0, 'assets.addFont requires a family');
    assertArgument(typeof src === 'string' && src.length > 0, 'assets.addFont requires a src');
    if (this.images.has(id) || this.fonts.has(id)) {
      fail('duplicate-id', `asset already exists: ${id}`, { assetId: id });
    }
    const asset = new FontAssetImpl(id, family, src);
    this.fonts.set(id, asset);
    const canLoad =
      typeof FontFace === 'function' && typeof document !== 'undefined' && document.fonts !== undefined;
    if (!canLoad) {
      // Headless (no DOM): the asset is visible as an explicit error state.
      asset.state = 'error';
      asset.error = 'font loading is not available in this environment';
      return asset;
    }
    const source = /^(local|url)\(/.test(src) ? src : `url("${src}")`;
    let face: FontFace;
    try {
      face = new FontFace(family, source);
    } catch (error) {
      asset.state = 'error';
      asset.error = `invalid font source: ${String(error)}`;
      return asset;
    }
    asset.face = face;
    face
      .load()
      .then((loaded) => {
        if (this.fonts.get(id) !== asset) return; // removed while loading
        document.fonts.add(loaded);
        asset.face = loaded;
        asset.state = 'ready';
        asset.error = null;
        asset.version++;
        asset.emitter.emit('change', asset.snapshot());
      })
      .catch((error: unknown) => {
        if (this.fonts.get(id) !== asset) return;
        asset.state = 'error';
        asset.error = `failed to load font ${src}: ${String(error)}`;
        asset.emitter.emit('change', asset.snapshot());
      });
    return asset;
  }

  get(id: string): ImageAssetImpl | undefined {
    return this.images.get(id);
  }

  getFont(id: string): FontAssetImpl | undefined {
    return this.fonts.get(id);
  }

  has(id: string): boolean {
    return this.images.has(id) || this.fonts.has(id);
  }

  list(): ImageAssetImpl[] {
    return Array.from(this.images.values());
  }

  listFonts(): FontAssetImpl[] {
    return Array.from(this.fonts.values());
  }

  /**
   * Signature of the font used for a family in label atlas keys: it changes when
   * a registered font becomes ready, so labels are remeasured in a new revision
   * instead of reusing a stale rasterization (TEXT-05).
   */
  fontSignature(family: string): string {
    for (const font of this.fonts.values()) {
      if (font.family !== family) continue;
      if (font.state === 'ready') return `ready@${font.version}`;
      return font.state;
    }
    return 'system';
  }

  remove(id: string): void {
    const font = this.fonts.get(id);
    if (font) {
      if (font.face && typeof document !== 'undefined' && document.fonts !== undefined) {
        try {
          document.fonts.delete(font.face);
        } catch {
          // Deleting an unadded face is not an error worth surfacing.
        }
      }
      this.fonts.delete(id);
      return;
    }
    this.images.delete(id);
  }

  /** Decoded element for the backend; null until ready. */
  elementFor(id: string): HTMLImageElement | null {
    const asset = this.images.get(id);
    return asset && asset.state === 'ready' ? asset.image : null;
  }

  destroy(): void {
    for (const font of this.fonts.values()) {
      if (font.face && typeof document !== 'undefined' && document.fonts !== undefined) {
        try {
          document.fonts.delete(font.face);
        } catch {
          // best effort
        }
      }
    }
    this.fonts.clear();
    this.images.clear();
  }
}

export function createImageAssetHandle(impl: ImageAssetImpl): ImageAssetHandle {
  return {
    id: impl.id,
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
    subscribe(fn, options) {
      fn(impl.snapshot());
      return impl.emitter.on('change', fn, options);
    },
  };
}

export function createFontAssetHandle(impl: FontAssetImpl): FontAssetHandle {
  return {
    id: impl.id,
    family: impl.family,
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
    subscribe(fn, options) {
      fn(impl.snapshot());
      return impl.emitter.on('change', fn, options);
    },
  };
}
