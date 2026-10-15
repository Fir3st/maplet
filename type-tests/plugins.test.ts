import { createMap, fullscreenMode, gestureGuard, type FullscreenApi, type GestureGuardApi, type GestureModifier, type Plugin, type PluginContext, type FramePlan, type CustomRenderer } from '@fir3st/maplet';

const plugin: Plugin<{ setLabel(label: string): void }> = ({ container, signal, onCleanup, render }: PluginContext) => {
  const element = container?.ownerDocument.createElement('span');
  if (element) { container!.append(element); onCleanup(() => element.remove()); }
  container?.addEventListener('click', () => {}, { signal });
  render.transform((plan: FramePlan) => ({ ...plan, draws: plan.draws.filter((draw) => draw.type !== 'tiles') }));
  return { setLabel(label) { if (element) element.textContent = label; } };
};

export async function pluginConsumer(): Promise<void> {
  const map = await createMap(null, { renderer: { primary: 'none' }, plugins: [plugin] });
  const use = map.use;
  const installed = use(plugin);
  installed.api.setLabel('hello');
  // @ts-expect-error plugin API arguments survive inference
  installed.api.setLabel(42);
  // @ts-expect-error plugins do not expose unrelated API methods
  installed.api.missing();
  // @ts-expect-error plugin setup requires a function, not a class/descriptor
  map.use({ install() {} });
  const renderer: CustomRenderer = {
    async render(frame) { const plan: FramePlan = frame.plan; void plan; },
    async pick() { return []; },
  };
  // INPUT-09/FULLSCREEN: the built-in plugins keep their APIs through the published declarations.
  const guard = use(gestureGuard({
    modifier: 'control',
    touchPointers: 2,
    onChange: (state) => { const unlocked: boolean = state.unlocked; void unlocked; },
  }));
  const guardApi: GestureGuardApi = guard.api;
  const modifier: GestureModifier = guardApi.modifier;
  guardApi.setModifier('meta');
  guardApi.unlock();
  guardApi.lock();
  void modifier;
  // @ts-expect-error the modifier is one of the declared keys
  gestureGuard({ modifier: 'hyper' });
  const fullscreen = use(fullscreenMode({ control: { position: 'top-right' } }));
  const fullscreenApi: FullscreenApi = fullscreen.api;
  const target: HTMLElement | null = fullscreenApi.element();
  const entering: Promise<boolean> = fullscreenApi.enter();
  void target;
  void entering;
  void fullscreenApi.toggle();
  // @ts-expect-error the corner must be a control position
  fullscreenMode({ control: { position: 'center' } });
  guard.remove();
  fullscreen.remove();
  const restore = map.render.use(renderer);
  restore(); installed.remove(); map.destroy();
}
