import { assertArgument, fail } from '../api/errors.ts';
import type { Position, ScreenPoint } from '../api/types.ts';
import type { MapHandle } from '../map.ts';
import type { Scene } from '../scene/scene.ts';
import { positionToScreen } from '../math/transform.ts';
import { buildFramePlan, releaseFramePlan, type FramePlan } from './frame-plan.ts';
import type { PickResult } from './picking.ts';

export interface RenderFrame {
  readonly map: MapHandle;
  readonly plan: FramePlan;
  readonly time: number;
  /** CSS-pixel coordinates, independent of renderer DPR. */
  positionToScreen(position: Position): ScreenPoint;
}

export interface CustomRenderer {
  /** Resolve only once this frame has been submitted/painted. Frames never overlap. */
  render(frame: RenderFrame): void | Promise<void>;
  /** Without pick, rendered queries are unsupported and gestures have no feature hits. */
  pick?(point: ScreenPoint, options: { readonly limit: number }): Promise<readonly PickResult[]>;
  /** Actual custom-renderer counters; omitted counters are reported as zero, not guessed. */
  stats?(): { readonly instances: number; readonly drawCalls: number; readonly gpuBytes: number };
  destroy?(): void;
}

export interface RenderHandle {
  /** Pure transformation. Return a new plan/draw/buffer for changes; never mutate retained data. */
  transform(fn: (plan: FramePlan) => FramePlan): () => void;
  /** Draw into your own HTML/canvas/GPU surface after the map, before whenRendered resolves. */
  onFrame(fn: (frame: RenderFrame) => void): () => void;
  /** Replace the default renderer until removal. Only one replacement may be active. */
  use(renderer: CustomRenderer): () => void;
  /** Reapply transforms and request a frame after plugin-owned state changes. */
  invalidate(): void;
}

export class RenderExtensions {
  readonly handle: RenderHandle;
  private readonly transforms = new Set<(plan: FramePlan) => FramePlan>();
  private readonly listeners = new Set<(frame: RenderFrame) => void>();
  private custom: CustomRenderer | null = null;
  private epoch = 0;
  private cached: { input: FramePlan; epoch: number; output: FramePlan } | null = null;
  private cancel: (() => void) | null = null;
  private generation = 0;
  private closed = false;
  private removeCustom: (() => void) | null = null;
  private readonly scene: Scene;
  private readonly getMap: () => MapHandle;
  private readonly setDefaultVisible: (visible: boolean) => void;
  private readonly dpr: number;

  constructor(
    scene: Scene,
    getMap: () => MapHandle,
    setDefaultVisible: (visible: boolean) => void,
    dpr: number,
  ) {
    this.scene = scene;
    this.getMap = getMap;
    this.setDefaultVisible = setDefaultVisible;
    this.dpr = dpr;
    this.handle = {
      invalidate: () => this.invalidate(),
      transform: (fn) => {
        this.assertAlive();
        assertArgument(typeof fn === 'function', 'render.transform expects a function');
        const registered = (plan: FramePlan): FramePlan => fn(plan);
        this.transforms.add(registered);
        this.scene.transformFramePlan = (plan) => this.transform(plan);
        return this.activate(() => {
          if (!this.transforms.delete(registered)) return;
          if (!this.transforms.size) this.scene.transformFramePlan = null;
          this.invalidate();
        });
      },
      onFrame: (fn) => {
        this.assertAlive();
        assertArgument(typeof fn === 'function', 'render.onFrame expects a function');
        const registered = (frame: RenderFrame): void => fn(frame);
        this.listeners.add(registered);
        this.scene.afterFrame = (plan) => this.afterFrame(plan);
        return this.activate(() => {
          this.listeners.delete(registered);
          if (!this.listeners.size) this.scene.afterFrame = null;
        });
      },
      use: (renderer) => this.use(renderer),
    };
  }

  get active(): boolean {
    return this.custom !== null;
  }

  pick(point: ScreenPoint, options: { readonly limit: number }): Promise<readonly PickResult[]> {
    if (!this.custom?.pick)
      fail('unsupported-capability', 'the custom renderer does not implement picking');
    return this.custom.pick(point, options);
  }

  private assertAlive(): void {
    this.scene.assertAlive('render');
    if (this.closed) fail('destroyed', 'render: the map is being destroyed');
  }

  /** Roll back registration if publication invokes a failing application listener. */
  private activate(remove: () => void): () => void {
    try {
      this.invalidate();
      return remove;
    } catch (error) {
      try {
        remove();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'render registration and cleanup failed');
      }
      throw error;
    }
  }

  private invalidate(): void {
    if (this.closed) return;
    this.scene.assertAlive('render.invalidate');
    this.epoch++;
    this.cached = null;
    // A plugin-only visual change gets a revision, so whenRendered is a real fence.
    // Keep retained geometry resident: this is not a broad source/style invalidation.
    this.scene.publishStateChange(true);
  }

  private transform(plan: FramePlan): FramePlan {
    if (this.cached?.input === plan && this.cached.epoch === this.epoch) return this.cached.output;
    let output = plan;
    for (const fn of [...this.transforms]) {
      if (this.transforms.has(fn)) output = fn(output);
    }
    this.cached = { input: plan, epoch: this.epoch, output };
    return output;
  }

  private frame(plan?: FramePlan): RenderFrame {
    const map = this.getMap();
    const size = map.size();
    const currentPlan =
      plan ??
      buildFramePlan(this.scene, {
        deviceWidth: Math.max(1, Math.round(size.width * this.dpr)),
        deviceHeight: Math.max(1, Math.round(size.height * this.dpr)),
        dpr: this.dpr,
      });
    return {
      map,
      plan: currentPlan,
      time: this.scene.clock.now(),
      positionToScreen: (position) =>
        positionToScreen(currentPlan.view, this.scene.crs.normalize(position)),
    };
  }

  private afterFrame(plan?: FramePlan): void {
    const frame = this.frame(plan);
    for (const fn of [...this.listeners]) if (this.listeners.has(fn)) fn(frame);
  }

  private use(renderer: CustomRenderer): () => void {
    this.assertAlive();
    assertArgument(
      renderer && typeof renderer.render === 'function',
      'render.use expects a renderer with render(frame)',
    );
    if (this.custom) fail('dependency-conflict', 'a custom renderer is already installed');
    this.custom = renderer;
    this.setDefaultVisible(false);
    this.scene.overrideFrameDriver = { requestFrame: () => this.requestCustomFrame() };
    this.scene.overridePick = (point, options) =>
      renderer.pick?.(point, options) ?? Promise.resolve([]);
    this.scene.resetFrameRequest();
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      this.removeCustom = null;
      this.custom = null;
      this.generation++;
      this.cancel?.();
      this.cancel = null;
      this.scene.overrideFrameDriver = null;
      this.scene.overridePick = null;
      this.setDefaultVisible(true);
      this.scene.resetFrameRequest();
      try {
        renderer.destroy?.();
      } finally {
        this.invalidate();
      }
    };
    this.removeCustom = remove;
    return this.activate(remove);
  }

  private requestCustomFrame(): void {
    const renderer = this.custom!;
    const generation = this.generation;
    this.cancel = this.scene.clock.schedule(() => {
      this.cancel = null;
      if (this.closed || this.custom !== renderer || generation !== this.generation) return;
      const revision = this.scene.revision;
      const epoch = this.epoch;
      const run = async (): Promise<void> => {
        try {
          const frame = this.frame();
          await renderer.render(frame);
          if (this.closed || generation !== this.generation) return;
          this.scene.setFrameStats(
            renderer.stats?.() ?? { instances: 0, drawCalls: 0, gpuBytes: 0 },
          );
          this.scene.completeFrame(revision, frame.plan);
          if (this.epoch !== epoch) this.scene.requestFrame();
        } catch (error) {
          if (!this.closed && generation === this.generation) this.scene.failFrame(error);
        }
      };
      void run();
    }, 0);
  }

  destroy(): void {
    this.closed = true;
    try {
      this.removeCustom?.();
    } finally {
      this.generation++;
      this.cancel?.();
      this.transforms.clear();
      this.listeners.clear();
      this.cached = null;
      releaseFramePlan(this.scene);
      this.scene.transformFramePlan = null;
      this.scene.afterFrame = null;
    }
  }
}
