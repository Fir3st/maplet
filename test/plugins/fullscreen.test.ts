import test from 'node:test';
import assert from 'node:assert/strict';

import { fullscreenMode, type FullscreenApi } from '../../src/plugins/fullscreen.ts';
import type { PluginContext } from '../../src/plugins.ts';

function fakeDocument() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const doc = {
    fullscreenElement: null as unknown,
    exitCalls: 0,
    exitFullscreen: async () => {
      doc.fullscreenElement = null;
      doc.exitCalls += 1;
    },
    addEventListener: (type: string, fn: (event: Event) => void) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener: (type: string, fn: (event: Event) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchChange: () => {
      for (const fn of [...(listeners.get('fullscreenchange') ?? [])]) fn(new Event('fullscreenchange'));
    },
    dispatchKey: (key: string) => {
      for (const fn of [...(listeners.get('keydown') ?? [])]) fn({ key } as unknown as Event);
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
  return doc;
}

function fakeTarget(doc: ReturnType<typeof fakeDocument>, request: 'ok' | 'reject' | 'missing' = 'ok') {
  const target = {
    style: { position: '', inset: '', zIndex: '', overflow: '', background: '' } as Record<string, string>,
    dataset: {} as Record<string, string>,
    ownerDocument: doc,
    requestFullscreen:
      request === 'ok'
        ? async () => {
            doc.fullscreenElement = target;
            doc.dispatchChange();
          }
        : request === 'reject'
          ? async () => {
              throw new Error('denied');
            }
          : undefined,
  };
  return target;
}

function install(
  target: unknown,
  options: { readonly fallback?: boolean } = {},
): {
  api: FullscreenApi;
  doc: ReturnType<typeof fakeDocument>;
  changes: boolean[];
  cleanups: (() => void)[];
} {
  const container = {} as HTMLElement;
  const cleanups: (() => void)[] = [];
  const context = {
    map: {},
    container,
    render: {},
    signal: new AbortController().signal,
    onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
  } as unknown as PluginContext;
  const changes: boolean[] = [];
  const doc = (target as { ownerDocument: ReturnType<typeof fakeDocument> }).ownerDocument;
  const api = fullscreenMode({
    target: target as HTMLElement,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    onChange: (active) => changes.push(active),
  })(context);
  return { api, doc, changes, cleanups };
}

test('FULLSCREEN: native enter, exit and browser-initiated exits stay in sync', async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc);
  const { api, changes } = install(target);
  assert.equal(api.supported, true);
  assert.equal(api.active, false);
  assert.equal(api.mode, null);
  assert.equal(api.element(), null);

  assert.equal(await api.enter(), true);
  assert.equal(api.active, true);
  assert.equal(api.mode, 'native');
  assert.equal(api.element(), target);
  assert.deepEqual(changes, [true]);

  // The browser or the user can leave fullscreen without the plugin asking.
  doc.fullscreenElement = null;
  doc.dispatchChange();
  assert.equal(api.active, false);
  assert.equal(api.mode, null);
  assert.deepEqual(changes, [true, false]);

  assert.equal(await api.toggle(), true);
  assert.equal(api.mode, 'native');
  assert.equal(await api.toggle(), true);
  assert.equal(api.mode, null);
  assert.deepEqual(changes, [true, false, true, false]);
});

test('FULLSCREEN: a denied or missing API falls back to the viewport cover', async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc, 'reject');
  const { api, changes } = install(target);
  assert.equal(api.supported, true);
  assert.equal(await api.enter(), true);
  assert.equal(api.mode, 'fallback');
  assert.equal(api.active, true);
  assert.equal(api.element(), target);
  assert.equal(target.dataset.mapletFullscreenFallback, 'true');
  assert.equal(target.style.position, 'fixed');
  assert.equal(target.style.inset, '0');
  assert.equal(doc.listenerCount('keydown'), 1);
  assert.deepEqual(changes, [true]);

  // Escape leaves the fallback because the browser has nothing to exit here.
  doc.dispatchKey('Escape');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(api.mode, null);
  assert.equal(api.active, false);
  assert.equal(target.dataset.mapletFullscreenFallback, undefined);
  assert.equal(target.style.position, '');
  assert.equal(doc.listenerCount('keydown'), 0);
  assert.deepEqual(changes, [true, false]);
});

test('FULLSCREEN: fallback can be disabled and unsupported targets report false', async () => {
  const denied = install(fakeTarget(fakeDocument(), 'reject'), { fallback: false });
  assert.equal(await denied.api.enter(), false);
  assert.equal(denied.api.active, false);
  assert.equal(denied.api.mode, null);
  assert.deepEqual(denied.changes, []);

  const missingDoc = fakeDocument();
  const missing = fakeTarget(missingDoc, 'missing');
  const withoutFallback = install(missing, { fallback: false });
  assert.equal(withoutFallback.api.supported, false);
  assert.equal(await withoutFallback.api.enter(), false);
  assert.equal(withoutFallback.api.mode, null);
  // The viewport fallback still gives a usable fullscreen without the API.
  const withFallback = install(missing);
  assert.equal(await withFallback.api.enter(), true);
  assert.equal(withFallback.api.mode, 'fallback');
  assert.equal(await withFallback.api.exit(), true);
  assert.equal(withFallback.api.mode, null);
});

test('FULLSCREEN: removing the plugin stops listening, restores styles and leaves fullscreen', async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc);
  const { api, cleanups } = install(target);
  assert.equal(await api.enter(), true);
  assert.equal(doc.listenerCount('fullscreenchange'), 1);
  for (const cleanup of cleanups) cleanup();
  assert.equal(doc.listenerCount('fullscreenchange'), 0);
  assert.equal(doc.exitCalls, 1);

  const fallbackDoc = fakeDocument();
  const fallbackTarget = fakeTarget(fallbackDoc, 'reject');
  const fallbackInstall = install(fallbackTarget);
  assert.equal(await fallbackInstall.api.enter(), true);
  for (const cleanup of fallbackInstall.cleanups) cleanup();
  assert.equal(fallbackTarget.style.position, '');
  assert.equal(fallbackDoc.listenerCount('keydown'), 0);
});
