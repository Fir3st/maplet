/**
 * HTML feature detail (UI-05/UI-06).
 *
 * A detail is bound to one generation-checked feature reference and is
 * independent of the drawing objects: it re-renders from current data on
 * `commit`/`viewchange`, follows the feature's representative position, closes
 * (or freezes, per policy) when the feature disappears, and can never show a
 * new generation of the same id — the stale reference stops resolving.
 *
 * Content contract (UI-06): a string is rendered as **text** (never parsed as
 * active HTML); a factory may return an explicit `Node`, which is appended
 * as-is by the caller's contract. A throwing factory renders a safe text error.
 */

import type { FeatureRef, FeatureSnapshot, Geometry, Position, ScreenPoint } from '../api/types.ts';

export type DetailContentFactory = (feature: FeatureSnapshot) => string | Node;
export type DetailContent = string | DetailContentFactory;

export interface DetailOptions {
  readonly content: DetailContent;
  /** What happens when the feature disappears or its generation changes. */
  readonly policy?: { readonly onRemoved?: 'close' | 'retain' };
  /** Fixed anchor; by default the detail follows the feature position. */
  readonly anchor?: Position;
}

export interface DetailHandle {
  readonly ref: FeatureRef;
  readonly open: boolean;
  element(): HTMLElement | null;
  update(): void;
  close(): void;
}

export interface DetailContext {
  readonly container: HTMLElement;
  /** Generation-checked snapshot; `null` when removed or stale. */
  snapshotOf(ref: FeatureRef): FeatureSnapshot | null;
  screenOf(position: Position): ScreenPoint;
  onChange(fn: () => void): () => void;
}

/** Anchor used to place a detail for a geometry (point, line middle, ring start…). */
export function representativePosition<P extends Position>(geometry: Geometry<P>): Position | null {
  switch (geometry.type) {
    case 'point':
      return geometry.position;
    case 'multiPoint':
      return geometry.positions[0] ?? null;
    case 'lineString':
      return geometry.positions[Math.floor(geometry.positions.length / 2)] ?? null;
    case 'multiLineString': {
      const line = geometry.lines[0];
      return line ? (line[Math.floor(line.length / 2)] ?? null) : null;
    }
    case 'polygon': {
      const ring = geometry.rings[0];
      return ring?.[0] ?? null;
    }
    case 'multiPolygon': {
      const ring = geometry.polygons[0]?.[0];
      return ring?.[0] ?? null;
    }
    case 'circle':
      return geometry.center;
    case 'rectangle': {
      const sw = geometry.southwest;
      const ne = geometry.northeast;
      if (isGeo(sw) && isGeo(ne)) {
        return { lat: (sw.lat + ne.lat) / 2, lng: (sw.lng + ne.lng) / 2 };
      }
      if (isPlanar(sw) && isPlanar(ne)) {
        return { x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2 };
      }
      return null;
    }
    default:
      return null;
  }
}

function isGeo(position: Position): position is Position & { lat: number; lng: number } {
  return 'lat' in position;
}

function isPlanar(position: Position): position is Position & { x: number; y: number } {
  return 'x' in position;
}

interface ManagedDetail {
  readonly ref: FeatureRef;
  readonly options: DetailOptions;
  readonly element: HTMLElement;
  readonly contentHost: HTMLElement;
  open: boolean;
  removedMarker: boolean;
}

export class DetailController {
  private managed: ManagedDetail | null = null;
  private readonly context: DetailContext;
  private readonly unsubscribe: () => void;

  constructor(context: DetailContext) {
    this.context = context;
    this.unsubscribe = context.onChange(() => this.update());
  }

  open(ref: FeatureRef, options: DetailOptions): DetailHandle {
    this.close();
    const element = document.createElement('div');
    element.dataset.mapletDetail = 'true';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Feature detail');
    element.style.cssText =
      'position:absolute;left:0;top:0;transform:translate(-50%,-100%);z-index:20;pointer-events:auto;' +
      'background:#ffffff;color:#111827;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.35);' +
      'padding:8px 24px 8px 10px;font:12px/1.5 system-ui,sans-serif;max-width:260px;';
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', 'Close detail');
    closeButton.style.cssText =
      'position:absolute;right:4px;top:2px;border:0;background:transparent;color:#374151;font:16px/1 system-ui,sans-serif;cursor:pointer;padding:2px 4px;';
    closeButton.addEventListener('click', () => this.close());
    const contentHost = document.createElement('div');
    contentHost.dataset.detailContent = 'true';
    element.append(contentHost, closeButton);
    this.context.container.appendChild(element);
    const managed: ManagedDetail = {
      ref,
      options,
      element,
      contentHost,
      open: true,
      removedMarker: false,
    };
    this.managed = managed;
    this.update();
    return this.handle(managed);
  }

  current(): DetailHandle | null {
    return this.managed ? this.handle(this.managed) : null;
  }

  update(): void {
    const managed = this.managed;
    if (!managed || !managed.open) return;
    const snapshot = this.context.snapshotOf(managed.ref);
    if (snapshot) {
      managed.element.dataset.removed = 'false';
      this.renderContent(managed, snapshot);
      const position =
        managed.options.anchor ?? representativePosition(snapshot.geometry as Geometry);
      if (position) this.place(managed.element, this.context.screenOf(position));
      return;
    }
    const policy = managed.options.policy?.onRemoved ?? 'close';
    if (policy === 'close') {
      this.close();
      return;
    }
    // `retain`: freeze the last content and mark the detail as removed.
    if (!managed.removedMarker) {
      managed.removedMarker = true;
      managed.element.dataset.removed = 'true';
      const marker = document.createElement('div');
      marker.dataset.detailRemoved = 'true';
      marker.style.cssText = 'margin-top:4px;color:#b91c1c;font-weight:600;';
      marker.textContent = 'feature was removed';
      managed.contentHost.appendChild(marker);
    }
  }

  close(): void {
    if (!this.managed) return;
    this.managed.open = false;
    this.managed.element.remove();
    this.managed = null;
  }

  destroy(): void {
    this.close();
    this.unsubscribe();
  }

  private renderContent(managed: ManagedDetail, snapshot: FeatureSnapshot): void {
    managed.contentHost.replaceChildren();
    const content = managed.options.content;
    try {
      const result = typeof content === 'string' ? content : content(snapshot);
      if (typeof result === 'string') {
        // UI-06: text input stays text; it is never parsed into active HTML.
        const text = document.createElement('div');
        text.textContent = result;
        managed.contentHost.appendChild(text);
      } else {
        // Explicit DOM contract: the caller-supplied node is appended as-is.
        managed.contentHost.appendChild(result);
      }
    } catch (error) {
      const text = document.createElement('div');
      text.dataset.detailError = 'true';
      text.textContent = `Detail content failed: ${String(error)}`;
      managed.contentHost.appendChild(text);
    }
  }

  private place(element: HTMLElement, screen: ScreenPoint): void {
    const rect = this.context.container.getBoundingClientRect();
    const width = element.offsetWidth || 120;
    const height = element.offsetHeight || 40;
    const x = Math.min(
      Math.max(screen.x, width / 2 + 6),
      Math.max(rect.width - width / 2 - 6, width / 2 + 6),
    );
    const y = Math.min(Math.max(screen.y - 10, height + 6), Math.max(rect.height - 6, height + 6));
    element.style.left = `${Math.round(x)}px`;
    element.style.top = `${Math.round(y)}px`;
  }

  private handle(managed: ManagedDetail): DetailHandle {
    return {
      ref: managed.ref,
      get open() {
        return managed.open;
      },
      element: () => (managed.open ? managed.element : null),
      update: () => this.update(),
      close: () => {
        if (this.managed === managed) this.close();
        else {
          managed.open = false;
          managed.element.remove();
        }
      },
    };
  }
}
