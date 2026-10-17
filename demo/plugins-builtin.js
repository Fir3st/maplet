/**
 * Built-in plugin battery (INPUT-09, FULLSCREEN, HEAT-10): the gesture guard
 * (two-finger touch, modifier-gated mouse and page scroll through `touch-action`),
 * the fullscreen mode plugin (state sync, corner button, cleanup, unavailability)
 * and the heatmap plugin (weighted splats, ramp and radius updates, bounded field
 * buffer, cleanup). Results: `window.__builtinPluginCheckResult`.
 */
import { createMap, fullscreenMode, gestureGuard, heatmap } from '../dist/index.js';

const WIDTH = 640;
const HEIGHT = 480;
const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass =
    result.errors.length === 0 &&
    result.checks.length === 11 &&
    result.checks.every((entry) => entry.pass);
  window.__builtinPluginCheckResult = result;
  document.title = 'builtin-plugin-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
let started = 0;

const map = await createMap('map', {
  renderer: {
    primary: new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1',
    fallback: false,
  },
  size: { width: WIDTH, height: HEIGHT },
  center: { lat: 50.0, lng: 14.0 },
  zoom: 13,
  controls: ['zoom'],
});

const element = document.getElementById('map');
// Diagnostics hook for the check page and manual inspection.
window.__builtinPluginDebug = { map, element };
const rect = element.getBoundingClientRect();
const pointer = (type, pointerId, x, y, options = {}) =>
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      isPrimary: pointerId === 1,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: rect.left + x,
      clientY: rect.top + y,
      ...options,
    }),
  );
const touch = (type, pointerId, x, y) => pointer(type, pointerId, x, y, { pointerType: 'touch' });
const mouse = (type, pointerId, x, y, options = {}) =>
  pointer(type, pointerId, x, y, { pointerType: 'mouse', ...options });
const wheel = (x, y, deltaY, options = {}) => {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
    deltaY,
    ...options,
  });
  element.dispatchEvent(event);
  return event;
};
const doubleClick = (x, y, options = {}) =>
  element.dispatchEvent(
    new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      ...options,
    }),
  );
const center = () => {
  const value = map.getCenter();
  return { lat: value.lat, lng: value.lng };
};
const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
const zoom = () => map.getZoom();

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: !!outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.checks.push({ name, pass: false, detail: String(error) });
    result.errors.push(`${name}: ${String(error)}`);
  }
}

let guardHandle = null;
let fullscreenHandle = null;
let fullscreenApi = null;

started = performance.now();

await check('INPUT-09 one finger is ignored on touch, two fingers pinch and pan', async () => {
  guardHandle = map.use(gestureGuard());
  const touchAction = element.style.touchAction;
  const before = center();
  const beforeZoom = zoom();
  // One finger: a real gesture starts but the gate keeps the view still.
  touch('pointerdown', 1, 320, 240);
  await sleep(80);
  touch('pointermove', 1, 380, 280);
  touch('pointerup', 1, 380, 280);
  const afterOne = center();
  const oneBlocked = same(before, afterOne) && zoom() === beforeZoom;
  // Two fingers: pinch out (distance 40 -> 100) and drag the midpoint.
  touch('pointerdown', 1, 300, 240);
  touch('pointerdown', 2, 340, 240);
  touch('pointermove', 1, 270, 240);
  touch('pointermove', 2, 370, 240);
  const pinchedZoom = zoom();
  touch('pointermove', 1, 290, 240);
  touch('pointermove', 2, 390, 240);
  const panned = center();
  touch('pointerup', 1, 290, 240);
  // After one finger lifts, the remaining finger must not pan.
  const afterLift = center();
  touch('pointermove', 2, 420, 260);
  const liftedStill = center();
  touch('pointerup', 2, 420, 260);
  return {
    pass:
      touchAction === 'pan-y' &&
      oneBlocked &&
      pinchedZoom > beforeZoom + 0.5 &&
      !same(before, panned) &&
      same(afterLift, liftedStill),
    detail: {
      touchAction,
      oneBlocked,
      beforeZoom,
      pinchedZoom,
      panned: !same(before, panned),
      afterLiftBlocked: same(afterLift, liftedStill),
    },
  };
});

await check('INPUT-09 mouse pan, wheel and double-click need the modifier', async () => {
  const before = center();
  const beforeZoom = zoom();
  // Without the modifier: nothing moves, and the wheel keeps scrolling the page.
  mouse('pointerdown', 3, 320, 240);
  await sleep(80);
  mouse('pointermove', 3, 400, 300);
  mouse('pointerup', 3, 400, 300);
  const panBlocked = same(before, center());
  const blockedWheel = wheel(320, 240, -240);
  const wheelBlocked = !blockedWheel.defaultPrevented && zoom() === beforeZoom;
  doubleClick(320, 240);
  const doubleBlocked = zoom() === beforeZoom;
  // With Alt held: pan, wheel and double-click apply.
  mouse('pointerdown', 4, 320, 240, { altKey: true });
  await sleep(80);
  mouse('pointermove', 4, 360, 270, { altKey: true });
  mouse('pointerup', 4, 360, 270, { altKey: true });
  const panAllowed = !same(before, center());
  const allowedWheel = wheel(320, 240, -240, { altKey: true });
  const wheelAllowed = allowedWheel.defaultPrevented && zoom() > beforeZoom;
  const zoomBeforeDouble = zoom();
  doubleClick(320, 240, { altKey: true });
  const doubleAllowed = zoom() === zoomBeforeDouble + 1;
  return {
    pass:
      panBlocked && wheelBlocked && doubleBlocked && panAllowed && wheelAllowed && doubleAllowed,
    detail: { panBlocked, wheelBlocked, doubleBlocked, panAllowed, wheelAllowed, doubleAllowed },
  };
});

await check('INPUT-09 unlock, lock, modifier switching and onChange', async () => {
  const changes = [];
  guardHandle.remove();
  const handle = map.use(gestureGuard({ onChange: (state) => changes.push(state.unlocked) }));
  const api = handle.api;
  const beforeZoom = zoom();
  wheel(320, 240, -240);
  const locked = zoom() === beforeZoom;
  api.unlock();
  wheel(320, 240, -240);
  const unlocked = zoom() > beforeZoom;
  api.lock();
  const zoomBeforeLockedWheel = zoom();
  wheel(320, 240, -240);
  const lockedAgain = zoom() === zoomBeforeLockedWheel;
  api.setModifier('control');
  const beforeCenter = center();
  mouse('pointerdown', 5, 320, 240, { ctrlKey: true });
  await sleep(80);
  mouse('pointermove', 5, 360, 240, { ctrlKey: true });
  mouse('pointerup', 5, 360, 240, { ctrlKey: true });
  const controlAllowed = !same(beforeCenter, center());
  api.setModifier('alt');
  const beforeAlt = center();
  mouse('pointerdown', 6, 320, 240, { ctrlKey: true });
  await sleep(80);
  mouse('pointermove', 6, 360, 240, { ctrlKey: true });
  mouse('pointerup', 6, 360, 240, { ctrlKey: true });
  const altOnly = same(beforeAlt, center());
  handle.remove();
  guardHandle = null;
  return {
    pass:
      locked &&
      unlocked &&
      lockedAgain &&
      controlAllowed &&
      altOnly &&
      changes.length === 2 &&
      changes[0] === true &&
      changes[1] === false,
    detail: { locked, unlocked, lockedAgain, controlAllowed, altOnly, changes },
  };
});

await check('INPUT-09 removing the guard restores touch-action and gestures', async () => {
  const restoredTouchAction = element.style.touchAction;
  const before = center();
  mouse('pointerdown', 7, 320, 240);
  await sleep(80);
  mouse('pointermove', 7, 360, 260);
  mouse('pointerup', 7, 360, 260);
  const panWorks = !same(before, center());
  const beforeTouch = center();
  touch('pointerdown', 8, 380, 300);
  await sleep(80);
  touch('pointermove', 8, 420, 320);
  touch('pointerup', 8, 420, 320);
  const touchWorks = !same(beforeTouch, center());
  return {
    pass: restoredTouchAction === 'none' && panWorks && touchWorks,
    detail: { restoredTouchAction, panWorks, touchWorks },
  };
});

await check('INPUT-09 a blocked attempt explains itself with a hint that expires', async () => {
  const hintAt = () => element.querySelector('[data-maplet-gesture-hint]');
  const handle = map.use(gestureGuard({ overlay: { durationMs: 350 } }));
  const blockedWheel = wheel(320, 240, -240);
  const hint = hintAt();
  const visible = hint?.dataset.visible === 'true' && hint?.style.opacity === '1';
  const wheelText = hint?.textContent ?? '';
  const notPrevented = !blockedWheel.defaultPrevented;
  // A blocked touch drag switches the hint to the finger guidance.
  touch('pointerdown', 21, 300, 220);
  await sleep(80);
  touch('pointermove', 21, 360, 250);
  const touchText = hintAt()?.textContent ?? '';
  touch('pointerup', 21, 360, 250);
  // An allowed gesture hides it, and it also expires on its own.
  wheel(320, 240, -240, { altKey: true });
  const hiddenByAllowed = hintAt()?.dataset.visible === 'false';
  wheel(320, 240, -240);
  const shownAgain = hintAt()?.dataset.visible === 'true';
  await sleep(450);
  const expired = hintAt()?.dataset.visible === 'false';
  handle.remove();
  const removed = hintAt() === null;
  // The overlay can be turned off and then never appears.
  const quiet = map.use(gestureGuard({ overlay: false }));
  wheel(320, 240, -240);
  const silent = hintAt() === null;
  quiet.remove();
  return {
    pass:
      visible &&
      notPrevented &&
      /Hold Alt and scroll/.test(wheelText) &&
      /2 fingers/.test(touchText) &&
      hiddenByAllowed &&
      shownAgain &&
      expired &&
      removed &&
      silent,
    detail: {
      visible,
      notPrevented,
      wheelText,
      touchText,
      hiddenByAllowed,
      shownAgain,
      expired,
      removed,
      silent,
    },
  };
});

await check(
  'FULLSCREEN enter, exit, browser exits and the corner button stay in sync',
  async () => {
    // Stub the Fullscreen API so the battery does not depend on a user gesture.
    const store = { element: null, exitCalls: 0 };
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => store.element,
    });
    const realExit = document.exitFullscreen;
    document.exitFullscreen = async () => {
      store.element = null;
      store.exitCalls += 1;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    const realRequest = element.requestFullscreen;
    element.requestFullscreen = async () => {
      store.element = element;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    try {
      const changes = [];
      fullscreenHandle = map.use(
        fullscreenMode({ control: true, onChange: (active) => changes.push(active) }),
      );
      fullscreenApi = fullscreenHandle.api;
      const supported = fullscreenApi.supported;
      const button = element.querySelector('[data-maplet-control="fullscreen"]');
      const entered = await fullscreenApi.enter();
      const activeAfterEnter = fullscreenApi.active && fullscreenApi.element() === element;
      const nativeMode = fullscreenApi.mode === 'native';
      const buttonExit = button?.getAttribute('aria-label') === 'Exit fullscreen';
      // A browser or user exit is picked up from the event alone.
      store.element = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      const browserExit =
        !fullscreenApi.active && button?.getAttribute('aria-label') === 'Enter fullscreen';
      // The button toggles through the same path (a synthetic click is enough).
      button?.click();
      await sleep(30);
      const buttonEntered = fullscreenApi.active;
      button?.click();
      await sleep(30);
      const buttonExited = !fullscreenApi.active;
      const toggled = (await fullscreenApi.toggle()) && fullscreenApi.active;
      await fullscreenApi.exit();
      return {
        pass:
          supported &&
          !!button &&
          entered &&
          activeAfterEnter &&
          nativeMode &&
          buttonExit &&
          browserExit &&
          buttonEntered &&
          buttonExited &&
          toggled &&
          changes[0] === true &&
          changes.includes(false),
        detail: {
          supported,
          hasButton: !!button,
          entered,
          activeAfterEnter,
          nativeMode,
          buttonExit,
          browserExit,
          buttonEntered,
          buttonExited,
          toggled,
          changes,
        },
      };
    } finally {
      fullscreenHandle?.remove();
      fullscreenHandle = null;
      fullscreenApi = null;
      element.requestFullscreen = realRequest;
      document.exitFullscreen = realExit;
      delete document.fullscreenElement;
    }
  },
);

await check('FULLSCREEN cleanup exits and the map follows container resizes', async () => {
  const store = { element: null, exitCalls: 0 };
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => store.element,
  });
  const realExit = document.exitFullscreen;
  document.exitFullscreen = async () => {
    store.element = null;
    store.exitCalls += 1;
  };
  const realRequest = element.requestFullscreen;
  element.requestFullscreen = async () => {
    store.element = element;
  };
  try {
    const handle = map.use(fullscreenMode({ control: true }));
    const api = handle.api;
    const button = () => element.querySelector('[data-maplet-control="fullscreen"]');
    await api.enter();
    const wasActive = api.active;
    handle.remove();
    const cleanedUp = !wasActive || store.exitCalls === 1;
    const buttonGone = button() === null;
    // A container resize reaches the map through its own observer (fullscreen relies on it).
    const before = map.size();
    element.style.width = '520px';
    element.style.height = '360px';
    let resized = null;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      resized = map.size();
      if (resized.width === 520 && resized.height === 360) break;
    }
    element.style.width = `${WIDTH}px`;
    element.style.height = `${HEIGHT}px`;
    let restored = null;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      restored = map.size();
      if (restored.width === WIDTH) break;
    }
    // An unsupported target reports false instead of pretending (fallback off).
    const unsupportedTarget = document.createElement('div');
    unsupportedTarget.requestFullscreen = undefined;
    const unsupported = map.use(fullscreenMode({ target: unsupportedTarget, fallback: false }));
    const unsupportedApi = unsupported.api;
    const refused = await unsupportedApi.enter();
    unsupported.remove();
    return {
      pass:
        cleanedUp &&
        buttonGone &&
        before.width === WIDTH &&
        resized.width === 520 &&
        resized.height === 360 &&
        restored.width === WIDTH &&
        unsupportedApi.supported === false &&
        refused === false,
      detail: {
        cleanedUp,
        buttonGone,
        before,
        resized,
        restored,
        supported: unsupportedApi.supported,
        refused,
      },
    };
  } finally {
    element.requestFullscreen = realRequest;
    document.exitFullscreen = realExit;
    delete document.fullscreenElement;
  }
});

await check(
  'FULLSCREEN a denied request falls back to the viewport cover and Escape exits',
  async () => {
    const realRequest = element.requestFullscreen;
    element.requestFullscreen = async () => {
      throw new Error('denied by a stub');
    };
    try {
      const handle = map.use(fullscreenMode({ control: true, fallback: true }));
      const api = handle.api;
      const entered = await api.enter();
      const fallbackMode = api.mode === 'fallback' && api.active;
      const covered =
        element.dataset.mapletFullscreenFallback === 'true' &&
        element.style.position === 'fixed' &&
        element.style.inset !== '';
      const button = element.querySelector('[data-maplet-control="fullscreen"]');
      const buttonTitle = button?.title.includes('viewport fallback') === true;
      // Escape leaves the CSS fallback because the browser has nothing to exit here.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(80);
      const escaped = api.mode === null && !api.active;
      const restored =
        element.style.position === '' && element.dataset.mapletFullscreenFallback === undefined;
      handle.remove();
      // The fallback is optional: without it a denied request reports false.
      const strict = map.use(fullscreenMode({ fallback: false }));
      const refused = await strict.api.enter();
      const strictState =
        strict.api.mode === null && !strict.api.active && element.style.position === '';
      strict.remove();
      return {
        pass:
          entered &&
          fallbackMode &&
          covered &&
          buttonTitle &&
          escaped &&
          restored &&
          refused === false &&
          strictState,
        detail: {
          entered,
          fallbackMode,
          covered,
          buttonTitle,
          escaped,
          restored,
          refused,
          strictState,
        },
      };
    } finally {
      element.requestFullscreen = realRequest;
    }
  },
);

await check('HEAT-10 a weighted field renders, restyles and clears', async () => {
  const field = (canvas) => {
    const context = canvas.getContext('2d');
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    let strongest = { alpha: -1, color: [0, 0, 0, 0] };
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3];
      if (!alpha) continue;
      painted += 1;
      if (alpha > strongest.alpha) {
        strongest = { alpha, color: [data[index], data[index + 1], data[index + 2], alpha] };
      }
    }
    return { painted, strongest };
  };
  // Earlier checks panned the map; the heat field needs a known view.
  map.setView({ center: { lat: 50, lng: 14 }, zoom: 13 });
  await map.whenRendered();
  const heat = map.use(
    heatmap({
      points: [
        { position: [50.02, 14.02], weight: 1 },
        { position: [50.02, 14.02], weight: 1 },
        { position: [50.005, 14.03], weight: 0.4 },
      ],
      radius: 28,
    }),
  );
  await map.whenRendered();
  const canvas = element.querySelector('canvas[data-maplet-heatmap]');
  if (!canvas) return { pass: false, detail: { reason: 'no overlay canvas' } };
  const inert =
    getComputedStyle(canvas).pointerEvents === 'none' &&
    canvas.getAttribute('aria-hidden') === 'true' &&
    canvas.dataset.mapletHeatmap === 'true';
  const first = field(canvas);
  const hot =
    first.painted > 400 &&
    first.strongest.alpha > 200 &&
    first.strongest.color[0] > first.strongest.color[2];
  const count = heat.api.count;

  // Appearance changes reach the next frame: the hot core turns green.
  heat.api.setOptions({
    gradient: [
      [0, '#3b0764'],
      [1, '#22ff22'],
    ],
  });
  await map.whenRendered();
  const second = field(canvas);
  const ramp =
    second.strongest.color[1] > second.strongest.color[0] && second.strongest.color[1] > 200;

  // A smaller radius shrinks the field; addPoint and clear() follow the data hook.
  heat.api.setOptions({ radius: 10 });
  await map.whenRendered();
  const smaller = field(canvas).painted < first.painted;
  heat.api.addPoint([50.01, 14.015], 1);
  const grown = heat.api.count === count + 1;
  heat.api.clear();
  await map.whenRendered();
  const cleared = field(canvas).painted === 0;
  heat.remove();
  const removed = element.querySelector('canvas[data-maplet-heatmap]') === null;
  return {
    pass: inert && hot && ramp && smaller && grown && cleared && removed,
    detail: { inert, painted: first.painted, hot, ramp, smaller, grown, cleared, removed },
  };
});

await check('HEAT-10 the field stays inert without data and follows the container', async () => {
  const before = element.style.position;
  const heat = map.use(heatmap());
  await map.whenRendered();
  const canvas = element.querySelector('canvas[data-maplet-heatmap]');
  if (!canvas) return { pass: false, detail: { reason: 'no overlay canvas' } };
  const empty = heat.api.count === 0 && canvas.width > 0 && canvas.height > 0;
  const sized =
    canvas.style.width === `${element.clientWidth}px` &&
    canvas.style.height === `${element.clientHeight}px`;
  const untouched = element.style.position === before;
  heat.api.addPoint([50, 14], 1);
  await map.whenRendered();
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let painted = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index]) painted += 1;
  }
  heat.api.setOptions({ zIndex: 4 });
  const zIndex = canvas.style.zIndex === '4';
  heat.remove();
  const removed = element.querySelector('canvas[data-maplet-heatmap]') === null;
  return {
    pass: empty && sized && untouched && painted > 300 && zIndex && removed,
    detail: { empty, sized, untouched, painted, zIndex, removed },
  };
});

await check('HEAT-10 the field follows the view through the renderer projection', async () => {
  // Independent oracle: the renderer's own per-frame projection.
  let projected = null;
  const observer = map.use(({ render }) => {
    render.onFrame((frame) => {
      projected = frame.positionToScreen({ lat: 50, lng: 14 });
    });
  });
  map.setView({ center: { lat: 50, lng: 14 }, zoom: 13 });
  await map.whenRendered();
  const projectedBefore = { x: projected.x, y: projected.y };
  const heat = map.use(heatmap({ points: [{ position: [50, 14], weight: 1 }], radius: 28 }));
  await map.whenRendered();
  const canvas = element.querySelector('canvas[data-maplet-heatmap]');
  const hottest = () => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let best = { alpha: -1, x: 0, y: 0 };
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3];
      if (alpha > best.alpha)
        best = { alpha, x: (index / 4) % canvas.width, y: Math.floor(index / 4 / canvas.width) };
    }
    return best;
  };
  const splatBefore = hottest();
  map.setView({ center: { lat: 50.01, lng: 14.01 }, zoom: 13 });
  await map.whenRendered();
  const splatAfter = hottest();
  const projectedAfter = { x: projected.x, y: projected.y };
  const oracle = {
    dx: projectedAfter.x - projectedBefore.x,
    dy: projectedAfter.y - projectedBefore.y,
  };
  const actual = { dx: splatAfter.x - splatBefore.x, dy: splatAfter.y - splatBefore.y };
  const moved = Math.abs(actual.dx - oracle.dx) <= 2 && Math.abs(actual.dy - oracle.dy) <= 2;
  heat.remove();
  observer.remove();
  return { pass: moved, detail: { oracle, actual, moved } };
});

result.ms = Math.round(performance.now() - started);
finalize();
