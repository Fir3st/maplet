import test from 'node:test';
import assert from 'node:assert/strict';

import { heatmap, type HeatmapApi } from '../../src/plugins/heatmap.ts';
import type { Crs } from '../../src/math/crs.ts';
import type { PluginContext } from '../../src/plugins.ts';
import type { FramePlan } from '../../src/render/frame-plan.ts';
import type { RenderFrame } from '../../src/render/extensions.ts';

interface DrawCall {
  readonly alpha: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface FakeCanvas {
  width: number;
  height: number;
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  readonly attributes: Record<string, string>;
  readonly draws: DrawCall[];
  readonly puts: ImageData[];
  removed: boolean;
  composited: string;
  alpha: number;
  setAttribute(name: string, value: string): void;
  remove(): void;
  getContext(type: string): unknown;
}

function fakeDocument(): { readonly document: Document; readonly created: FakeCanvas[] } {
  const created: FakeCanvas[] = [];
  const document = {
    createElement(tag: string) {
      assert.equal(tag, 'canvas', 'the plugin creates canvas elements only');
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        style: {} as Record<string, string>,
        dataset: {} as Record<string, string>,
        attributes: {} as Record<string, string>,
        draws: [] as DrawCall[],
        puts: [] as ImageData[],
        removed: false,
        composited: 'source-over',
        alpha: 1,
        setAttribute(name: string, value: string) {
          canvas.attributes[name] = value;
        },
        remove() {
          canvas.removed = true;
        },
        getContext(type: string) {
          if (type !== '2d') return null;
          const context = {
            canvas,
            fillStyle: '' as unknown,
            setTransform: () => {},
            clearRect: () => {
              canvas.draws.length = 0;
            },
            createRadialGradient: () => ({ addColorStop: () => {} }),
            createLinearGradient: () => ({ addColorStop: () => {} }),
            fillRect: () => {},
            drawImage: (_image: unknown, x = 0, y = 0, width = 0, height = 0) => {
              canvas.draws.push({ alpha: canvas.alpha, x, y, width, height });
            },
            getImageData: (_x: number, _y: number, width: number, height: number) => {
              const data = new Uint8ClampedArray(width * height * 4);
              for (let index = 0; index < width * height; index += 1) {
                if (width === 256 && height === 1) {
                  // The ramp canvas: a red ramp at full alpha.
                  data[index * 4] = index % 256;
                  data[index * 4 + 3] = 255;
                } else {
                  // The field canvas: an accumulated alpha pattern.
                  data[index * 4 + 3] = index % 256;
                }
              }
              return { data, width, height } as unknown as ImageData;
            },
            putImageData: (image: ImageData) => {
              canvas.puts.push(image);
            },
          };
          Object.defineProperty(context, 'globalCompositeOperation', {
            get: () => canvas.composited,
            set: (value: string) => {
              canvas.composited = value;
            },
          });
          Object.defineProperty(context, 'globalAlpha', {
            get: () => canvas.alpha,
            set: (value: number) => {
              canvas.alpha = value;
            },
          });
          return context;
        },
      };
      created.push(canvas);
      return canvas;
    },
  };
  return { document: document as unknown as Document, created };
}

interface Harness {
  readonly api: HeatmapApi;
  readonly container: { style: Record<string, string> };
  readonly overlay: FakeCanvas;
  readonly frames: ((frame: RenderFrame) => void)[];
  readonly cleanups: (() => void)[];
  readonly invalidations: () => number;
  readonly unsubscribed: () => number;
  render(dpr?: number): void;
}

const geographic = { positionKind: 'geographic', normalize: (position: unknown) => position } as unknown as Crs;
const planar = { positionKind: 'planar', normalize: (position: unknown) => position } as unknown as Crs;

function install(
  options: Parameters<typeof heatmap>[0],
  configure: (render: { crs: Crs; width?: number; height?: number; dpr?: number }) => void = () => {},
): Harness {
  const { document, created } = fakeDocument();
  const container = {
    style: { position: '' } as Record<string, string>,
    ownerDocument: document,
    appendChild: () => {},
  };
  const cleanups: (() => void)[] = [];
  const frames: ((frame: RenderFrame) => void)[] = [];
  let invalidations = 0;
  let unsubscribed = 0;
  const render = {
    invalidate: () => {
      invalidations += 1;
    },
    onFrame: (fn: (frame: RenderFrame) => void) => {
      frames.push(fn);
      const off = () => {
        unsubscribed += 1;
        frames.splice(frames.indexOf(fn), 1);
      };
      // The plugin host scopes render registrations into the installation's cleanups.
      cleanups.push(off);
      return off;
    },
    transform: () => () => {},
    use: () => () => {},
  };
  const context = {
    map: {},
    container,
    render,
    signal: new AbortController().signal,
    onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
  } as unknown as PluginContext;
  const api = heatmap(options)(context);
  const overlay = created[0]!;
  const renderFrame = (dpr = 1): void => {
    const settings = { crs: geographic, width: 640, height: 480, dpr };
    configure(settings);
    const plan = {
      revision: 1,
      view: { crs: settings.crs, width: settings.width, height: settings.height },
      deviceWidth: settings.width * dpr,
      deviceHeight: settings.height * dpr,
      dpr,
    } as unknown as FramePlan;
    for (const frame of [...frames]) {
      frame({
        plan,
        time: 0,
        positionToScreen: (position: { lat: number; lng: number } | { x: number; y: number }) => ({
          x: 'lat' in position ? position.lat : position.x,
          y: 'lat' in position ? position.lng : position.y,
        }),
      } as unknown as RenderFrame);
    }
  };
  return {
    api,
    container,
    overlay,
    frames,
    cleanups,
    invalidations: () => invalidations,
    unsubscribed: () => unsubscribed,
    render: renderFrame,
  };
}

test('HEAT-10: the plugin owns one positioned overlay canvas and cleans it up', () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'static' });
  try {
    const harness = install({});
    assert.match(harness.overlay.style['cssText'] ?? '', /position:absolute/);
    assert.match(harness.overlay.style['cssText'] ?? '', /pointer-events:none/);
    assert.equal(harness.overlay.dataset['mapletHeatmap'], 'true');
    assert.equal(harness.overlay.attributes['aria-hidden'], 'true');
    assert.equal(harness.container.style['position'], 'relative', 'a static container is positioned');
    assert.equal(harness.frames.length, 1, 'the plugin registers exactly one frame hook');
    for (const cleanup of harness.cleanups) cleanup();
    assert.equal(harness.overlay.removed, true);
    assert.equal(harness.container.style['position'], '', 'cleanup restores the container position');
    assert.equal(harness.unsubscribed(), 1, 'cleanup unregisters the frame hook');
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('HEAT-10: the data hook replaces, appends and clears samples', () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'relative' });
  try {
    const harness = install({ points: [{ position: [100, 100] }, { position: [200, 200], weight: 0.5 }] });
    assert.equal(harness.api.count, 2);
    const installed = harness.invalidations();
    harness.api.addPoint([300, 300], 2);
    assert.equal(harness.api.count, 3);
    assert.equal(harness.invalidations(), installed + 1, 'adding a sample schedules a frame');
    harness.api.addPoints([{ position: [10, 10], weight: 0.25 }, { position: [20, 20] }]);
    assert.equal(harness.api.count, 5);
    harness.api.addPoints([]);
    assert.equal(harness.api.count, 5, 'an empty append changes nothing');
    harness.api.setPoints([{ position: [100, 100] }]);
    assert.equal(harness.api.count, 1, 'setPoints replaces every sample');
    harness.api.clear();
    assert.equal(harness.api.count, 0);
    assert.equal(harness.invalidations(), installed + 4);
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('HEAT-10: frames splat visible samples with weight-derived alphas and skip the rest', () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'relative' });
  try {
    const harness = install({
      points: [
        { position: [100, 100], weight: 1 },
        { position: [200, 200], weight: 0.5 },
        { position: [10000, 10000], weight: 1 },
        { position: [300, 300], weight: 0 },
      ],
    });
    harness.render();
    assert.equal(harness.overlay.draws.length, 2, 'off-view and non-positive samples are skipped');
    assert.deepEqual(harness.overlay.draws[0], { alpha: 1, x: 75, y: 75, width: 50, height: 50 });
    assert.deepEqual(harness.overlay.draws[1], { alpha: 0.5, x: 175, y: 175, width: 50, height: 50 });
    assert.equal(harness.overlay.composited, 'source-over', 'additive compositing is reset after splatting');

    // The auto peak follows the data: a heavier sample rescales the rest.
    harness.api.addPoint([400, 400], 4);
    harness.render();
    assert.deepEqual(harness.overlay.draws.map((draw) => draw.alpha), [0.25, 0.125, 1]);
    // An explicit peak, an alpha floor and a bigger radius apply on the next frame.
    harness.api.setOptions({ max: 2, minOpacity: 0.3, radius: 10, blur: 0 });
    harness.render();
    assert.deepEqual(harness.overlay.draws.map((draw) => draw.alpha), [0.5, 0.3, 1]);
    assert.deepEqual(harness.overlay.draws[0], { alpha: 0.5, x: 90, y: 90, width: 20, height: 20 });

    // Colorization maps accumulated alpha through the ramp into RGBA bytes.
    const image = harness.overlay.puts.at(-1)!;
    const bytes = new Uint8Array(image.data.buffer);
    for (const index of [0, 7, 200, 63_999]) {
      const intensity = index % 256;
      assert.deepEqual(
        [bytes[index * 4], bytes[index * 4 + 1], bytes[index * 4 + 2], bytes[index * 4 + 3]],
        [intensity, 0, 0, intensity],
      );
    }
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('HEAT-10: an empty field clears the surface without colorizing', () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'relative' });
  try {
    const harness = install({ points: [{ position: [100, 100] }] });
    harness.render();
    assert.equal(harness.overlay.puts.length, 1);
    harness.api.clear();
    harness.render();
    assert.equal(harness.overlay.draws.length, 0, 'no splats without samples');
    assert.equal(harness.overlay.puts.length, 1, 'no colorize pass without samples');
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('HEAT-10: the field buffer stays bounded on large views', () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'relative' });
  try {
    const harness = install({ points: [{ position: [100, 100] }] });
    harness.render(2);
    assert.equal(harness.overlay.width, 960, '2 device pixels per CSS pixel are capped at 1.5');
    assert.equal(harness.overlay.height, 720);
    harness.render(1);
    assert.equal(harness.overlay.width, 640);
    harness.render(1);
    assert.equal(harness.overlay.width, 640);
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('HEAT-10: invalid positions, weights and options fail with invalid-argument', () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'relative' });
  try {
    const code = (error: unknown): string | undefined => (error as { code?: string }).code;
    assert.throws(() => install({ radius: 0 }), (error: unknown) => code(error) === 'invalid-argument');
    assert.throws(() => install({ gradient: [] }), (error: unknown) => code(error) === 'invalid-argument');
    assert.throws(() => install({ gradient: [[0, '#000']] }), (error: unknown) => code(error) === 'invalid-argument');
    const harness = install({ points: [{ position: [100, 100] }] });
    assert.throws(() => harness.api.setPoints('nope' as never), (error: unknown) => code(error) === 'invalid-argument');
    assert.throws(() => harness.api.addPoint([1, Number.NaN]), (error: unknown) => code(error) === 'invalid-argument');
    assert.throws(() => harness.api.setPoints([{ position: { lat: 1, lng: 2 }, weight: 'heavy' as never }]), (error: unknown) => code(error) === 'invalid-argument');
    assert.throws(() => harness.api.setOptions({ maxOpacity: 2 }), (error: unknown) => code(error) === 'invalid-argument');
    assert.throws(() => harness.api.setOptions({ minOpacity: 0.9, maxOpacity: 0.2 }), (error: unknown) => code(error) === 'invalid-argument');
    assert.throws(() => harness.api.setOptions({ blur: -1 }), (error: unknown) => code(error) === 'invalid-argument');
    assert.doesNotThrow(() => harness.api.setOptions({ gradient: null, max: null }), 'null restores the defaults');

    // A [lat, lng] tuple on a planar CRS fails like every other public position.
    const planarHarness = install({ points: [{ position: [100, 100] }] }, (render) => {
      render.crs = planar;
    });
    assert.throws(() => planarHarness.render(), (error: unknown) => code(error) === 'invalid-argument');
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('HEAT-10: a rejected update leaves the previous state intact', () => {
  const globalWithStyle = globalThis as { getComputedStyle?: unknown };
  const previousStyle = globalWithStyle.getComputedStyle;
  globalWithStyle.getComputedStyle = () => ({ position: 'relative' });
  try {
    const code = (error: unknown): string | undefined => (error as { code?: string }).code;
    const harness = install({ points: [{ position: [100, 100], weight: 1 }, { position: [200, 200], weight: 0.5 }] });
    harness.api.setOptions({ minOpacity: 0.8 });
    // The invalid maxOpacity would contradict the earlier floor; the patch must not apply.
    assert.throws(() => harness.api.setOptions({ maxOpacity: 0.5 }), (error: unknown) => code(error) === 'invalid-argument');
    harness.render();
    assert.deepEqual(harness.overlay.draws.map((draw) => draw.alpha), [1, 0.8], 'the previous opacity floor still applies');
    const before = harness.api.count;
    assert.throws(
      () => harness.api.addPoints([{ position: [10, 10] }, { position: [20, 'x'] as never }]),
      (error: unknown) => code(error) === 'invalid-argument',
    );
    assert.equal(harness.api.count, before, 'a rejected append adds nothing');
  } finally {
    if (previousStyle === undefined) delete globalWithStyle.getComputedStyle;
    else globalWithStyle.getComputedStyle = previousStyle;
  }
});

test('HEAT-10: the plugin needs a container', () => {
  const cleanups: (() => void)[] = [];
  const context = {
    map: {},
    container: null,
    render: { invalidate: () => {}, onFrame: () => () => {}, transform: () => () => {}, use: () => () => {} },
    signal: new AbortController().signal,
    onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
  } as unknown as PluginContext;
  assert.throws(
    () => heatmap()(context),
    (error: unknown) => (error as { code?: string }).code === 'unsupported-capability',
  );
});
