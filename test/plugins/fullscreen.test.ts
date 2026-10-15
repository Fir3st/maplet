import test from 'node:test';
import assert from 'node:assert/strict';

import { fullscreenMode, type FullscreenApi } from '../../src/plugins/fullscreen.ts';
import type { PluginContext } from '../../src/plugins.ts';

function fakeDocument() {
  const listeners = new Set<(event: Event) => void>();
  const doc = {
    fullscreenElement: null as unknown,
    exitCalls: 0,
    exitFullscreen: async () => {
      doc.fullscreenElement = null;
      doc.exitCalls += 1;
    },
    addEventListener: (type: string, fn: (event: Event) => void) => {
      if (type === 'fullscreenchange') listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (event: Event) => void) => {
      if (type === 'fullscreenchange') listeners.delete(fn);
    },
    dispatchChange: () => {
      for (const fn of [...listeners]) fn(new Event('fullscreenchange'));
    },
    listenerCount: () => listeners.size,
  };
  return doc;
}

function fakeTarget(doc: ReturnType<typeof fakeDocument>, supported = true) {
  const target = {
    ownerDocument: doc,
    requestFullscreen: supported
      ? async () => {
          doc.fullscreenElement = target;
          doc.dispatchChange();
        }
      : undefined,
  };
  return target;
}

function install(target: unknown): {
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
  const api = fullscreenMode({ target: target as HTMLElement, onChange: (active) => changes.push(active) })(context);
  return { api, doc, changes, cleanups };
}

test('FULLSCREEN: enter, exit and browser-initiated exits stay in sync', async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc);
  const { api, changes } = install(target);
  assert.equal(api.supported, true);
  assert.equal(api.active, false);
  assert.equal(api.element(), null);

  assert.equal(await api.enter(), true);
  assert.equal(api.active, true);
  assert.equal(api.element(), target);
  assert.deepEqual(changes, [true]);

  // The browser or the user can leave fullscreen without the plugin asking.
  doc.fullscreenElement = null;
  doc.dispatchChange();
  assert.equal(api.active, false);
  assert.deepEqual(changes, [true, false]);

  assert.equal(await api.toggle(), true);
  assert.equal(api.active, true);
  assert.equal(await api.toggle(), true);
  assert.equal(api.active, false);
  assert.deepEqual(changes, [true, false, true, false]);
});

test('FULLSCREEN: unsupported targets report false instead of pretending', async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc, false);
  const { api, changes } = install(target);
  assert.equal(api.supported, false);
  assert.equal(await api.enter(), false);
  assert.equal(await api.exit(), true);
  assert.equal(api.active, false);
  assert.equal(api.element(), null);
  assert.deepEqual(changes, []);
});

test('FULLSCREEN: removing the plugin stops listening and leaves fullscreen', async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc);
  const { api, doc: sameDoc, cleanups } = install(target);
  assert.equal(sameDoc, doc);
  assert.equal(await api.enter(), true);
  assert.equal(doc.listenerCount(), 1);
  for (const cleanup of cleanups) cleanup();
  assert.equal(doc.listenerCount(), 0);
  assert.equal(doc.exitCalls, 1);
  doc.dispatchChange();
  assert.equal(api.active, true, 'a removed plugin no longer updates its snapshot');
});
