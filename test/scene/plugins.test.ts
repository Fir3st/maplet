import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMap,
  crs,
  type PluginContext,
  type RenderFrame,
  type PointGeometry,
  type PlanarPosition,
} from '../../src/index.ts';
import { makeMap, settled } from '../helpers/fixture.ts';

test('plain plugins return typed APIs; detached use/remove and independent instances work', async () => {
  const { map } = await makeMap();
  const order: string[] = [];
  const plugin = (context: PluginContext) => {
    const { map: owner, signal } = context;
    assert.equal(owner, map);
    context.onCleanup(() => order.push('first'));
    context.onCleanup(() => {
      assert.equal(signal.aborted, true);
      order.push('second');
    });
    return { zoom: () => owner.getView().zoom, signal };
  };
  const use = map.use;
  const first = use(plugin),
    second = use(plugin);
  assert.equal(first.api.zoom(), 8);
  const remove = first.remove.bind(first);
  remove();
  remove();
  assert.equal(first.removed, true);
  assert.equal(second.removed, false);
  assert.deepEqual(order, ['second', 'first']);
  map.destroy();
  assert.equal(second.api.signal.aborted, true);
  assert.throws(() => use(plugin), { code: 'destroyed' });
});

test('failed installation rolls back registered resources and all cleanups run on error', async () => {
  const { map } = await makeMap();
  const calls: number[] = [];
  let signal: AbortSignal | undefined;
  assert.throws(
    () =>
      map.use((ctx) => {
        signal = ctx.signal;
        ctx.onCleanup(() => calls.push(1));
        ctx.onCleanup(() => {
          calls.push(2);
          throw new Error('cleanup');
        });
        ctx.onCleanup(() => calls.push(3));
        ctx.render.onFrame(() => assert.fail('failed plugin retained a hook'));
        throw new Error('setup');
      }),
    AggregateError,
  );
  assert.equal(signal!.aborted, true);
  assert.deepEqual(calls, [3, 2, 1]);
  map.setView({ zoom: 9 });
  await map.whenRendered();
  map.destroy();
});

test('initial plugins install in order, and createMap cleans up on setup failure', async () => {
  const order: string[] = [];
  let context: PluginContext | undefined;
  await assert.rejects(
    createMap(null, {
      renderer: { primary: 'none' },
      plugins: [
        (ctx) => {
          context = ctx;
          order.push('a');
          ctx.onCleanup(() => order.push('remove-a'));
        },
        () => {
          order.push('b');
          throw new Error('broken');
        },
        () => {
          order.push('never');
        },
      ],
    }),
    /broken/,
  );
  assert.deepEqual(order, ['a', 'b', 'remove-a']);
  assert.equal(context!.map.destroyed, true);
  assert.equal(context!.signal.aborted, true);
});

test('functionality plugin owns sources, layers, events and cleanup before scene destruction', async () => {
  const { map } = await makeMap();
  let updates = 0;
  const plugin = map.use((context) => {
    const { map, signal } = context;
    const source = map.data.vector({ id: 'plugin-source' });
    context.onCleanup(() => map.data.remove(source.id));
    const layer = map.addLayer({ id: 'plugin-layer', type: 'points', source });
    context.onCleanup(() => layer.remove());
    map.on('viewchange', () => updates++, { signal });
    return {
      add: () =>
        source.features.add({
          id: 'point',
          geometry: { type: 'point', position: { lat: 50, lng: 14 } },
        }),
    };
  });
  plugin.api.add();
  map.setView({ zoom: 9 });
  assert.equal(updates, 1);
  plugin.remove();
  map.setView({ zoom: 10 });
  assert.equal(updates, 1);
  assert.equal(map.layers.get('plugin-layer'), undefined);
  assert.equal(map.data.get('plugin-source'), undefined);
  map.destroy();
});

test('transforms compose without modifying canonical data and are cached across repeat frames', async () => {
  const { map } = await makeMap({ projection: crs.simple(), center: { x: 0, y: 0 }, zoom: 0 });
  const source = map.data.vector<PointGeometry<PlanarPosition>>({ id: 'points' });
  source.features.add({ id: 1, geometry: { type: 'point', position: { x: 0, y: 0 } } });
  map.addLayer({ id: 'points', type: 'points', source });
  const calls: string[] = [];
  let observed: RenderFrame | undefined;
  const extension = map.use(({ render }) => {
    render.transform((plan) => {
      calls.push('a');
      return { ...plan, draws: [] };
    });
    render.transform((plan) => {
      calls.push('b');
      assert.equal(plan.draws.length, 0);
      return plan;
    });
    render.onFrame((frame) => {
      observed = frame;
    });
  });
  await map.whenRendered();
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(observed!.plan.draws.length, 0);
  assert.equal(source.features.get(1)!.geometry.type, 'point');
  // Diagnostics ask for the same plan without a new revision; hooks do not rerun.
  map.debug.layerColor('points');
  map.debug.layerColor('points');
  assert.deepEqual(calls, ['a', 'b']);
  extension.remove();
  const inspect = map.render.onFrame((frame) => {
    observed = frame;
  });
  await map.whenRendered();
  assert.equal(observed!.plan.draws.length, 1);
  inspect();
  map.destroy();
});

test('the same callback can be registered twice and removed independently', async () => {
  const { map } = await makeMap();
  let calls = 0;
  const fn = () => {
    calls++;
  };
  const first = map.render.onFrame(fn),
    second = map.render.onFrame(fn);
  map.setView({ zoom: 9 });
  await map.whenRendered();
  assert.equal(calls, 2);
  first();
  map.setView({ zoom: 10 });
  await map.whenRendered();
  assert.equal(calls, 3);
  second();
  map.destroy();
});

test('custom renderer serializes async frames, preserves revision fences and delegates picking', async () => {
  const { map, clock } = await makeMap();
  let finish: (() => void) | undefined;
  const revisions: number[] = [];
  let destroyed = 0;
  const plugin = map.use(({ render }) => {
    render.use({
      render: (frame) => {
        revisions.push(frame.plan.revision);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      pick: (point, options) => {
        assert.equal(point.x, 10);
        assert.equal(options.limit, 3);
        return Promise.resolve([]);
      },
      destroy: () => {
        destroyed++;
      },
    });
  });
  const firstRevision = map.stats().revision;
  let firstDone = false,
    secondDone = false;
  const first = map.whenRendered(firstRevision).then(() => {
    firstDone = true;
  });
  clock.advance(0);
  map.setView({ zoom: 9 });
  const secondRevision = map.stats().revision;
  const second = map.whenRendered(secondRevision).then(() => {
    secondDone = true;
  });
  clock.advance(0);
  assert.deepEqual(revisions, [firstRevision]);
  assert.equal(firstDone, false);
  finish!();
  await settled();
  await first;
  assert.equal(secondDone, false);
  assert.equal(map.stats().renderedRevision, firstRevision);
  clock.advance(0);
  assert.deepEqual(revisions, [firstRevision, secondRevision]);
  finish!();
  await settled();
  await second;
  assert.deepEqual(await map.query.rendered({ x: 10, y: 20 }, { limit: 3 }), []);
  assert.equal(map.capabilities().backend, 'custom');
  plugin.remove();
  assert.equal(destroyed, 1);
  assert.equal(map.capabilities().backend, 'none');
  await map.whenRendered();
  map.destroy();
  assert.equal(destroyed, 1);
});

test('custom renderer failures reject the fence, emit rendererror and remain removable', async () => {
  const { map, clock } = await makeMap();
  const error = new Error('render failed');
  const errors: unknown[] = [];
  map.on('rendererror', (event) => errors.push(event.error));
  const remove = map.render.use({
    render: () => {
      throw error;
    },
  });
  const fence = map.whenRendered();
  const rejection = assert.rejects(fence, /render failed/);
  clock.advance(0);
  await rejection;
  assert.deepEqual(errors, [error]);
  await assert.rejects(map.query.rendered({ x: 1, y: 1 }), { code: 'unsupported-capability' });
  assert.throws(() => map.render.use({ render() {} }), { code: 'dependency-conflict' });
  remove();
  await map.whenRendered();
  map.destroy();
});

test('map destruction cancels pending custom rendering even when plugin cleanup throws', async () => {
  const { map, clock } = await makeMap();
  let renders = 0,
    destroys = 0;
  map.render.use({
    render: () => {
      renders++;
    },
    destroy: () => {
      destroys++;
    },
  });
  map.use((context) => {
    context.onCleanup(() => {
      throw new Error('cleanup');
    });
  });
  assert.throws(map.destroy, AggregateError);
  assert.equal(map.destroyed, true);
  assert.equal(destroys, 1);
  assert.equal(clock.pending(), 0);
  clock.advance(0);
  assert.equal(renders, 0);
  map.destroy();
});

test('plugin invalidation creates a revision fence without changing sources', async () => {
  const { map } = await makeMap();
  await settled();
  const previous = map.stats().revision;
  const frames: number[] = [];
  const plugin = map.use(({ render }) => {
    render.onFrame(({ plan }) => frames.push(plan.revision));
    return { update: () => render.invalidate() };
  });
  plugin.api.update();
  const revision = map.stats().revision;
  assert.equal(revision, previous + 2);
  await map.whenRendered(revision);
  assert.deepEqual(frames, [revision]);
  assert.equal(map.stats().features, 0);
  plugin.remove();
  map.destroy();
});

test('plugin-only invalidation retains the packed buffer for 10,000 points', async () => {
  const { map } = await makeMap();
  const source = map.data.vector({ id: 'points' });
  const positions = new Float64Array(20_000);
  for (let i = 0; i < 10_000; i++) {
    positions[i * 2] = 14;
    positions[i * 2 + 1] = 50;
  }
  await source.importColumnar({ kind: 'point', positions });
  map.addLayer({ id: 'points', type: 'points', source });
  let buffer: Float32Array | undefined;
  let calls = 0;
  const plugin = map.use(({ render, container }) => {
    assert.equal(container, null);
    render.transform((plan) => {
      calls++;
      return plan;
    });
    render.onFrame(({ plan }) => {
      const draw = plan.draws[0]!;
      assert.equal(draw.type, 'batch');
      if (draw.type === 'batch') buffer = draw.batch.data;
    });
    return { update: () => render.invalidate() };
  });
  await map.whenRendered();
  const original = buffer;
  for (let i = 0; i < 20; i++) plugin.api.update();
  await map.whenRendered();
  assert.equal(buffer, original);
  assert.equal(calls, 2, 'coalesced invalidations transform once per rendered revision');
  assert.equal(source.features.count(), 10_000);
  plugin.remove();
  map.destroy();
});

test('async rendering and after-frame projection use the rendered view, not a newer view', async () => {
  const { map, clock } = await makeMap({
    projection: crs.simple(),
    center: { x: 0, y: 0 },
    zoom: 0,
  });
  let finish: (() => void) | undefined;
  let frame: RenderFrame | undefined;
  const points: number[] = [];
  const plugin = map.use(({ render }) => {
    render.onFrame((frame) => points.push(frame.positionToScreen({ x: 1, y: 0 }).x));
    render.use({
      render: (value) => {
        frame = value;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
  });
  clock.advance(0);
  assert.equal(frame!.positionToScreen({ x: 1, y: 0 }).x, 656);
  map.setView({ zoom: 1 });
  assert.equal(frame!.positionToScreen({ x: 1, y: 0 }).x, 656);
  finish!();
  await settled();
  assert.deepEqual(points, [656]);
  plugin.remove();
  await map.whenRendered();
  map.destroy();
});

test('transform failures reject pending frames, and removal repairs rendering', async () => {
  const { map } = await makeMap();
  const plugin = map.use(({ render }) => {
    render.onFrame(() => {});
    render.transform(() => {
      throw new Error('transform failed');
    });
  });
  await assert.rejects(map.whenRendered(), /transform failed/);
  plugin.remove();
  await map.whenRendered();
  map.destroy();
});

test('removing an in-flight renderer ignores its late completion', async () => {
  const { map, clock } = await makeMap();
  let finish: (() => void) | undefined;
  const remove = map.render.use({
    render: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  clock.advance(0);
  remove();
  await map.whenRendered();
  const frames = map.stats().frames;
  finish!();
  await settled();
  assert.equal(map.stats().frames, frames);
  map.destroy();
});

test('failed render registration rolls back even when an existing commit listener throws', async () => {
  const { map } = await makeMap();
  let disposed = 0;
  const off = map.on('commit', () => {
    throw new Error('application listener');
  });
  assert.throws(
    () =>
      map.use(({ render }) => {
        render.use({
          render() {},
          destroy() {
            disposed++;
          },
        });
      }),
    AggregateError,
  );
  assert.equal(map.capabilities().backend, 'none');
  assert.equal(disposed, 1);
  assert.throws(() => map.render.transform(() => assert.fail('leaked transform')), AggregateError);
  assert.throws(
    () => map.render.onFrame(() => assert.fail('leaked frame listener')),
    /application listener/,
  );
  off();
  const inspect = map.render.onFrame(() => {});
  await map.whenRendered();
  inspect();
  map.destroy();
});
