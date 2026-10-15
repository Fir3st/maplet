/**
 * Leaflet-style markers (MARKER-01..08): a pin at a position with a tooltip and
 * a popup.
 *
 * A marker is one point feature in a shared internal points layer, drawn as a
 * GPU sprite from the icon atlas — there is no DOM element per marker. The
 * tooltip and popup are bounded DOM overlays (the same pattern as the feature
 * detail): one popup per map at a time and one element per open tooltip,
 * positioned in the map container and re-placed on view and commit changes.
 *
 * Content follows the UI-06 contract: a string renders as **text** (never
 * parsed as active HTML); a caller-supplied `Node` is appended as-is.
 */

import { fail } from '../api/errors.ts';
import { featureEvents, type FeatureEvents } from '../api/feature-events.ts';
import type { PositionInput } from '../api/coordinates.ts';
import type { PointHandle, PointsLayerHandle } from '../api/objects.ts';
import {
  featureRefKey,
  type Commit,
  type FeatureId,
  type FeatureProperties,
  type FeatureRef,
  type MapFeatureEvent,
  type PointGeometry,
  type Position,
  type ScreenPoint,
  type Unsubscribe,
} from '../api/types.ts';
import type { MapEngine } from '../map-engine.ts';
import type { ColorValue } from '../scene/expression.ts';
import type { FeatureOverride, PointsLayerStyle } from '../scene/layers.ts';

/** Built-in pin asset id; replace it by registering your own asset id instead. */
export const MARKER_PIN_ICON_ID = 'maplet-marker-pin';
/** Default square sprite size in CSS px (matches the built-in pin artwork). */
export const DEFAULT_MARKER_SIZE = 32;
/** Default sprite centre offset: the pin tip sits on the marker position. */
export const DEFAULT_MARKER_ANCHOR = { x: 0, y: -16 } as const;

/**
 * Built-in pin artwork: one flat teardrop with a white rim and an inner dot.
 * The rim is what keeps the marker readable on a busy basemap and separates
 * overlapping pins; the tip sits at the bottom of the box so the default
 * `iconAnchor` puts it on the feature position.
 */
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<path d="M16 31.2C13.9 27.1 6.7 20.6 6.7 12.2A9.3 9.3 0 1 1 25.3 12.2C25.3 20.6 18.1 27.1 16 31.2Z" fill="#2563eb" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>' +
  '<circle cx="16" cy="12.2" r="3.7" fill="#ffffff"/></svg>';
/** Ready-to-register data URL of the default pin. */
export const MARKER_PIN_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(PIN_SVG);

/** Style of the shared internal marker layer (per-marker options override it). */
export const MARKER_LAYER_STYLE: PointsLayerStyle = {
  icon: MARKER_PIN_ICON_ID,
  iconSize: DEFAULT_MARKER_SIZE,
  iconAnchor: { ...DEFAULT_MARKER_ANCHOR },
  radiusPx: 6,
  color: '#2563eb',
  // A pin is a UI object, not a data layer: it stays visible at every zoom,
  // including the negative zooms planar maps can use (MARKER-01).
  minZoom: -Infinity,
};

/** Tooltip or popup content: a string renders as text, a `Node` as-is. */
export type MarkerContent = string | Node;

export interface MarkerTooltipOptions {
  /** Keep the tooltip visible without hover (`openTooltip`/`closeTooltip`). */
  readonly permanent?: boolean;
  /**
   * Bottom-centre offset from the marker position; the default sits just above
   * the icon (derived from `iconSize`/`iconAnchor`).
   */
  readonly offsetPx?: { readonly x: number; readonly y: number };
}

export interface MarkerPopupOptions {
  /** Bottom-centre offset from the marker position; default above the icon. */
  readonly offsetPx?: { readonly x: number; readonly y: number };
  /** Pan the map so the popup fits the container; default true (Leaflet parity). */
  readonly autoPan?: boolean;
}

export interface MarkerTooltipInit extends MarkerTooltipOptions {
  readonly content: MarkerContent;
}

export interface MarkerPopupInit extends MarkerPopupOptions {
  readonly content: MarkerContent;
}

export interface MarkerOptions<P = FeatureProperties> {
  readonly id?: FeatureId;
  readonly position: PositionInput;
  /** Registered image asset id; default is the built-in pin. */
  readonly icon?: string;
  /** Square sprite size in CSS px; default 32. Non-square artwork is stretched. */
  readonly iconSize?: number;
  /** Sprite centre offset; default `{ x: 0, y: -16 }` (tip on the position). */
  readonly iconAnchor?: { readonly x: number; readonly y: number };
  /** RGBA multiplier over the icon texture; default white (no tint). */
  readonly iconTint?: ColorValue;
  readonly properties?: P;
  /** Hover tooltip by default; pass an init object for a permanent tooltip. */
  readonly tooltip?: MarkerTooltipInit | MarkerContent | null;
  /** Click popup (one per map at a time); `null` binds none. */
  readonly popup?: MarkerPopupInit | MarkerContent | null;
}

export interface MarkerHandle<P = FeatureProperties> extends FeatureEvents {
  readonly id: FeatureId;
  readonly ref: FeatureRef<PointGeometry<Position>, P>;
  readonly removed: boolean;
  getPosition(): Position;
  setPosition(position: PositionInput): Commit;
  /** Replace the icon asset; `null` restores the layer default (built-in pin). */
  setIcon(icon: string | null): void;
  /** Bind content (or `null` to unbind); an open tooltip updates in place. */
  setTooltip(tooltip: MarkerTooltipInit | MarkerContent | null): void;
  /** Bind content (or `null` to unbind); an open popup updates in place. */
  setPopup(popup: MarkerPopupInit | MarkerContent | null): void;
  openTooltip(): void;
  closeTooltip(): void;
  openPopup(): void;
  closePopup(): void;
  readonly tooltipOpen: boolean;
  readonly popupOpen: boolean;
  tooltipElement(): HTMLElement | null;
  popupElement(): HTMLElement | null;
  show(): void;
  hide(): void;
  remove(): void;
}

/** True when a value is a tooltip/popup init object rather than plain content. */
export function isMarkerInit(value: unknown): value is MarkerTooltipInit | MarkerPopupInit {
  if (typeof value !== 'object' || value === null || isDomNode(value)) return false;
  return 'content' in value;
}

export function markerTooltip(content: MarkerTooltipInit | MarkerContent): MarkerTooltipInit {
  return isMarkerInit(content) ? (content as MarkerTooltipInit) : { content: content as MarkerContent };
}

export function markerPopup(content: MarkerPopupInit | MarkerContent): MarkerPopupInit {
  return isMarkerInit(content) ? (content as MarkerPopupInit) : { content: content as MarkerContent };
}

function isDomNode(value: object): boolean {
  // DOM-free environments (tests, headless data maps) have no `Node` global.
  return typeof Node !== 'undefined' && value instanceof Node;
}

export interface MarkerRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Minimum on-screen shift so the overlay box and its anchor both fit the
 * viewport with the given margin. Used for popup auto-panning: a positive `dy`
 * moves content down, so the view centre moves up.
 */
export function fitViewportShift(
  rect: MarkerRect,
  anchor: { readonly x: number; readonly y: number },
  viewport: { readonly width: number; readonly height: number },
  margin = 8,
): { dx: number; dy: number } {
  const shift = (min: number, max: number, value: number, size: number): number => {
    if (value < min) return min - value;
    if (value + size > max) return max - (value + size);
    return 0;
  };
  let dx = shift(margin, viewport.width - margin, rect.x, rect.width);
  let dy = shift(margin, viewport.height - margin, rect.y, rect.height);
  // The anchor clamps the shift last, so a box larger than the viewport
  // overflows instead of pushing the marker off-screen.
  dx = Math.min(Math.max(dx, margin - anchor.x), viewport.width - margin - anchor.x);
  dy = Math.min(Math.max(dy, margin - anchor.y), viewport.height - margin - anchor.y);
  return { dx, dy };
}

interface MarkerRecord {
  point: PointHandle<FeatureProperties>;
  icon: string | null;
  iconSize: number | null;
  iconAnchor: { x: number; y: number } | null;
  iconTint: ColorValue | null;
  tooltip: MarkerTooltipInit | null;
  popup: MarkerPopupInit | null;
  tooltipElement: HTMLElement | null;
  tooltipSticky: boolean;
}

interface PopupEntry {
  readonly record: MarkerRecord;
  readonly element: HTMLElement;
  readonly contentHost: HTMLElement;
}

const TEXT_STYLE = 'position:absolute;left:0;top:0;transform:translate(-50%,-100%);';
const POPUP_STYLE =
  'z-index:21;pointer-events:auto;background:#ffffff;color:#111827;border-radius:8px;' +
  'box-shadow:0 3px 14px rgba(0,0,0,.35);padding:10px 28px 10px 12px;' +
  'font:12px/1.5 system-ui,sans-serif;max-width:260px;min-width:72px;';
const TOOLTIP_STYLE =
  'z-index:19;pointer-events:none;background:#111827;color:#f9fafb;border-radius:6px;' +
  'padding:4px 8px;font:12px/1.4 system-ui,sans-serif;max-width:240px;white-space:pre-wrap;' +
  'box-shadow:0 1px 6px rgba(0,0,0,.35);';
const TIP_STYLE =
  'position:absolute;left:50%;bottom:-3px;width:8px;height:8px;margin-left:-4px;' +
  'background:inherit;transform:rotate(45deg);';

/** Marker UI controller: shared GPU layer plus the bounded DOM overlays. */
export class MarkerController {
  private readonly records = new Map<string, MarkerRecord>();
  private readonly openTooltips = new Set<MarkerRecord>();
  private readonly unsubscribes: Unsubscribe[] = [];
  private popup: PopupEntry | null = null;
  private destroyed = false;
  private readonly engine: MapEngine;
  private readonly layer: PointsLayerHandle<FeatureProperties>;
  private readonly container: HTMLElement | null;

  constructor(engine: MapEngine, layer: PointsLayerHandle<FeatureProperties>, container: HTMLElement | null) {
    this.engine = engine;
    this.layer = layer;
    this.container = container;
    this.unsubscribes.push(
      engine.on('feature', (event) => this.onFeature(event)),
      engine.on('pointer', (event) => {
        if (event.type === 'click') this.closePopupElement();
      }),
      engine.on('viewchange', () => this.reposition()),
      engine.on('commit', () => this.reposition()),
      engine.on('destroy', () => this.destroy()),
    );
    // Absolute overlays need a positioned container (Leaflet's stylesheet does
    // the same); only touch a static container, never a positioned one.
    if (container && typeof getComputedStyle === 'function' && getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
  }

  add<P = FeatureProperties>(options: MarkerOptions<P>): MarkerHandle<P> {
    return this.addMany([options])[0]!;
  }

  addMany<P = FeatureProperties>(options: readonly MarkerOptions<P>[]): MarkerHandle<P>[] {
    if (this.destroyed || this.layer.removed) fail('destroyed', 'the marker layer has been removed');
    return options.map((option) => {
      const input = {
        ...(option.id === undefined ? {} : { id: option.id }),
        position: option.position,
        properties: (option.properties ?? {}) as FeatureProperties,
      };
      const point = this.layer.add(input) as unknown as PointHandle<P>;
      const record: MarkerRecord = {
        point: point as unknown as PointHandle<FeatureProperties>,
        icon: option.icon ?? null,
        iconSize: option.iconSize ?? null,
        iconAnchor: option.iconAnchor === undefined ? null : { ...option.iconAnchor },
        iconTint: option.iconTint ?? null,
        tooltip: option.tooltip === null || option.tooltip === undefined ? null : markerTooltip(option.tooltip),
        popup: option.popup === null || option.popup === undefined ? null : markerPopup(option.popup),
        tooltipElement: null,
        tooltipSticky: false,
      };
      this.records.set(featureRefKey(record.point.ref), record);
      this.applyAppearance(record);
      if (record.tooltip?.permanent) this.openTooltipElement(record, true);
      return this.handle(record, point);
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closePopupElement();
    for (const record of [...this.openTooltips]) this.closeTooltipElement(record);
    for (const off of this.unsubscribes.splice(0)) off();
    this.records.clear();
  }

  private handle<P>(record: MarkerRecord, point: PointHandle<P>): MarkerHandle<P> {
    const isPopupOpen = (): boolean => this.popup?.record === record;
    return {
      id: point.id,
      ref: point.ref,
      get removed() { return point.removed; },
      ...featureEvents((fn, options) => point.onFeature(fn, options)),
      getPosition: () => point.getPosition(),
      setPosition: (position) => point.setPosition(position),
      setIcon: (icon) => this.setIcon(record, icon),
      setTooltip: (tooltip) => this.setTooltip(record, tooltip),
      setPopup: (popup) => this.setPopup(record, popup),
      openTooltip: () => {
        if (record.tooltip) this.openTooltipElement(record, true);
      },
      closeTooltip: () => this.closeTooltipElement(record),
      openPopup: () => {
        if (!record.popup || this.popup?.record === record) return;
        this.closePopupElement();
        this.openPopupElement(record);
      },
      closePopup: () => {
        if (this.popup?.record === record) this.closePopupElement();
      },
      get tooltipOpen() { return record.tooltipElement !== null; },
      get popupOpen() { return isPopupOpen(); },
      tooltipElement: () => record.tooltipElement,
      popupElement: () => (this.popup?.record === record ? this.popup.element : null),
      show: () => point.show(),
      hide: () => point.hide(),
      remove: () => this.removeRecord(record),
    };
  }

  private setIcon(record: MarkerRecord, icon: string | null): void {
    this.assertLive(record);
    record.icon = icon;
    this.applyAppearance(record);
  }

  private setTooltip(record: MarkerRecord, value: MarkerTooltipInit | MarkerContent | null): void {
    this.assertLive(record);
    const next = value === null ? null : markerTooltip(value);
    const wasOpen = record.tooltipElement !== null;
    this.closeTooltipElement(record);
    record.tooltip = next;
    if (next && (next.permanent || wasOpen)) this.openTooltipElement(record, next.permanent === true);
  }

  private setPopup(record: MarkerRecord, value: MarkerPopupInit | MarkerContent | null): void {
    this.assertLive(record);
    const next = value === null ? null : markerPopup(value);
    const wasOpen = this.popup?.record === record;
    if (wasOpen) this.closePopupElement();
    record.popup = next;
    if (wasOpen && next) this.openPopupElement(record);
  }

  private removeRecord(record: MarkerRecord): void {
    this.closeTooltipElement(record);
    if (this.popup?.record === record) this.closePopupElement();
    record.point.remove();
    this.records.delete(featureRefKey(record.point.ref));
  }

  private assertLive(record: MarkerRecord): void {
    if (this.destroyed || record.point.removed) fail('destroyed', 'the marker has been removed');
  }

  /** Overrides are rebuilt from scratch so `setIcon(null)` restores defaults. */
  private applyAppearance(record: MarkerRecord): void {
    const applied: FeatureOverride = {
      ...(record.icon === null ? {} : { icon: record.icon }),
      ...(record.iconSize === null ? {} : { iconSize: record.iconSize }),
      ...(record.iconAnchor === null ? {} : { iconAnchor: { ...record.iconAnchor } }),
      ...(record.iconTint === null ? {} : { iconTint: record.iconTint }),
    };
    record.point.clearStyle();
    if (Object.keys(applied).length > 0) record.point.setStyle(applied);
  }

  private onFeature(event: MapFeatureEvent): void {
    if (this.destroyed) return;
    if (event.type === 'click') {
      // Leaflet parity: a click elsewhere closes the open popup, and the
      // clicked marker then opens its own (one popup per map).
      const record = event.layerId === this.layer.id ? this.records.get(featureRefKey(event.feature)) : undefined;
      if (record) {
        if (this.popup?.record === record) return;
        this.closePopupElement();
        if (record.popup) this.openPopupElement(record);
        return;
      }
      this.closePopupElement();
      return;
    }
    if (event.layerId !== this.layer.id) return;
    const record = this.records.get(featureRefKey(event.feature));
    if (!record) return;
    if (event.type === 'mouseover') {
      if (record.tooltip && !record.tooltip.permanent && !record.tooltipElement) {
        this.openTooltipElement(record, false);
      }
      return;
    }
    if (event.type === 'mouseout' && record.tooltipElement && !record.tooltipSticky) {
      this.closeTooltipElement(record);
    }
  }

  /** Re-places every open overlay from the marker's current screen position. */
  private reposition(): void {
    if (this.destroyed) return;
    if (this.popup) {
      const screen = this.screenOf(this.popup.record);
      if (screen) this.placePopup(this.popup, screen);
      else this.closePopupElement();
    }
    for (const record of [...this.openTooltips]) {
      const screen = this.screenOf(record);
      if (!screen) {
        this.closeTooltipElement(record);
        continue;
      }
      const tooltip = record.tooltip;
      if (record.tooltipElement && tooltip) {
        this.place(record.tooltipElement, screen, tooltip.offsetPx ?? this.aboveOffset(record), true);
      }
    }
  }

  private screenOf(record: MarkerRecord): ScreenPoint | null {
    if (record.point.removed) return null;
    return this.engine.view.positionToScreen(record.point.getPosition());
  }

  /** Bottom-centre offset that sits just above the icon (and its anchor). */
  private aboveOffset(record: MarkerRecord): { x: number; y: number } {
    const size = record.iconSize ?? DEFAULT_MARKER_SIZE;
    const anchorY = (record.iconAnchor ?? DEFAULT_MARKER_ANCHOR).y;
    return { x: 0, y: anchorY - size / 2 - 4 };
  }

  private openTooltipElement(record: MarkerRecord, sticky: boolean): void {
    if (!record.tooltip) return;
    if (!this.container) fail('unsupported-capability', 'marker tooltips require a map container');
    const element = document.createElement('div');
    element.dataset.mapletTooltip = 'true';
    element.setAttribute('role', 'tooltip');
    element.style.cssText = TEXT_STYLE + TOOLTIP_STYLE;
    const contentHost = document.createElement('div');
    contentHost.dataset.mapletTooltipContent = 'true';
    const tip = document.createElement('div');
    tip.style.cssText = TIP_STYLE;
    element.append(contentHost, tip);
    this.container.appendChild(element);
    this.renderContent(contentHost, record.tooltip.content);
    record.tooltipElement = element;
    record.tooltipSticky = sticky;
    this.openTooltips.add(record);
    const screen = this.screenOf(record);
    if (screen) this.place(element, screen, record.tooltip.offsetPx ?? this.aboveOffset(record), true);
  }

  private closeTooltipElement(record: MarkerRecord): void {
    record.tooltipElement?.remove();
    record.tooltipElement = null;
    record.tooltipSticky = false;
    this.openTooltips.delete(record);
  }

  private openPopupElement(record: MarkerRecord): void {
    const popup = record.popup;
    if (!popup) return;
    if (!this.container) fail('unsupported-capability', 'marker popups require a map container');
    const element = document.createElement('div');
    element.dataset.mapletPopup = 'true';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Popup');
    element.style.cssText = TEXT_STYLE + POPUP_STYLE;
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }
    const contentHost = document.createElement('div');
    contentHost.dataset.mapletPopupContent = 'true';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', 'Close popup');
    closeButton.style.cssText =
      'position:absolute;right:4px;top:2px;border:0;background:transparent;color:#374151;' +
      'font:16px/1 system-ui,sans-serif;cursor:pointer;padding:2px 4px;';
    closeButton.addEventListener('click', () => this.closePopupElement());
    const tip = document.createElement('div');
    tip.style.cssText = TIP_STYLE;
    element.append(contentHost, closeButton, tip);
    this.container.appendChild(element);
    this.renderContent(contentHost, popup.content);
    const entry: PopupEntry = { record, element, contentHost };
    this.popup = entry;
    const screen = this.screenOf(record);
    if (screen) {
      this.placePopup(entry, screen);
      if (popup.autoPan !== false) this.autoPan(entry, screen);
    }
  }

  private closePopupElement(): void {
    if (!this.popup) return;
    this.popup.element.remove();
    this.popup = null;
  }

  private placePopup(entry: PopupEntry, screen: ScreenPoint): void {
    const popup = entry.record.popup;
    if (!popup) return;
    this.place(entry.element, screen, popup.offsetPx ?? this.aboveOffset(entry.record), false);
  }

  /** Moves content by (dx, dy) by re-centering the view; see `fitViewportShift`. */
  private autoPan(entry: PopupEntry, screen: ScreenPoint): void {
    const bounds = this.container?.getBoundingClientRect();
    if (!bounds) return;
    const popup = entry.record.popup;
    const offset = popup?.offsetPx ?? this.aboveOffset(entry.record);
    const width = entry.element.offsetWidth;
    const height = entry.element.offsetHeight;
    const shift = fitViewportShift(
      { x: screen.x + offset.x - width / 2, y: screen.y + offset.y - height, width, height },
      screen,
      { width: bounds.width, height: bounds.height },
    );
    if (shift.dx === 0 && shift.dy === 0) return;
    const center = this.engine.view.screenToPosition({
      x: bounds.width / 2 - shift.dx,
      y: bounds.height / 2 - shift.dy,
    });
    this.engine.view.set({ center });
  }

  private place(element: HTMLElement, screen: ScreenPoint, offset: { x: number; y: number }, clampX: boolean): void {
    let x = screen.x + offset.x;
    const y = screen.y + offset.y;
    const bounds = this.container?.getBoundingClientRect();
    if (clampX && bounds) {
      const half = element.offsetWidth / 2;
      x = Math.min(Math.max(x, half + 6), Math.max(bounds.width - half - 6, half + 6));
    }
    element.style.left = `${Math.round(x)}px`;
    element.style.top = `${Math.round(y)}px`;
  }

  private renderContent(host: HTMLElement, content: MarkerContent): void {
    host.replaceChildren();
    if (typeof content === 'string') {
      const text = document.createElement('div');
      text.dataset.mapletText = 'true';
      text.textContent = content;
      host.appendChild(text);
    } else {
      host.appendChild(content);
    }
  }
}
