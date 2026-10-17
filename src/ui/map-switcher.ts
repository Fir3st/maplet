/**
 * Multiple map views in one host with an accessible tab switcher.
 *
 * Each entry owns an independent map. The switcher builds the tab bar and one
 * panel per entry, creates a map on its first activation and keeps it alive, so
 * switching preserves the view, layer visibility, selection and every
 * subscription. Inactive panels stay laid out (`visibility`, not `display`),
 * which avoids resize churn and lets a lazily created map measure its real
 * panel size before its first frame.
 */

import { assertArgument, fail } from '../api/errors.ts';
import { isArrayValue, type Unsubscribe } from '../api/types.ts';
import { createMap, type MapHandle, type MapOptions } from '../map.ts';

export interface MapSwitcherEntry {
  readonly id: string;
  /** Visible tab label; also names the panel for assistive technology. */
  readonly label: string;
  /** Options passed to createMap on first activation. */
  readonly options?: MapOptions;
}

export interface MapSwitcherOptions {
  readonly container: HTMLElement | string;
  readonly maps: readonly MapSwitcherEntry[];
  /** Initially active entry; defaults to the first one. */
  readonly initial?: string;
  /** Accessible name of the tab list; defaults to `Map views`. */
  readonly label?: string;
}

export interface MapSwitcherHandle {
  readonly activeId: string;
  readonly ids: readonly string[];
  /** The created map for an entry, or undefined until its first activation. */
  get(id: string): MapHandle | undefined;
  /** Activates an entry and creates its map on first use. */
  show(id: string): Promise<MapHandle>;
  /** Notified when the active entry changes and its map is available. */
  onChange(fn: (id: string) => void): Unsubscribe;
  destroy(): void;
}

interface EntryState {
  readonly id: string;
  readonly options: MapOptions;
  readonly tab: HTMLButtonElement;
  readonly panel: HTMLElement;
}

let switcherSequence = 0;

export async function createMapSwitcher(options: MapSwitcherOptions): Promise<MapSwitcherHandle> {
  assertArgument(
    options !== null && typeof options === 'object',
    'createMapSwitcher expects an options object',
  );
  const entries = options.maps;
  assertArgument(
    isArrayValue(entries) && entries.length > 0,
    'createMapSwitcher requires at least one map entry',
  );
  const ids = new Set<string>();
  for (const entry of entries) {
    assertArgument(entry !== null && typeof entry === 'object', 'each map entry must be an object');
    assertArgument(
      typeof entry.id === 'string' && entry.id.length > 0,
      'each map entry requires a nonempty id',
    );
    assertArgument(!ids.has(entry.id), `duplicate map entry id: ${entry.id}`, { id: entry.id });
    ids.add(entry.id);
    assertArgument(
      typeof entry.label === 'string' && entry.label.trim().length > 0,
      `map entry ${entry.id} requires a nonempty label`,
      { id: entry.id },
    );
  }
  const initial = options.initial ?? entries[0]!.id;
  assertArgument(ids.has(initial), `unknown initial map entry: ${initial}`, { initial });
  assertArgument(
    options.container !== undefined &&
      (typeof options.container === 'string' ||
        (typeof options.container === 'object' &&
          typeof options.container?.appendChild === 'function')),
    'createMapSwitcher requires a container element or id',
  );
  if (typeof document === 'undefined') {
    fail('environment', 'createMapSwitcher requires a browser environment');
  }
  const host =
    typeof options.container === 'string'
      ? resolveSwitcherContainer(options.container)
      : options.container;

  const prefix = `maplet-switcher-${++switcherSequence}`;
  const root = document.createElement('div');
  root.dataset.mapletSwitcher = '';
  root.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;min-height:0;';
  const bar = document.createElement('div');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', options.label ?? 'Map views');
  bar.dataset.mapletSwitcherTabs = '';
  bar.style.cssText =
    'display:flex;align-items:center;gap:4px;padding:6px 8px;background:#f1f5f9;border-bottom:1px solid #e2e8f0;font:12px/1.4 system-ui,sans-serif;overflow-x:auto;flex:none;';
  const stack = document.createElement('div');
  stack.dataset.mapletSwitcherPanels = '';
  stack.style.cssText = 'position:relative;flex:1;min-height:0;';
  root.append(bar, stack);

  const states: EntryState[] = entries.map((entry, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `${prefix}-tab-${index + 1}`;
    tab.dataset.mapletSwitcherTab = entry.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `${prefix}-panel-${index + 1}`);
    tab.textContent = entry.label;
    tab.style.cssText =
      'border:0;border-radius:6px;background:transparent;color:#475569;padding:6px 10px;font:inherit;cursor:pointer;white-space:nowrap;';
    tab.addEventListener('focus', () => {
      tab.style.outline = '2px solid #2563eb';
      tab.style.outlineOffset = '1px';
    });
    tab.addEventListener('blur', () => {
      tab.style.outline = 'none';
    });
    const panel = document.createElement('div');
    panel.id = `${prefix}-panel-${index + 1}`;
    panel.dataset.mapletSwitcherPanel = entry.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.setAttribute('aria-hidden', 'true');
    panel.style.cssText = 'position:absolute;inset:0;visibility:hidden;pointer-events:none;';
    bar.append(tab);
    stack.append(panel);
    return { id: entry.id, options: entry.options ?? {}, tab, panel };
  });
  if (states.length === 1) bar.style.display = 'none';
  host.append(root);

  let activeId = initial;
  let destroyed = false;
  const maps = new Map<string, MapHandle>();
  const creating = new Map<string, Promise<MapHandle>>();
  const listeners = new Set<(id: string) => void>();

  const paint = (state: EntryState, active: boolean): void => {
    state.tab.setAttribute('aria-selected', String(active));
    state.tab.tabIndex = active ? 0 : -1;
    state.tab.style.background = active ? '#ffffff' : 'transparent';
    state.tab.style.color = active ? '#0f172a' : '#475569';
    state.tab.style.boxShadow = active ? '0 1px 2px rgba(15,23,42,.14)' : 'none';
    state.panel.style.visibility = active ? 'visible' : 'hidden';
    state.panel.style.pointerEvents = active ? 'auto' : 'none';
    if (active) state.panel.removeAttribute('aria-hidden');
    else state.panel.setAttribute('aria-hidden', 'true');
  };
  const activate = (id: string): void => {
    activeId = id;
    for (const state of states) paint(state, state.id === id);
  };
  const notify = (id: string): void => {
    for (const fn of [...listeners]) fn(id);
  };
  const show = async (id: string): Promise<MapHandle> => {
    if (destroyed) fail('destroyed', 'the map switcher has been destroyed');
    const state = states.find((candidate) => candidate.id === id);
    if (!state) fail('not-found', `map entry not found: ${id}`, { id });
    const changed = activeId !== id;
    activate(id);
    const existing = maps.get(id);
    if (existing) {
      if (changed) notify(id);
      return existing;
    }
    let pending = creating.get(id);
    if (!pending) {
      pending = createMap(state.panel, state.options).then(
        (map) => {
          creating.delete(id);
          if (destroyed) {
            map.destroy();
            fail('destroyed', 'the map switcher has been destroyed');
          }
          maps.set(id, map);
          return map;
        },
        (error: unknown) => {
          creating.delete(id);
          throw error;
        },
      );
      creating.set(id, pending);
    }
    const map = await pending;
    if (changed && activeId === id) notify(id);
    return map;
  };
  for (const state of states) {
    state.tab.addEventListener('click', () => {
      void show(state.id);
    });
    state.tab.addEventListener('keydown', (event) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const index = states.indexOf(state);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? states.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + states.length) % states.length;
      const target = states[next]!;
      target.tab.focus();
      void show(target.id);
    });
  }
  activate(initial);

  const handle: MapSwitcherHandle = {
    get activeId() {
      return activeId;
    },
    ids: states.map((state) => state.id),
    get: (id) => maps.get(id),
    show,
    onChange: (fn) => {
      assertArgument(typeof fn === 'function', 'onChange expects a function');
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const map of maps.values()) {
        if (!map.destroyed) map.destroy();
      }
      maps.clear();
      listeners.clear();
      root.remove();
    },
  };

  try {
    await show(initial);
  } catch (error) {
    handle.destroy();
    throw error;
  }
  return handle;
}

function resolveSwitcherContainer(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) fail('invalid-argument', `container element not found: #${id}`, { container: id });
  return element;
}
