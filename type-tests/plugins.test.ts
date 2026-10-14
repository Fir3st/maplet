import { createMap, type Plugin, type PluginContext, type FramePlan, type CustomRenderer } from '@fir3st/maplet';

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
  const restore = map.render.use(renderer);
  restore(); installed.remove(); map.destroy();
}
