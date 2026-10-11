import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLocator,
  locateErrorResult,
  type GeolocationBrowserOptions,
  type GeolocationErrorLike,
  type GeolocationLike,
  type GeolocationPositionLike,
  type LocateResult,
} from '../../src/ui/locate.ts';

interface FakeCall {
  readonly success: (position: GeolocationPositionLike) => void;
  readonly error: (error: GeolocationErrorLike) => void;
  readonly options: GeolocationBrowserOptions | undefined;
}

function fakeProvider(): {
  provider: GeolocationLike;
  current: FakeCall[];
  watches: Map<number, FakeCall>;
  cleared: number[];
} {
  const current: FakeCall[] = [];
  const watches = new Map<number, FakeCall>();
  const cleared: number[] = [];
  let nextWatch = 1;
  const provider: GeolocationLike = {
    getCurrentPosition(success, error, options) {
      current.push({ success, error, options });
    },
    watchPosition(success, error, options) {
      const id = nextWatch++;
      watches.set(id, { success, error, options });
      return id;
    },
    clearWatch(id) {
      cleared.push(id);
    },
  };
  return { provider, current, watches, cleared };
}

const position: GeolocationPositionLike = {
  coords: { latitude: 50.08, longitude: 14.44, accuracy: 12 },
};

test('UI-07: one-shot success maps to a typed position and forwards options', async () => {
  const fake = fakeProvider();
  const locator = createLocator(() => fake.provider);
  const pending = locator.locate({ enableHighAccuracy: true, timeoutMs: 2500, maximumAgeMs: 1000 });
  assert.equal(fake.current.length, 1);
  const call = fake.current[0]!;
  assert.deepEqual(call.options, { enableHighAccuracy: true, timeout: 2500, maximumAge: 1000 });
  call.success(position);
  assert.deepEqual(await pending, {
    ok: true,
    position: { lat: 50.08, lng: 14.44, accuracy: 12 },
  });
});

test('UI-07: failures map to typed permission/timeout/unavailable results', async () => {
  const fake = fakeProvider();
  const locator = createLocator(() => fake.provider);

  const denied = locator.locate();
  fake.current[0]!.error({ code: 1, message: 'denied' });
  assert.deepEqual(await denied, { ok: false, code: 'permission', message: 'denied' });

  const timedOut = locator.locate();
  fake.current[1]!.error({ code: 3 });
  assert.deepEqual(await timedOut, { ok: false, code: 'timeout', message: 'geolocation error 3' });

  const unavailable = locateErrorResult({ code: 2, message: 'no signal' });
  assert.deepEqual(unavailable, { ok: false, code: 'unavailable', message: 'no signal' });
});

test('UI-07: a missing provider yields the unsupported result', async () => {
  const locator = createLocator(() => undefined);
  assert.deepEqual(await locator.locate(), {
    ok: false,
    code: 'unsupported',
    message: 'geolocation is not available in this environment',
  });
  const updates: LocateResult[] = [];
  const watch = locator.watch({ onUpdate: (result) => updates.push(result) });
  assert.equal(watch.active, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.ok, false);
  watch.cancel();
  assert.equal(updates.length, 1);
});

test('UI-07: watch delivers updates, cancel stops them and clears the browser watch', () => {
  const fake = fakeProvider();
  const locator = createLocator(() => fake.provider);
  const updates: LocateResult[] = [];
  const watch = locator.watch({ onUpdate: (result) => updates.push(result) });
  assert.equal(watch.active, true);
  assert.equal(fake.watches.size, 1);
  const id = [...fake.watches.keys()][0]!;
  const call = fake.watches.get(id)!;

  call.success(position);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { ok: true, position: { lat: 50.08, lng: 14.44, accuracy: 12 } });

  call.error({ code: 3, message: 'late fix' });
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], { ok: false, code: 'timeout', message: 'late fix' });

  watch.cancel();
  assert.deepEqual(fake.cleared, [id]);
  assert.equal(watch.active, false);
  // A late browser callback after cancel must not surface another update.
  call.success(position);
  assert.equal(updates.length, 2);
  watch.cancel();
  assert.deepEqual(fake.cleared, [id]);
});

test('UI-07: a provider throwing synchronously resolves as unavailable', async () => {
  const throwing: GeolocationLike = {
    getCurrentPosition() {
      throw new Error('blocked by policy');
    },
    watchPosition() {
      throw new Error('blocked by policy');
    },
    clearWatch() {},
  };
  const locator = createLocator(() => throwing);
  const result = await locator.locate();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'unavailable');
  const updates: LocateResult[] = [];
  const watch = locator.watch({ onUpdate: (entry) => updates.push(entry) });
  assert.equal(watch.active, false);
  assert.equal(updates.length, 1);
});
