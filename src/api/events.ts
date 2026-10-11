import type { SubscribeOptions, Unsubscribe } from './types.ts';

type ListenerFn<D> = (data: D) => void;

/**
 * Minimal typed event emitter with snapshot emission semantics:
 * - listeners present when `emit` starts are called at most once per emission;
 * - a listener removed during emission is not called again in that emission;
 * - a listener added during emission is not called for the current event.
 */
export class Emitter<M extends object> {
  private readonly listeners = new Map<keyof M, Set<ListenerFn<never>>>();

  on<K extends keyof M>(type: K, fn: ListenerFn<M[K]>, options?: SubscribeOptions): Unsubscribe {
    const signal = options?.signal;
    if (signal?.aborted) return noop;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const stored = fn as ListenerFn<never>;
    set.add(stored);
    const off = () => {
      const current = this.listeners.get(type);
      if (current?.delete(stored) && current.size === 0) {
        this.listeners.delete(type);
      }
      signal?.removeEventListener('abort', off);
    };
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  once<K extends keyof M>(type: K, fn: ListenerFn<M[K]>, options?: SubscribeOptions): Unsubscribe {
    const off = this.on(
      type,
      (data) => {
        off();
        fn(data);
      },
      options,
    );
    return off;
  }

  off<K extends keyof M>(type: K, fn: ListenerFn<M[K]>): void {
    const set = this.listeners.get(type);
    if (set?.delete(fn as ListenerFn<never>) && set.size === 0) {
      this.listeners.delete(type);
    }
  }

  emit<K extends keyof M>(type: K, data: M[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    const snapshot = Array.from(set);
    for (const fn of snapshot) {
      if (!set.has(fn)) continue;
      (fn as ListenerFn<M[K]>)(data);
    }
  }

  hasListeners(type: keyof M): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}

function noop(): void {}
