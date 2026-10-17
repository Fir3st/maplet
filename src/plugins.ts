import { assertArgument, fail } from './api/errors.ts';
import type { MapHandle } from './map.ts';
import type { RenderHandle } from './render/extensions.ts';

/** A plugin is just a synchronous setup function; options belong in its closure. */
export type Plugin<T = void> = (context: PluginContext) => T;

export interface PluginContext {
  readonly map: MapHandle;
  /** Live DOM access is intentional; null for DOM-free maps. */
  readonly container: HTMLElement | null;
  readonly render: RenderHandle;
  /** Aborted on removal, failed installation or map destruction. */
  readonly signal: AbortSignal;
  /** Register listeners, DOM, layers, timers or other resources for LIFO cleanup. */
  onCleanup(cleanup: () => void): void;
}

export interface PluginHandle<T> {
  readonly api: T;
  readonly removed: boolean;
  remove(): void;
}

/** Owns installations, not plugin identities: each use creates an independent instance. */
export class PluginHost {
  private readonly removers = new Set<() => void>();
  private closed = false;
  private readonly getMap: () => MapHandle;
  private readonly container: HTMLElement | null;
  private readonly render: RenderHandle;

  constructor(getMap: () => MapHandle, container: HTMLElement | null, render: RenderHandle) {
    this.getMap = getMap;
    this.container = container;
    this.render = render;
  }

  use<T>(plugin: Plugin<T>): PluginHandle<T> {
    if (this.closed || this.getMap().destroyed)
      fail('destroyed', 'use: the map has been destroyed');
    assertArgument(typeof plugin === 'function', 'use expects a plugin function');
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      this.removers.delete(remove);
      const errors: unknown[] = [];
      controller.abort();
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      cleanups.length = 0;
      if (errors.length) throw new AggregateError(errors, 'plugin cleanup failed');
    };
    this.removers.add(remove);
    const onCleanup = (cleanup: () => void): void => {
      assertArgument(typeof cleanup === 'function', 'onCleanup expects a function');
      if (removed) cleanup();
      else cleanups.push(cleanup);
    };
    // Render registrations made through the context belong to this installation.
    const scopedRender: RenderHandle = {
      invalidate: () => this.render.invalidate(),
      transform: (fn) => {
        const off = this.render.transform(fn);
        onCleanup(off);
        return off;
      },
      onFrame: (fn) => {
        const off = this.render.onFrame(fn);
        onCleanup(off);
        return off;
      },
      use: (renderer) => {
        const off = this.render.use(renderer);
        onCleanup(off);
        return off;
      },
    };
    try {
      const api = plugin({
        map: this.getMap(),
        container: this.container,
        render: scopedRender,
        signal: controller.signal,
        onCleanup,
      });
      assertArgument(
        !(api && typeof (api as { then?: unknown }).then === 'function'),
        'plugin setup must be synchronous; start async work using signal',
      );
      return {
        api,
        get removed() {
          return removed;
        },
        remove,
      };
    } catch (error) {
      try {
        remove();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'plugin installation and cleanup failed');
      }
      throw error;
    }
  }

  destroy(): void {
    this.closed = true;
    const errors: unknown[] = [];
    for (const remove of [...this.removers].reverse()) {
      try {
        remove();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'plugin cleanup failed');
  }
}
