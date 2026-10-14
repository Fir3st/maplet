import { assertArgument } from './errors.ts';
import type { FeatureEventType, MapFeatureEvent, SubscribeOptions, Unsubscribe } from './types.ts';

export type FeatureEvent<T extends FeatureEventType = FeatureEventType> = Omit<MapFeatureEvent, 'type'> & { readonly type: T };

export interface FeatureEvents {
  on<T extends FeatureEventType>(type: T, fn: (event: FeatureEvent<T>) => void, options?: SubscribeOptions): Unsubscribe;
  once<T extends FeatureEventType>(type: T, fn: (event: FeatureEvent<T>) => void, options?: SubscribeOptions): Unsubscribe;
  /** Advanced: observe all feature interaction types, excluding background clicks. */
  onFeature(fn: (event: MapFeatureEvent) => void, options?: SubscribeOptions): Unsubscribe;
}

export const featureEventTypes: readonly FeatureEventType[] = ['click', 'mouseover', 'mouseout', 'mousemove', 'dragstart', 'drag', 'dragend'];

/** Subscribe only when requested; merely obtaining an object adds no listener. */
export function featureEvents(
  subscribe: (fn: (event: MapFeatureEvent) => void, options?: SubscribeOptions) => Unsubscribe,
  accept: (event: MapFeatureEvent) => boolean = () => true,
  lifetime?: AbortSignal,
): FeatureEvents {
  const watch = (fn: (event: MapFeatureEvent) => void, options?: SubscribeOptions): Unsubscribe => {
    if (!lifetime) return subscribe(fn, options);
    const stop = subscribe(fn, options);
    let active = true;
    const off = (): void => {
      if (!active) return;
      active = false;
      stop();
      lifetime?.removeEventListener('abort', off);
      options?.signal?.removeEventListener('abort', off);
    };
    lifetime?.addEventListener('abort', off, { once: true });
    options?.signal?.addEventListener('abort', off, { once: true });
    if (lifetime?.aborted || options?.signal?.aborted) off();
    return off;
  };
  const listen = <T extends FeatureEventType>(type: T, fn: (event: FeatureEvent<T>) => void, options?: SubscribeOptions, once = false): Unsubscribe => {
    assertArgument(featureEventTypes.includes(type), `unknown feature event: ${String(type)}`);
    assertArgument(typeof fn === 'function', 'event listener must be a function');
    const off = watch((event) => {
      if (event.type !== type || !accept(event)) return;
      if (once) off();
      fn(event as FeatureEvent<T>);
    }, options);
    return off;
  };
  return {
    on: (type, fn, options) => listen(type, fn, options),
    once: (type, fn, options) => listen(type, fn, options, true),
    onFeature: (fn, options) => {
      assertArgument(typeof fn === 'function', 'event listener must be a function');
      return watch((event) => { if (accept(event)) fn(event); }, options);
    },
  };
}
