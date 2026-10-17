/**
 * Leaflet-style markers (MARKER-01..11): a pin at a position with a tooltip and
 * a popup, optionally grouped into count badges.
 *
 * A marker is one point feature in a shared internal points layer, drawn as a
 * GPU sprite from the icon atlas — there is no DOM element per marker. The
 * tooltip and popup are bounded DOM overlays (the same pattern as the feature
 * detail): one popup per map at a time and one element per open tooltip,
 * positioned in the map container and re-placed on view and commit changes.
 *
 * With clustering on, nearby pins are replaced by one badge: an internal point
 * feature in the same layer carrying the member count, so it picks, hovers and
 * clicks like any other sprite. Grouping is resolved in screen space at the
 * current zoom (see `marker-clusters.ts`), which leaves it untouched by panning
 * and dissolves it as the view zooms in.
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
import { boundsFromPositions } from '../math/bounds.ts';
import type { ColorValue } from '../scene/expression.ts';
import type { FeatureOverride, PointsLayerStyle } from '../scene/layers.ts';
import {
  clusterBadge,
  clusterByProximity,
  resolveMarkerClustering,
  type ClusterBadgeArt,
  type ClusterCandidate,
  type ClusterPartition,
  type MarkerClusteringOptions,
  type ResolvedMarkerClustering,
} from './marker-clusters.ts';
import {
  focusAnnouncement,
  pinFocusBox,
  pinFocusVisible,
  pinsStopLabel,
  stepFocusIndex,
  type FocusStep,
} from './pin-keyboard.ts';

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
  /**
   * Drag the pin with the pointer; default `false` (Leaflet parity). A drag
   * moves the position, emits `dragstart`/`drag`/`dragend` and suppresses pan,
   * while a press without movement stays a click.
   */
  readonly draggable?: boolean;
  /**
   * Let the pin join a cluster badge while clustering is on; default `true`.
   * `cluster: false` keeps one pin individual (a pinned landmark, say).
   */
  readonly cluster?: boolean;
  /**
   * Include the pin in the keyboard cursor (MARKER-15); default `true`.
   * `keyboard: false` keeps it out of the tab-reachable pin stop.
   */
  readonly keyboard?: boolean;
  /**
   * Accessible name for keyboard announcements (Leaflet parity); default is the
   * tooltip text, then `Pin` (`N pins` for a cluster badge).
   */
  readonly alt?: string;
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
  /** Enable or disable dragging; a drag in progress is not affected mid-gesture. */
  setDraggable(draggable: boolean): void;
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
  return isMarkerInit(content) ? content : { content: content };
}

export function markerPopup(content: MarkerPopupInit | MarkerContent): MarkerPopupInit {
  return isMarkerInit(content) ? content : { content: content };
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
  draggable: boolean;
  tooltip: MarkerTooltipInit | null;
  popup: MarkerPopupInit | null;
  tooltipElement: HTMLElement | null;
  tooltipSticky: boolean;
  /** Hidden through `handle.hide()`; survives appearance rebuilds (MARKER-11). */
  hidden: boolean;
  /** Allowed to join a badge; `cluster: false` pins and badges opt out. */
  clusterable: boolean;
  /** Currently replaced by a badge; its markers are hidden with it. */
  clustered: boolean;
  /** Non-null on internal count badges; carries the members and last screen centre. */
  badge: { members: MarkerRecord[]; x: number; y: number } | null;
  /** Badge standing in for this pin; the keyboard cursor visits it in the pin's place. */
  clusterBadge: MarkerRecord | null;
  /** Mid-drag pins stay individual so the pointer always owns the sprite. */
  dragging: boolean;
  /** A sticky/permanent tooltip closed by clustering; reopened with the pin. */
  tooltipParked: boolean;
  /** Accessible name for keyboard announcements (MARKER-15). */
  alt: string | null;
  /** Reachable by the keyboard pin cursor (MARKER-15). */
  keyboard: boolean;
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

/** Reserved id prefix of internal cluster badges and of their artwork. */
const CLUSTER_FEATURE_PREFIX = 'maplet-cluster:';
const CLUSTER_ASSET_PREFIX = 'maplet-cluster-asset:';
/** Badge artwork cache bound; unused labels are evicted in insertion order. */
const MAX_BADGE_ART = 64;
/** Keyboard focus DOM (MARKER-15): both clipped helpers leave no layout trace. */
const CLIPPED_STYLE =
  'position:absolute;left:0;top:0;width:1px;height:1px;padding:0;margin:0;border:0;' +
  'overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none;';
const PIN_FOCUS_STYLE =
  'position:absolute;display:none;pointer-events:none;box-sizing:border-box;border-radius:10px;' +
  'box-shadow:0 0 0 2px #1d4ed8, 0 0 0 4px #ffffff;';

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
  private clustering: ResolvedMarkerClustering | null = null;
  /** Pool of internal badge records, reused across recomputes (MARKER-11). */
  private readonly badges: MarkerRecord[] = [];
  /** Member records currently replaced by a badge, so stopping grouping reveals them. */
  private readonly clusteredRecords = new Set<MarkerRecord>();
  /** Badge artwork per count label; bounded so long sessions cannot grow it. */
  private readonly badgeArt = new Map<string, { id: string; size: number }>();
  private badgeSerial = 0;
  /** Zoom of the last grouping pass; panning never changes the grouping. */
  private lastClusterZoom: number | null = null;
  private applyingClusters = false;
  /** Keyboard pin focus (MARKER-15): the hidden stop, the announcer and the ring. */
  private pinsStop: HTMLElement | null = null;
  private pinAnnouncer: HTMLElement | null = null;
  private pinRing: HTMLElement | null = null;
  /** Remembered cursor target (a record key); kept while it stays reachable. */
  private focusedKey: string | null = null;
  private pinFocusActive = false;

  constructor(
    engine: MapEngine,
    layer: PointsLayerHandle<FeatureProperties>,
    container: HTMLElement | null,
  ) {
    this.engine = engine;
    this.layer = layer;
    this.container = container;
    this.unsubscribes.push(
      engine.on('feature', (event) => this.onFeature(event)),
      engine.on('pointer', (event) => {
        if (event.type === 'click') this.closePopupElement();
      }),
      engine.on('viewchange', () => this.onViewChange()),
      engine.on('viewend', () => this.refreshPinsStop()),
      engine.on('commit', () => this.reposition()),
      engine.on('destroy', () => this.destroy()),
    );
    // Absolute overlays need a positioned container (Leaflet's stylesheet does
    // the same); only touch a static container, never a positioned one.
    if (
      container &&
      typeof getComputedStyle === 'function' &&
      getComputedStyle(container).position === 'static'
    ) {
      container.style.position = 'relative';
    }
  }

  add<P = FeatureProperties>(options: MarkerOptions<P>): MarkerHandle<P> {
    return this.addMany([options])[0]!;
  }

  addMany<P = FeatureProperties>(options: readonly MarkerOptions<P>[]): MarkerHandle<P>[] {
    if (this.destroyed || this.layer.removed)
      fail('destroyed', 'the marker layer has been removed');
    const handles = options.map((option) => {
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
        draggable: option.draggable === true,
        tooltip:
          option.tooltip === null || option.tooltip === undefined
            ? null
            : markerTooltip(option.tooltip),
        popup:
          option.popup === null || option.popup === undefined ? null : markerPopup(option.popup),
        tooltipElement: null,
        tooltipSticky: false,
        hidden: false,
        clusterable: option.cluster !== false,
        clustered: false,
        badge: null,
        clusterBadge: null,
        dragging: false,
        tooltipParked: false,
        alt: option.alt ?? null,
        keyboard: option.keyboard !== false,
      };
      this.records.set(featureRefKey(record.point.ref), record);
      this.applyAppearance(record);
      if (record.tooltip?.permanent) this.openTooltipElement(record, true);
      return this.handle(record, point);
    });
    if (this.clustering) this.recomputeClusters();
    this.refreshPinsStop();
    return handles;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closePopupElement();
    for (const record of [...this.openTooltips]) this.closeTooltipElement(record);
    for (const off of this.unsubscribes.splice(0)) off();
    this.records.clear();
    this.clusteredRecords.clear();
  }

  private handle<P>(record: MarkerRecord, point: PointHandle<P>): MarkerHandle<P> {
    const isPopupOpen = (): boolean => this.popup?.record === record;
    return {
      id: point.id,
      ref: point.ref,
      get removed() {
        return point.removed;
      },
      ...featureEvents((fn, options) => point.onFeature(fn, options)),
      getPosition: () => point.getPosition(),
      setPosition: (position) => {
        const commit = point.setPosition(position);
        if (this.clustering) this.recomputeClusters();
        return commit;
      },
      setIcon: (icon) => this.setIcon(record, icon),
      setDraggable: (draggable) => this.setDraggable(record, draggable),
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
      get tooltipOpen() {
        return record.tooltipElement !== null;
      },
      get popupOpen() {
        return isPopupOpen();
      },
      tooltipElement: () => record.tooltipElement,
      popupElement: () => (this.popup?.record === record ? this.popup.element : null),
      show: () => this.setHidden(record, false),
      hide: () => this.setHidden(record, true),
      remove: () => this.removeRecord(record),
    };
  }

  private setIcon(record: MarkerRecord, icon: string | null): void {
    this.assertLive(record);
    record.icon = icon;
    this.applyAppearance(record);
  }

  private setDraggable(record: MarkerRecord, draggable: boolean): void {
    this.assertLive(record);
    record.draggable = draggable === true;
    this.applyAppearance(record);
  }

  private setHidden(record: MarkerRecord, hidden: boolean): void {
    this.assertLive(record);
    record.hidden = hidden;
    this.applyAppearance(record);
    if (hidden) this.parkMemberOverlays(record);
    else this.restoreMemberOverlays(record);
    if (this.clustering) this.recomputeClusters();
    this.refreshPinsStop();
  }

  private setTooltip(record: MarkerRecord, value: MarkerTooltipInit | MarkerContent | null): void {
    this.assertLive(record);
    const next = value === null ? null : markerTooltip(value);
    const wasOpen = record.tooltipElement !== null;
    this.closeTooltipElement(record);
    record.tooltip = next;
    if (!next) {
      record.tooltipParked = false;
      return;
    }
    if (record.hidden || record.clustered) {
      // The pin sits behind a badge or is hidden: keep the intent and open the
      // tooltip when the pin comes back (MARKER-11).
      record.tooltipParked = next.permanent === true || wasOpen;
      return;
    }
    if (next.permanent || wasOpen) this.openTooltipElement(record, next.permanent === true);
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
    const key = featureRefKey(record.point.ref);
    if (this.focusedKey === key) this.focusedKey = null;
    this.closeTooltipElement(record);
    if (this.popup?.record === record) this.closePopupElement();
    record.point.remove();
    this.records.delete(key);
    this.clusteredRecords.delete(record);
    if (this.clustering) this.recomputeClusters();
    this.refreshPinsStop();
  }

  private assertLive(record: MarkerRecord): void {
    if (this.destroyed || record.point.removed) fail('destroyed', 'the marker has been removed');
  }

  /** Overrides are rebuilt from scratch so `setIcon(null)` restores defaults. */
  private applyAppearance(record: MarkerRecord): void {
    const applied: FeatureOverride = {
      // Visibility is owned by the record, so a hidden pin stays hidden across
      // appearance edits and a clustered member hides together with its badge.
      ...(record.hidden || record.clustered ? { visible: false } : {}),
      ...(record.icon === null ? {} : { icon: record.icon }),
      ...(record.iconSize === null ? {} : { iconSize: record.iconSize }),
      ...(record.iconAnchor === null ? {} : { iconAnchor: { ...record.iconAnchor } }),
      ...(record.iconTint === null ? {} : { iconTint: record.iconTint }),
      ...(record.draggable ? { draggable: true } : {}),
    };
    record.point.clearStyle();
    if (Object.keys(applied).length > 0) record.point.setStyle(applied);
  }

  private onFeature(event: MapFeatureEvent): void {
    if (this.destroyed) return;
    if (event.type === 'click') {
      // Leaflet parity: a click elsewhere closes the open popup, and the
      // clicked marker then opens its own (one popup per map).
      const record =
        event.layerId === this.layer.id
          ? this.records.get(featureRefKey(event.feature))
          : undefined;
      if (record) {
        if (this.popup?.record === record) return;
        this.closePopupElement();
        if (record.badge) {
          this.zoomToCluster(record);
          return;
        }
        if (record.popup) this.openPopupElement(record);
        return;
      }
      this.closePopupElement();
      return;
    }
    if (event.layerId !== this.layer.id) return;
    const record = this.records.get(featureRefKey(event.feature));
    if (!record) return;
    if (event.type === 'dragstart' || event.type === 'dragend') {
      // A dragged pin stays individual for the gesture; its badge drops it.
      record.dragging = event.type === 'dragstart';
      if (this.clustering) this.recomputeClusters();
      return;
    }
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

  /** Enables, reconfigures or disables clustering (`null` shows every pin). */
  setClustering(options: MarkerClusteringOptions | null): void {
    if (this.destroyed || this.layer.removed)
      fail('destroyed', 'the marker layer has been removed');
    this.clustering = options === null ? null : resolveMarkerClustering(options);
    this.recomputeClusters();
  }

  /** The active configuration with defaults applied, or `null` when off. */
  getClustering(): ResolvedMarkerClustering | null {
    return this.clustering === null ? null : { ...this.clustering };
  }

  private onViewChange(): void {
    this.reposition();
    if (!this.clustering) return;
    const zoom = this.engine.view.get().zoom;
    if (this.lastClusterZoom === null || Math.abs(zoom - this.lastClusterZoom) > 1e-9)
      this.recomputeClusters();
  }

  /**
   * Rebuilds the badge set from the current screen positions (MARKER-11). Runs
   * on zoom and marker changes, never on pan: screen distances do not change
   * while the view only moves, so the grouping — and its animation-free
   * stability — survives a drag of the map.
   */
  private recomputeClusters(): void {
    if (this.destroyed || this.applyingClusters) return;
    const clustering = this.clustering;
    const zoom = this.engine.view.get().zoom;
    this.lastClusterZoom = zoom;
    const active =
      clustering !== null && (clustering.disableAtZoom === null || zoom < clustering.disableAtZoom);
    const candidates: ClusterCandidate[] = [];
    const records = new Map<string, MarkerRecord>();
    if (active && clustering) {
      for (const [key, record] of this.records) {
        if (
          record.badge ||
          record.point.removed ||
          record.dragging ||
          record.hidden ||
          !record.clusterable
        )
          continue;
        const screen = this.engine.view.positionToScreen(record.point.getPosition());
        candidates.push({ key, x: screen.x, y: screen.y });
        records.set(key, record);
      }
    }
    const partition =
      active && clustering
        ? clusterByProximity(candidates, clustering.radiusPx, clustering.minCount)
        : {
            clusters: [] as ClusterPartition['clusters'],
            singles: [] as ClusterPartition['singles'],
          };
    this.applyingClusters = true;
    try {
      const badgeOf = new Map<string, MarkerRecord>();
      partition.clusters.forEach((group, index) => {
        const badge = this.badgeAt(index);
        const members = group.members.map((key) => records.get(key)!);
        for (const member of members) badgeOf.set(featureRefKey(member.point.ref), badge);
        this.updateBadge(badge, members, group.x, group.y);
      });
      for (let index = partition.clusters.length; index < this.badges.length; index++) {
        this.parkBadge(this.badges[index]!);
      }
      // Members of the last pass are touched too: when grouping turns off (or
      // every pin moves out of reach) their pins must come back.
      const touched = new Set<MarkerRecord>(records.values());
      for (const record of this.clusteredRecords) touched.add(record);
      for (const record of touched) {
        const badge = badgeOf.get(featureRefKey(record.point.ref)) ?? null;
        const clustered = badge !== null;
        if (record.clustered === clustered && record.clusterBadge === badge) continue;
        record.clustered = clustered;
        record.clusterBadge = badge;
        if (clustered) this.clusteredRecords.add(record);
        else this.clusteredRecords.delete(record);
        this.applyAppearance(record);
        if (clustered) this.parkMemberOverlays(record);
        else this.restoreMemberOverlays(record);
      }
    } finally {
      this.applyingClusters = false;
    }
    this.refreshPinsStop();
  }

  /** Lazily allocates the pool slot for a cluster; ids stay reserved. */
  private badgeAt(index: number): MarkerRecord {
    const existing = this.badges[index];
    if (existing) return existing;
    const point = this.layer.add({
      id: `${CLUSTER_FEATURE_PREFIX}${++this.badgeSerial}`,
      position: this.engine.view.screenToPosition({ x: 0, y: 0 }),
      properties: {},
    });
    const record: MarkerRecord = {
      point,
      icon: null,
      iconSize: null,
      iconAnchor: { x: 0, y: 0 },
      iconTint: null,
      draggable: false,
      tooltip: null,
      popup: null,
      tooltipElement: null,
      tooltipSticky: false,
      hidden: true,
      clusterable: false,
      clustered: false,
      badge: { members: [], x: 0, y: 0 },
      clusterBadge: null,
      dragging: false,
      tooltipParked: false,
      alt: null,
      keyboard: true,
    };
    this.records.set(featureRefKey(record.point.ref), record);
    this.badges.push(record);
    this.applyAppearance(record);
    return record;
  }

  /**
   * Paints one badge for the given members: centre on the group centroid, count
   * artwork, `N pins` hover tooltip. Unchanged badges are left untouched so a
   * view change only commits what actually moved.
   */
  private updateBadge(badge: MarkerRecord, members: MarkerRecord[], x: number, y: number): void {
    const count = members.length;
    const art = clusterBadge(count);
    const asset = this.badgeAsset(art);
    const state = badge.badge!;
    const unchanged =
      !badge.hidden &&
      badge.icon === asset.id &&
      badge.iconSize === art.size &&
      state.members.length === members.length &&
      state.members.every((member, index) => member === members[index]) &&
      Math.abs(state.x - x) <= 0.5 &&
      Math.abs(state.y - y) <= 0.5;
    state.members = members;
    state.x = x;
    state.y = y;
    if (unchanged) return;
    badge.hidden = false;
    badge.icon = asset.id;
    badge.iconSize = art.size;
    badge.iconAnchor = { x: 0, y: 0 };
    const content = `${count} pin${count === 1 ? '' : 's'}`;
    badge.tooltip = { content };
    badge.point.setPosition(this.engine.view.screenToPosition({ x, y }));
    this.applyAppearance(badge);
    const host = badge.tooltipElement?.querySelector<HTMLElement>('[data-maplet-tooltip-content]');
    if (host) this.renderContent(host, content);
  }

  private parkBadge(badge: MarkerRecord): void {
    if (badge.hidden) return;
    badge.hidden = true;
    badge.icon = null;
    badge.badge!.members = [];
    if (badge.tooltipElement) this.closeTooltipElement(badge);
    this.applyAppearance(badge);
  }

  /** Registers (or reuses) badge artwork; the cache evicts unused labels. */
  private badgeAsset(art: ClusterBadgeArt): { id: string; size: number } {
    const cached = this.badgeArt.get(art.label);
    if (cached) return cached;
    if (this.badgeArt.size >= MAX_BADGE_ART) {
      for (const [label, entry] of this.badgeArt) {
        if (this.badges.some((badge) => badge.icon === entry.id)) continue;
        this.badgeArt.delete(label);
        if (this.engine.assets.get(entry.id)) this.engine.assets.remove(entry.id);
        break;
      }
    }
    const id = `${CLUSTER_ASSET_PREFIX}${art.label}`;
    if (!this.engine.assets.get(id)) this.engine.assets.addImage({ id, src: art.url });
    const entry = { id, size: art.size };
    this.badgeArt.set(art.label, entry);
    return entry;
  }

  /** Badge click: fit the member bounds, capped by `disableAtZoom`. */
  private zoomToCluster(badge: MarkerRecord): void {
    const positions = (badge.badge?.members ?? [])
      .filter((member) => !member.point.removed)
      .map((member) => member.point.getPosition());
    const bounds = boundsFromPositions(positions);
    if (!bounds) return;
    const disableAtZoom = this.clustering?.disableAtZoom ?? null;
    this.engine.view.fit(bounds, {
      padding: 40,
      ...(disableAtZoom === null ? {} : { maxZoom: disableAtZoom }),
    });
  }

  /** Overlays leave the map with the pin they belong to (MARKER-11). */
  private parkMemberOverlays(record: MarkerRecord): void {
    if (record.tooltipElement) {
      record.tooltipParked = record.tooltip?.permanent === true || record.tooltipSticky;
      this.closeTooltipElement(record);
    }
    if (this.popup?.record === record) this.closePopupElement();
  }

  private restoreMemberOverlays(record: MarkerRecord): void {
    if (record.hidden || record.clustered || !record.tooltipParked) return;
    record.tooltipParked = false;
    if (record.tooltip) this.openTooltipElement(record, true);
  }

  /* ----------------------------- keyboard focus ----------------------------- */

  /**
   * Keyboard access to pins (MARKER-15). Pins are GPU sprites without DOM
   * nodes, so the controller installs one visually hidden focus stop inside the
   * container instead: Tab reaches it, arrows walk a ring from pin to pin,
   * Enter activates the focused pin (a real click event) and Escape leaves.
   * The stop consumes the arrow keys before they bubble, so panning keeps
   * working whenever the map container itself is focused (INPUT-07).
   */
  private ensurePinsStop(): HTMLElement | null {
    if (this.pinsStop) return this.pinsStop;
    const container = this.container;
    if (!container) return null;
    const stop = document.createElement('div');
    stop.dataset.mapletPins = 'true';
    stop.setAttribute('role', 'group');
    stop.tabIndex = -1;
    stop.style.cssText = CLIPPED_STYLE;
    const announcer = document.createElement('div');
    announcer.dataset.mapletPinAnnouncer = 'true';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    announcer.setAttribute('aria-atomic', 'true');
    announcer.style.cssText = CLIPPED_STYLE;
    const ring = document.createElement('div');
    ring.dataset.mapletPinFocus = 'true';
    ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = PIN_FOCUS_STYLE;
    container.prepend(stop, announcer);
    container.appendChild(ring);
    stop.addEventListener('keydown', this.onPinsStopKeyDown);
    stop.addEventListener('focus', this.onPinsStopFocus);
    stop.addEventListener('blur', this.onPinsStopBlur);
    this.unsubscribes.push(() => {
      stop.removeEventListener('keydown', this.onPinsStopKeyDown);
      stop.removeEventListener('focus', this.onPinsStopFocus);
      stop.removeEventListener('blur', this.onPinsStopBlur);
      stop.remove();
      announcer.remove();
      ring.remove();
    });
    this.pinsStop = stop;
    this.pinAnnouncer = announcer;
    this.pinRing = ring;
    return stop;
  }

  /** Keeps the stop's reachability and label in step with what the cursor sees. */
  private refreshPinsStop(): void {
    if (this.destroyed) return;
    if (this.records.size === 0 && !this.pinsStop) return;
    const stop = this.ensurePinsStop();
    if (!stop) return;
    const reachable = this.focusableRecords().length;
    stop.tabIndex = reachable > 0 ? 0 : -1;
    stop.setAttribute('aria-label', pinsStopLabel(reachable));
    if (this.pinFocusActive) this.settlePinCursor('current');
  }

  /**
   * Records the cursor can reach: drawn, allowed by `keyboard` and inside the
   * view. A badge is visited in the place of its first reachable member, so the
   * cycle keeps the layer's order instead of trailing every cluster at the end.
   */
  private focusableRecords(): MarkerRecord[] {
    const container = this.container;
    if (!container) return [];
    const bounds = container.getBoundingClientRect();
    const records: MarkerRecord[] = [];
    const visited = new Set<MarkerRecord>();
    for (const record of this.records.values()) {
      if (record.badge) continue;
      if (this.pinReachable(record, bounds)) {
        records.push(record);
        continue;
      }
      const badge = record.clusterBadge;
      if (!badge || visited.has(badge)) continue;
      visited.add(badge);
      if (this.pinReachable(badge, bounds)) records.push(badge);
    }
    return records;
  }

  private pinReachable(record: MarkerRecord, bounds: DOMRect): boolean {
    if (record.point.removed || record.hidden || record.clustered || !record.keyboard) return false;
    return this.pinCentre(record, bounds) !== null;
  }

  /** Sprite centre while it lies inside the container; null once it left the view. */
  private pinCentre(record: MarkerRecord, bounds: DOMRect): ScreenPoint | null {
    const screen = this.screenOf(record);
    if (!screen) return null;
    const anchor = record.iconAnchor ?? DEFAULT_MARKER_ANCHOR;
    const centre = { x: screen.x + anchor.x, y: screen.y + anchor.y };
    return pinFocusVisible(centre, bounds) ? centre : null;
  }

  private focusedRecord(): MarkerRecord | null {
    if (this.focusedKey === null) return null;
    return this.records.get(this.focusedKey) ?? null;
  }

  private onPinsStopFocus = (): void => {
    this.pinFocusActive = true;
    this.settlePinCursor('current');
  };

  private onPinsStopBlur = (): void => {
    this.pinFocusActive = false;
    if (this.pinRing) this.pinRing.style.display = 'none';
    if (this.pinAnnouncer) this.pinAnnouncer.textContent = '';
  };

  /**
   * Moves the cursor; `current` keeps the remembered pin, so tabbing back into
   * the stop continues where the user left off.
   */
  private settlePinCursor(step: FocusStep | 'current'): void {
    const records = this.focusableRecords();
    const current =
      this.focusedKey === null
        ? -1
        : records.findIndex((record) => featureRefKey(record.point.ref) === this.focusedKey);
    const index =
      step === 'current'
        ? current >= 0
          ? current
          : records.length > 0
            ? 0
            : -1
        : stepFocusIndex(current, records.length, step);
    if (index < 0) {
      this.clearPinCursor();
      return;
    }
    const record = records[index]!;
    this.focusedKey = featureRefKey(record.point.ref);
    this.placePinRing();
    if (this.pinAnnouncer) {
      this.pinAnnouncer.textContent = focusAnnouncement(
        this.pinNameOf(record),
        index,
        records.length,
      );
    }
  }

  private clearPinCursor(): void {
    this.focusedKey = null;
    if (this.pinRing) this.pinRing.style.display = 'none';
    if (this.pinAnnouncer) this.pinAnnouncer.textContent = '';
  }

  /** Ring around the focused sprite; parked with the pin when it leaves the view. */
  private placePinRing(): void {
    const ring = this.pinRing;
    if (!ring) return;
    const record = this.focusedRecord();
    const container = this.container;
    if (!this.pinFocusActive || !record || !container) {
      ring.style.display = 'none';
      return;
    }
    const screen = this.screenOf(record);
    if (!screen) {
      ring.style.display = 'none';
      return;
    }
    const anchor = record.iconAnchor ?? DEFAULT_MARKER_ANCHOR;
    const size = record.iconSize ?? DEFAULT_MARKER_SIZE;
    const box = pinFocusBox(
      { x: screen.x + anchor.x, y: screen.y + anchor.y },
      size,
      container.getBoundingClientRect(),
    );
    if (!box.visible) {
      ring.style.display = 'none';
      return;
    }
    ring.style.display = 'block';
    ring.style.left = `${box.left}px`;
    ring.style.top = `${box.top}px`;
    ring.style.width = `${box.size}px`;
    ring.style.height = `${box.size}px`;
  }

  private onPinsStopKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || event.key === 'Tab') return; // Tab always leaves the map
    if (event.key === 'Escape') {
      // First Escape closes the popup, a second one leaves the pin cursor.
      if (this.popup) this.closePopupElement();
      else this.leavePinFocus();
      return;
    }
    const step: FocusStep | null =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 'next'
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? 'previous'
          : event.key === 'Home'
            ? 'first'
            : event.key === 'End'
              ? 'last'
              : null;
    if (step) {
      // Consumed here so the container's pan keys never see it (INPUT-07).
      event.preventDefault();
      event.stopPropagation();
      this.settlePinCursor(step);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      this.activatePinCursor(event);
    }
  };

  private leavePinFocus(): void {
    if (this.pinsStop && document.activeElement === this.pinsStop) {
      this.container?.focus({ preventScroll: true });
    }
    this.pinFocusActive = false;
    if (this.pinRing) this.pinRing.style.display = 'none';
    if (this.pinAnnouncer) this.pinAnnouncer.textContent = '';
  }

  /** Enter/Space fires a real click so listeners and the popup agree (MARKER-15). */
  private activatePinCursor(originalEvent: Event): void {
    const record = this.focusedRecord();
    const container = this.container;
    if (!record || !container) return;
    const centre = this.pinCentre(record, container.getBoundingClientRect());
    if (!centre) return;
    this.engine.dispatchFeature({
      type: 'click',
      feature: record.point.ref,
      layerId: this.layer.id,
      screen: centre,
      originalEvent,
    });
  }

  /** Accessible name: `alt`, then tooltip text, then the kind and member count. */
  private pinNameOf(record: MarkerRecord): string {
    const alt = record.alt?.trim();
    if (alt) return alt;
    const content = record.tooltip?.content;
    if (typeof content === 'string') {
      const text = content.trim();
      if (text) return text;
    } else if (content && typeof Node !== 'undefined' && content instanceof Node) {
      const text = content.textContent?.trim();
      if (text) return text;
    }
    const members = record.badge?.members.length ?? 0;
    if (record.badge && members > 0) return `${members} pin${members === 1 ? '' : 's'}`;
    return 'Pin';
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
      this.placeTooltip(record, screen);
    }
    this.placePinRing();
  }

  private screenOf(record: MarkerRecord): ScreenPoint | null {
    if (record.point.removed) return null;
    return this.engine.view.positionToScreen(record.point.getPosition());
  }

  /**
   * A permanent tooltip tracks its pin exactly (its arrow must keep pointing at
   * the icon); a hover tooltip is clamped horizontally so its text stays
   * readable at an edge. Either way an overlay whose anchor left the container
   * is parked instead of detached from the marker (MARKER-06).
   */
  private placeTooltip(record: MarkerRecord, screen: ScreenPoint): void {
    const element = record.tooltipElement;
    const tooltip = record.tooltip;
    if (!element || !tooltip) return;
    const permanent = tooltip.permanent === true;
    element.style.visibility = permanent && !this.anchorInside(screen) ? 'hidden' : '';
    this.place(element, screen, tooltip.offsetPx ?? this.aboveOffset(record), !permanent);
  }

  private anchorInside(point: ScreenPoint): boolean {
    const bounds = this.container?.getBoundingClientRect();
    if (!bounds) return true;
    return point.x >= 0 && point.y >= 0 && point.x <= bounds.width && point.y <= bounds.height;
  }

  /** Bottom-centre offset that sits just above the icon (and its anchor). */
  private aboveOffset(record: MarkerRecord): { x: number; y: number } {
    const size = record.iconSize ?? DEFAULT_MARKER_SIZE;
    const anchorY = (record.iconAnchor ?? DEFAULT_MARKER_ANCHOR).y;
    return { x: 0, y: anchorY - size / 2 - 4 };
  }

  private openTooltipElement(record: MarkerRecord, sticky: boolean): void {
    if (!record.tooltip || record.hidden || record.clustered) return;
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
    if (screen) this.placeTooltip(record, screen);
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
    entry.element.style.visibility = this.anchorInside(screen) ? '' : 'hidden';
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

  private place(
    element: HTMLElement,
    screen: ScreenPoint,
    offset: { x: number; y: number },
    clampX: boolean,
  ): void {
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
