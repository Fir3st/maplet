/**
 * Bounded HTML controls (UI-01..UI-04): zoom buttons honouring the view limits,
 * a layer toggle list, the attribution notice and the scale line.
 *
 * Controls never keep a second model: every control renders from engine state
 * (the scene emits `commit`/`viewchange`) and all actions call the same public
 * APIs as programmatic use. Elements are plain DOM with inline styles — no
 * stylesheet or dependency is injected — and pointer/wheel events do not
 * propagate to the map gestures.
 */

import { MapletError } from '../api/errors.ts';
import type { FeatureRef, FeatureSnapshot } from '../api/types.ts';
import { geographicScale, planarScale } from './scale.ts';

export type ControlKind = 'zoom' | 'attribution' | 'scale' | 'layers' | 'list';
export type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface ListControlOptions {
  /** Restrict the bounded result list to these sources. */
  readonly sources?: readonly string[];
  /** Maximum rendered entries (default 10, clamped to 1..50 — never one button per feature). */
  readonly limit?: number;
  readonly label?: (feature: FeatureSnapshot) => string;
  readonly onSelect?: (feature: FeatureSnapshot) => void;
}

export interface ControlSpec {
  readonly id?: string;
  readonly kind: ControlKind;
  readonly position?: ControlPosition;
  /** Options of the `list` control; ignored by the other kinds. */
  readonly options?: ListControlOptions;
}

export interface ControlLayerEntry {
  readonly id: string;
  readonly kind: 'layer';
  /** Human-readable label; falls back to the id. */
  readonly label: string;
  readonly visible: boolean;
}

/** Engine access used by controls; implemented in map.ts from the scene/view. */
export interface ControlsContext {
  readonly zoom: {
    get(): { readonly zoom: number; readonly minZoom: number; readonly maxZoom: number };
    stepBy(delta: number): void;
  };
  readonly layers: {
    list(): readonly ControlLayerEntry[];
    setVisible(id: string, visible: boolean): void;
  };
  readonly attributions: {
    list(): readonly string[];
  };
  readonly view: {
    get(): {
      readonly zoom: number;
      readonly centerLat: number;
      readonly positionKind: 'geographic' | 'planar';
    };
  };
  /** Bounded result source of the accessible list (current view, capped). */
  readonly results: {
    list(options: ListControlOptions): readonly FeatureSnapshot[];
  };
  readonly selection: {
    list(): readonly FeatureRef[];
    set(refs: readonly FeatureRef[]): void;
  };
  /** Subscribes to view and data changes; returns an unsubscribe function. */
  onChange(fn: () => void): () => void;
}

export interface ControlHandle {
  readonly id: string;
  readonly kind: ControlKind;
  element(): HTMLElement;
  remove(): void;
}

interface ManagedControl {
  readonly id: string;
  readonly kind: ControlKind;
  readonly element: HTMLElement;
  readonly update: () => void;
}

const DEFAULT_POSITION: Record<ControlKind, ControlPosition> = {
  zoom: 'top-left',
  layers: 'top-right',
  list: 'top-right',
  scale: 'bottom-left',
  attribution: 'bottom-right',
};

const CORNER_OFFSET: Record<ControlPosition, string> = {
  'top-left': 'top:10px;left:10px;align-items:flex-start;',
  'top-right': 'top:10px;right:10px;align-items:flex-end;',
  'bottom-left': 'bottom:10px;left:10px;align-items:flex-start;',
  'bottom-right': 'bottom:10px;right:10px;align-items:flex-end;',
};

const BLOCKED_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel', 'contextmenu'];

/** Owns the overlay corners and the control instances of one map container. */
export class ControlsHost {
  private readonly corners = new Map<ControlPosition, HTMLElement>();
  private readonly controls = new Map<string, ManagedControl>();
  private readonly context: ControlsContext;
  private readonly container: HTMLElement;
  private root: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private restorePosition: (() => void) | null = null;
  private nextId = 1;

  constructor(container: HTMLElement, context: ControlsContext) {
    this.container = container;
    this.context = context;
  }

  add(spec: ControlSpec): ControlHandle {
    const id = spec.id ?? `${spec.kind}-${this.nextId++}`;
    if (this.controls.has(id)) {
      throw new MapletError('invalid-argument', `a control with id "${id}" already exists`, { id });
    }
    this.ensureRoot();
    const position = spec.position ?? DEFAULT_POSITION[spec.kind];
    const element = document.createElement('div');
    element.dataset.mapletControl = spec.kind;
    element.dataset.mapletControlId = id;
    for (const type of BLOCKED_EVENTS) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }
    const update = buildContent(spec, element, this.context);
    // Pointer events must be enabled *after* building the content: every builder
    // replaces `style.cssText`, and `pointer-events` is inherited from the
    // overlay root (`none`) — setting it earlier would be wiped out and the
    // whole overlay would silently become click-through.
    element.style.pointerEvents = 'auto';
    this.corner(position).appendChild(element);
    const managed: ManagedControl = { id, kind: spec.kind, element, update };
    this.controls.set(id, managed);
    update();
    return {
      id,
      kind: spec.kind,
      element: () => element,
      remove: () => this.remove(id),
    };
  }

  get(id: string): ControlHandle | undefined {
    const managed = this.controls.get(id);
    if (!managed) return undefined;
    return {
      id: managed.id,
      kind: managed.kind,
      element: () => managed.element,
      remove: () => this.remove(managed.id),
    };
  }

  list(): readonly ControlHandle[] {
    return [...this.controls.keys()].map((id) => this.get(id)!);
  }

  has(id: string): boolean {
    return this.controls.has(id);
  }

  remove(id: string): void {
    const managed = this.controls.get(id);
    if (!managed) return;
    managed.element.remove();
    this.controls.delete(id);
    for (const [position, corner] of this.corners) {
      if (corner.childElementCount === 0) {
        corner.remove();
        this.corners.delete(position);
      }
    }
    if (this.controls.size === 0) this.release();
  }

  destroy(): void {
    for (const control of this.controls.values()) control.element.remove();
    this.controls.clear();
    this.release();
  }

  /**
   * The overlay (and its updates) exists only while a control is added: a map
   * without controls injects no extra DOM and listens to no events (TEXT-08).
   */
  private ensureRoot(): void {
    if (this.root) return;
    if (getComputedStyle(this.container).position === 'static') {
      const previous = this.container.style.position;
      this.container.style.position = 'relative';
      this.restorePosition = () => {
        this.container.style.position = previous;
      };
    }
    const root = document.createElement('div');
    root.className = 'maplet-ui';
    root.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
    this.container.appendChild(root);
    this.root = root;
    this.unsubscribe = this.context.onChange(() => {
      for (const control of this.controls.values()) control.update();
    });
  }

  private release(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const corner of this.corners.values()) corner.remove();
    this.corners.clear();
    this.root?.remove();
    this.root = null;
    this.restorePosition?.();
    this.restorePosition = null;
  }

  private corner(position: ControlPosition): HTMLElement {
    let corner = this.corners.get(position);
    if (!corner) {
      corner = document.createElement('div');
      corner.dataset.mapletCorner = position;
      corner.style.cssText = `position:absolute;display:flex;flex-direction:column;gap:8px;pointer-events:none;${CORNER_OFFSET[position]}`;
      this.root!.appendChild(corner);
      this.corners.set(position, corner);
    }
    return corner;
  }
}

/** Builds one control's DOM and returns its state-driven update function. */
function buildContent(
  spec: ControlSpec,
  element: HTMLElement,
  context: ControlsContext,
): () => void {
  switch (spec.kind) {
    case 'zoom':
      return buildZoom(element, context);
    case 'layers':
      return buildLayers(element, context);
    case 'attribution':
      return buildAttribution(element, context);
    case 'scale':
      return buildScale(element, context);
    case 'list':
      return buildList(element, context, spec.options ?? {});
  }
}

function buildZoom(element: HTMLElement, context: ControlsContext): () => void {
  element.style.cssText =
    'display:flex;flex-direction:column;background:#ffffff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.35);overflow:hidden;';
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.dataset.action = 'in';
  zoomIn.textContent = '+';
  zoomIn.setAttribute('aria-label', 'Zoom in');
  zoomIn.title = 'Zoom in';
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.dataset.action = 'out';
  zoomOut.textContent = '−';
  zoomOut.setAttribute('aria-label', 'Zoom out');
  zoomOut.title = 'Zoom out';
  for (const button of [zoomIn, zoomOut]) {
    button.style.cssText =
      'width:34px;height:34px;border:0;background:#ffffff;color:#111827;font:20px/1 system-ui,sans-serif;cursor:pointer;padding:0;';
  }
  zoomOut.style.borderTop = '1px solid #e5e7eb';
  zoomIn.addEventListener('click', () => context.zoom.stepBy(1));
  zoomOut.addEventListener('click', () => context.zoom.stepBy(-1));
  element.append(zoomIn, zoomOut);
  return () => {
    const state = context.zoom.get();
    zoomIn.disabled = state.zoom >= state.maxZoom - 1e-9;
    zoomOut.disabled = state.zoom <= state.minZoom + 1e-9;
  };
}

function buildLayers(element: HTMLElement, context: ControlsContext): () => void {
  element.style.cssText =
    'background:#ffffff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.25);padding:6px 8px;font:12px/1.6 system-ui,sans-serif;color:#111827;min-width:120px;';
  const rows = new Map<string, { row: HTMLElement; checkbox: HTMLInputElement }>();
  return () => {
    const entries = context.layers.list();
    const keys = new Set(entries.map((entry) => `${entry.kind}:${entry.id}`));
    for (const [key, row] of rows) {
      if (!keys.has(key)) {
        row.row.remove();
        rows.delete(key);
      }
    }
    entries.forEach((entry, index) => {
      const key = `${entry.kind}:${entry.id}`;
      let row = rows.get(key);
      if (!row) {
        const label = document.createElement('label');
        label.style.cssText =
          'display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.layerId = entry.id;
        checkbox.addEventListener('change', () =>
          context.layers.setVisible(entry.id, checkbox.checked),
        );
        const text = document.createElement('span');
        text.textContent = entry.label;
        label.append(checkbox, text);
        row = { row: label, checkbox };
        rows.set(key, row);
      }
      // In-place sync keeps DOM nodes stable (focus and external references).
      row.checkbox.checked = entry.visible;
      if (element.children[index] !== row.row) {
        element.insertBefore(row.row, element.children[index] ?? null);
      }
    });
    element.style.display = entries.length > 0 ? 'block' : 'none';
  };
}

function buildAttribution(element: HTMLElement, context: ControlsContext): () => void {
  element.style.cssText =
    'background:rgba(255,255,255,.85);color:#111827;border-radius:3px;padding:2px 6px;font:11px/1.5 system-ui,sans-serif;max-width:60vw;';
  let signature: string | null = null;
  return () => {
    const text = context.attributions.list().join(' | ');
    if (text === signature) return;
    signature = text;
    // Attribution strings are rendered as text, never as active HTML.
    element.textContent = text;
    element.style.display = text ? 'block' : 'none';
  };
}

function buildScale(element: HTMLElement, context: ControlsContext): () => void {
  element.style.cssText =
    'background:rgba(255,255,255,.85);color:#111827;border-radius:3px;padding:2px 6px;font:11px/1.4 system-ui,sans-serif;';
  const label = document.createElement('div');
  label.style.cssText = 'text-align:center;margin-bottom:2px;';
  const bar = document.createElement('div');
  bar.style.cssText =
    'border:2px solid #374151;border-top:none;height:6px;box-sizing:border-box;margin:0 auto;';
  element.append(label, bar);
  let signature = '\u0000';
  return () => {
    const view = context.view.get();
    const step =
      view.positionKind === 'geographic'
        ? geographicScale(view.zoom, view.centerLat)
        : planarScale(view.zoom);
    const next = `${step.label}:${step.widthPx.toFixed(2)}`;
    if (next === signature) return;
    signature = next;
    label.textContent = step.label;
    bar.style.width = `${step.widthPx.toFixed(2)}px`;
  };
}

/**
 * Bounded accessible result list (UI-08): at most `limit` natively focusable
 * buttons for the features in the current view — never one element per feature.
 * Selection mirrors `map.selection` in both directions and changes are
 * announced through an `aria-live` region.
 */
function buildList(
  element: HTMLElement,
  context: ControlsContext,
  options: ListControlOptions,
): () => void {
  element.style.cssText =
    'background:#ffffff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.25);padding:6px 8px;font:12px/1.6 system-ui,sans-serif;color:#111827;max-height:38vh;overflow:auto;max-width:240px;';
  const list = document.createElement('ul');
  list.setAttribute('aria-label', 'Map results');
  list.style.cssText =
    'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;';
  const live = document.createElement('div');
  live.setAttribute('aria-live', 'polite');
  live.dataset.mapletAnnounce = 'true';
  live.style.cssText =
    'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
  element.append(list, live);
  const rows = new Map<string, { item: HTMLElement; button: HTMLButtonElement }>();
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  let announced: string | null = null;
  const labelOf = (feature: FeatureSnapshot): string =>
    options.label ? options.label(feature) : featureLabel(feature);
  return () => {
    const entries = context.results.list({ ...options, limit });
    const selectedKeys = new Set(context.selection.list().map(refKey));
    const keys = new Set(entries.map((entry) => refKey(entry.ref)));
    for (const [key, row] of rows) {
      if (!keys.has(key)) {
        row.item.remove();
        rows.delete(key);
      }
    }
    entries.forEach((entry, index) => {
      const key = refKey(entry.ref);
      let row = rows.get(key);
      if (!row) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.featureKey = key;
        button.style.cssText =
          'border:0;background:transparent;color:#1d4ed8;font:inherit;text-align:left;cursor:pointer;padding:2px 4px;border-radius:3px;text-decoration:underline;';
        button.addEventListener('click', () => {
          context.selection.set([entry.ref]);
          options.onSelect?.(entry);
        });
        item.appendChild(button);
        row = { item, button };
        rows.set(key, row);
      }
      const label = labelOf(entry);
      if (row.button.textContent !== label) row.button.textContent = label;
      row.button.setAttribute('aria-pressed', selectedKeys.has(key) ? 'true' : 'false');
      if (list.children[index] !== row.item) {
        list.insertBefore(row.item, list.children[index] ?? null);
      }
    });
    element.style.display = entries.length > 0 ? 'block' : 'none';
    const selectedLabels = entries
      .filter((entry) => selectedKeys.has(refKey(entry.ref)))
      .map(labelOf);
    const nextAnnounce = `${context.selection.list().length} selected${
      selectedLabels.length > 0 ? `: ${selectedLabels.join(', ')}` : ''
    }`;
    if (announced !== null && nextAnnounce !== announced) live.textContent = nextAnnounce;
    announced = nextAnnounce;
  };
}

function refKey(ref: FeatureRef): string {
  return `${ref.sourceId}:${typeof ref.id}:${String(ref.id)}:${ref.generation ?? 0}`;
}

function featureLabel(feature: FeatureSnapshot): string {
  const name = feature.properties['name'];
  if (typeof name === 'string' && name.length > 0) return name;
  return String(feature.ref.id);
}
