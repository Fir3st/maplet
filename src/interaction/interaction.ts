/**
 * Pointer, wheel and keyboard interaction.
 *
 * One delegated input path for pan, zoom, pinch, hover, click and feature drag;
 * gestures update the view (and feature geometry for draggable layers) through
 * the public math, never through Leaflet-style DOM hacks. Feature events are
 * emitted with references, positions and the revision they belong to, plus the
 * original browser event. INPUT-01..INPUT-08, EVENT-01..EVENT-03.
 */

import type {
  FeatureId,
  FeatureRef,
  FeatureEventType,
  PointerEventType,
  Position,
  ScreenPoint,
} from '../api/types.ts';
import type { Scene } from '../scene/scene.ts';
import type { ViewImpl } from '../view/view.ts';
import type { MapBackend } from '../render/backends.ts';
import type { PickResult } from '../render/picking.ts';

export type { MapFeatureEvent, MapPointerEvent } from '../api/types.ts';

/** View-affecting gestures that a gate may filter (INPUT-09). */
export type GestureKind = 'pan' | 'pinch' | 'wheel' | 'doubleClick' | 'featureDrag';

/**
 * A gesture about to affect the view or a dragged feature. A gate returns
 * `false` to ignore it; the interaction keeps tracking its pointers, so a later
 * allowed moment resumes without applying the skipped movement at once.
 */
export interface GestureRequest {
  readonly kind: GestureKind;
  /** `mouse`, `touch` or `pen`; wheel and double-click report `mouse`. */
  readonly pointerType: string;
  /** Pointers in the active gesture (1 for pan/wheel, 2+ for pinch). */
  readonly pointers: number;
  /** The input event, so gates can read modifier flags from it. */
  readonly originalEvent: Event;
}

export type GestureGate = (request: GestureRequest) => boolean;

export interface InteractionOptions {
  readonly pan?: boolean;
  readonly wheelZoom?: boolean;
  readonly doubleClickZoom?: boolean;
  readonly pinchZoom?: boolean;
  readonly hover?: boolean;
  readonly dragFeatures?: boolean;
  readonly keyboard?: boolean;
  /** Shift+drag selects features in a box (data query). */
  readonly boxSelection?: boolean;
}

interface ActiveGesture {
  kind: 'pan' | 'pinch' | 'drag' | 'box';
  pointers: Map<number, ScreenPoint>;
  /** Where the gesture started (never overwritten by moves). */
  startPoint: ScreenPoint;
  readonly startView?: { center: Position };
  dragFeature?: {
    feature: FeatureRef;
    layerId: string;
    /** Pointer position where the drag started. */
    startPointer: Position;
    /** Feature position at drag start; the pointer delta is applied to this. */
    origin: Position | null;
  } | null;
  boxStart?: ScreenPoint;
  moved: boolean;
}

const DRAG_THRESHOLD_PX = 4;

export class InteractionController {
  private readonly element: HTMLElement;
  private readonly scene: Scene;
  private readonly view: ViewImpl;
  private readonly backend: Pick<MapBackend, 'pick'>;
  private readonly options: InteractionOptions;
  private readonly listeners: { target: EventTarget; type: string; fn: EventListener; options?: AddEventListenerOptions }[] = [];
  private gesture: ActiveGesture | null = null;
  private hovered: PickResult | null = null;
  private hoverScheduled = false;
  /** Monotonic token: a stale hover readback never overwrites a newer one (PICK-09). */
  private hoverToken = 0;
  private lastPointer: ScreenPoint = { x: 0, y: 0 };
  /** Pointers currently pressed; a drag or pick resolving after release is dropped. */
  private readonly pressed = new Set<number>();
  /** Press whose draggable-target pick is still pending (used to start pinch). */
  private pendingDrag: { pointerId: number; point: ScreenPoint } | null = null;
  private destroyed = false;
  private gestureGate: GestureGate | null = null;

  constructor(
    element: HTMLElement,
    scene: Scene,
    view: ViewImpl,
    backend: Pick<MapBackend, 'pick'>,
    options: InteractionOptions = {},
  ) {
    this.element = element;
    this.scene = scene;
    this.view = view;
    this.backend = backend;
    this.options = {
      pan: options.pan ?? true,
      wheelZoom: options.wheelZoom ?? true,
      doubleClickZoom: options.doubleClickZoom ?? true,
      pinchZoom: options.pinchZoom ?? true,
      hover: options.hover ?? true,
      dragFeatures: options.dragFeatures ?? true,
      keyboard: options.keyboard ?? true,
      boxSelection: options.boxSelection ?? false,
    };
    element.style.touchAction = 'none';
    if (!element.style.cursor) element.style.cursor = 'grab';
    this.bind(element, 'pointerdown', this.onPointerDown as EventListener);
    this.bind(element, 'pointermove', this.onPointerMove as EventListener);
    this.bind(element, 'pointerup', this.onPointerUp as unknown as EventListener);
    this.bind(element, 'pointercancel', this.onPointerCancel as EventListener);
    this.bind(element, 'pointerleave', this.onPointerLeave as EventListener);
    this.bind(element, 'wheel', this.onWheel as EventListener, { passive: false });
    this.bind(element, 'dblclick', this.onDoubleClick as EventListener);
    this.bind(element, 'contextmenu', (event) => event.preventDefault());
    this.bind(element, 'keydown', this.onKeyDown as EventListener);
    element.tabIndex = element.tabIndex >= 0 ? element.tabIndex : 0;
    if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) {
      element.setAttribute('aria-label', 'Interactive map');
    }
  }

  private bind(
    target: EventTarget,
    type: string,
    fn: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, options);
    this.listeners.push({ target, type, fn, ...(options === undefined ? {} : { options }) });
  }

  setOptions(patch: Partial<InteractionOptions>): void {
    Object.assign(this.options, patch);
  }

  allOptions(): Required<InteractionOptions> {
    return {
      pan: this.options.pan ?? true,
      wheelZoom: this.options.wheelZoom ?? true,
      doubleClickZoom: this.options.doubleClickZoom ?? true,
      pinchZoom: this.options.pinchZoom ?? true,
      hover: this.options.hover ?? true,
      dragFeatures: this.options.dragFeatures ?? true,
      keyboard: this.options.keyboard ?? true,
      boxSelection: this.options.boxSelection ?? false,
    };
  }

  /** Installs the gate consulted before a view-affecting gesture applies (INPUT-09). */
  setGestureGate(gate: GestureGate | null): void {
    this.gestureGate = gate;
  }

  private allowGesture(kind: GestureKind, event: Event, pointerType: string, pointers: number): boolean {
    return (
      this.gestureGate === null ||
      this.gestureGate({ kind, pointerType, pointers, originalEvent: event }) !== false
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const { target, type, fn, options } of this.listeners) {
      target.removeEventListener(type, fn, options);
    }
    this.listeners.length = 0;
  }

  private pointOf(event: PointerEvent | MouseEvent | WheelEvent): ScreenPoint {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /* ------------------------------- gestures -------------------------------- */

  /** Pointer capture is an optimization; synthetic pointer ids have none. */
  private capturePointer(pointerId: number): void {
    try {
      this.element.setPointerCapture?.(pointerId);
    } catch {
      /* no active pointer to capture (e.g. dispatched test events) */
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      this.element.releasePointerCapture?.(pointerId);
    } catch {
      /* nothing captured for this pointer */
    }
  }

  private startPan(pointerId: number, point: ScreenPoint, originalEvent: Event): void {
    this.gesture = { kind: 'pan', pointers: new Map([[pointerId, point]]), startPoint: point, moved: false };
    this.emitPointer('movestart', point, originalEvent);
    this.element.style.cursor = 'grabbing';
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.destroyed) return;
    const point = this.pointOf(event);
    this.lastPointer = point;
    this.pressed.add(event.pointerId);
    this.capturePointer(event.pointerId);

    if (this.gesture?.kind === 'pan' || this.gesture?.kind === 'pinch') {
      const wasPan = this.gesture.kind === 'pan';
      this.gesture.pointers.set(event.pointerId, point);
      if (this.gesture.pointers.size === 2 && this.options.pinchZoom) {
        this.gesture.kind = 'pinch';
        if (wasPan) {
          // A new pinch never inherits the previous gesture's baseline
          // distance, which would otherwise jump the zoom (INPUT-03).
          this.pinchDistance = undefined;
          this.pinchMidpoint = undefined;
        }
      }
      return;
    }
    if (this.gesture) return;

    // A second finger during a pending drag pick turns the gesture into a
    // pinch instead of stacking two competing drags (INPUT-03).
    const pending = this.pendingDrag;
    if (pending && event.pointerId !== pending.pointerId && this.options.pinchZoom) {
      this.pendingDrag = null;
      this.gesture = {
        kind: 'pinch',
        pointers: new Map([[pending.pointerId, pending.point], [event.pointerId, point]]),
        startPoint: pending.point,
        moved: false,
      };
      this.pinchDistance = undefined;
      this.pinchMidpoint = undefined;
      return;
    }

    const boxSelecting = this.options.boxSelection && event.shiftKey && event.button === 0;
    if (boxSelecting) {
      this.gesture = { kind: 'box', pointers: new Map([[event.pointerId, point]]), startPoint: point, boxStart: point, moved: false };
      this.emitPointer('movestart', point, event);
      return;
    }

    if (event.button !== 0) return;
    // A draggable feature under the pointer wins over panning.
    if (this.options.dragFeatures) {
      this.pendingDrag = { pointerId: event.pointerId, point };
      void this.beginFeatureDrag(event, point);
      return;
    }
    if (this.options.pan) this.startPan(event.pointerId, point, event);
  };

  private async beginFeatureDrag(event: PointerEvent, point: ScreenPoint): Promise<void> {
    // Choose the topmost *draggable* target among the stacked hits (PICK-02).
    const hits = await this.backend.pick(this.scene, point, { limit: 8 });
    if (this.pendingDrag?.pointerId === event.pointerId) this.pendingDrag = null;
    // The pointer may be released, or a pinch may have started, while the
    // pick was in flight (INPUT-03/05).
    if (this.destroyed || !this.pressed.has(event.pointerId) || this.gesture) return;
    const hit =
      hits.find(
        (candidate) =>
          this.scene.layers.get(candidate.layerId)?.draggable &&
          this.scene.getSourceImpl(candidate.feature.sourceId) !== undefined,
      ) ?? null;
    if (!hit || !this.scene.layers.get(hit.layerId)?.draggable) {
      if (this.options.pan) this.startPan(event.pointerId, point, event);
      return;
    }
    const position = this.view.screenToPosition(point);
    // Capture the feature's position once: every move applies the pointer delta
    // from the drag start to this origin, never to the already moved position
    // (adding the full delta to the current position made points fly away).
    let origin: Position | null = null;
    const source = this.scene.getSourceImpl(hit.feature.sourceId);
    const record = source?.store.get(hit.feature.id, hit.feature.namespace);
    if (source && record && record.generation === hit.feature.generation) {
      const geometry = source.snapshotOf(record).geometry;
      if (geometry.type === 'point') origin = geometry.position;
    }
    this.gesture = {
      kind: 'drag',
      pointers: new Map([[event.pointerId, point]]),
      startPoint: point,
      dragFeature: { feature: hit.feature, layerId: hit.layerId, startPointer: position, origin },
      moved: false,
    };
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.destroyed) return;
    const point = this.pointOf(event);
    const gesture = this.gesture;
    if (!gesture) {
      this.scheduleHover(point, event);
      return;
    }
    if (gesture.pointers.has(event.pointerId)) {
      gesture.pointers.set(event.pointerId, point);
    }
    if (gesture.kind === 'pan' && gesture.pointers.size === 1) {
      const previous = this.lastPointer;
      gesture.moved ||= Math.hypot(point.x - previous.x, point.y - previous.y) > 0;
      if (!this.allowGesture('pan', event, event.pointerType, 1)) {
        // Blocked: keep the reference point so a later allowed move resumes
        // without applying the skipped delta.
        this.lastPointer = point;
        return;
      }
      this.panBy(point.x - previous.x, point.y - previous.y);
      this.lastPointer = point;
      return;
    }
    if (gesture.kind === 'pinch' && gesture.pointers.size >= 2) {
      if (!this.allowGesture('pinch', event, event.pointerType, gesture.pointers.size)) {
        // Drop the baselines so an allowed moment starts fresh instead of
        // applying the whole skipped distance and midpoint change at once.
        this.pinchDistance = undefined;
        this.pinchMidpoint = undefined;
        return;
      }
      this.handlePinch();
      return;
    }
    if (gesture.kind === 'drag' && gesture.dragFeature) {
      const drag = gesture.dragFeature;
      const downPoint = gesture.startPoint;
      if (!this.allowGesture('featureDrag', event, event.pointerType, 1)) {
        // A blocked drag never emits dragstart/drag; it still counts as moved so
        // releasing does not turn it into a click.
        if (Math.hypot(point.x - downPoint.x, point.y - downPoint.y) >= DRAG_THRESHOLD_PX) gesture.moved = true;
        return;
      }
      if (!gesture.moved) {
        if (Math.hypot(point.x - downPoint.x, point.y - downPoint.y) < DRAG_THRESHOLD_PX) return;
        gesture.moved = true;
        this.emitFeatureEvent(
          'dragstart',
          drag.feature,
          drag.layerId,
          downPoint,
          event,
          this.scene.renderedRevision,
        );
      }
      const source = this.scene.getSourceImpl(drag.feature.sourceId);
      const record = source?.store.get(drag.feature.id, drag.feature.namespace);
      if (source && drag.origin && record && record.generation === drag.feature.generation) {
        // Rigid translation of the feature by the pointer delta since drag start.
        const position = this.view.screenToPosition(point);
        const delta = this.deltaLatLng(drag.startPointer, position);
        source.mutateDrag(drag.feature, addPosition(drag.origin, delta));
      }
      this.emitFeatureEvent(
        'drag',
        drag.feature,
        drag.layerId,
        point,
        event,
        this.scene.revision,
      );
      return;
    }
    if (gesture.kind === 'box' && gesture.boxStart) {
      this.drawBox(gesture.startPoint, point);
    }
  };

  private onPointerUp = async (event: PointerEvent): Promise<void> => {
    if (this.destroyed) return;
    const point = this.pointOf(event);
    this.pressed.delete(event.pointerId);
    if (this.pendingDrag?.pointerId === event.pointerId) this.pendingDrag = null;
    const gesture = this.gesture;
    if (!gesture) {
      if (event.button === 0) void this.emitClick(point, event);
      return;
    }
    gesture.pointers.delete(event.pointerId);
    this.releasePointer(event.pointerId);
    if (gesture.kind === 'pinch' && gesture.pointers.size === 1) {
      // Continue as a pan with the remaining pointer; the pinch baseline is
      // dropped so the next two-finger contact starts fresh (INPUT-03).
      const remaining = Array.from(gesture.pointers.values())[0] ?? point;
      this.pinchDistance = undefined;
      this.pinchMidpoint = undefined;
      this.gesture = { kind: 'pan', pointers: gesture.pointers, startPoint: remaining, moved: true };
      return;
    }
    if (gesture.pointers.size > 0) return;
    this.pinchDistance = undefined;
    this.pinchMidpoint = undefined;
    this.gesture = null;
    this.element.style.cursor = 'grab';
    this.lastPointer = point;
    if (gesture.kind === 'pan') {
      if (!gesture.moved && event.button === 0) {
        void this.emitClick(point, event);
      } else {
        this.emitPointer('moveend', point, event);
      }
    } else if (gesture.kind === 'drag' && gesture.dragFeature) {
      if (!gesture.moved) {
        // A press without movement is a click on the feature, not a drag.
        const hits = await this.backend.pick(this.scene, point, { limit: 1 });
        const hit = hits[0];
        if (hit) this.emitFeature('click', hit, point, event);
      } else {
        this.emitFeatureEvent(
          'dragend',
          gesture.dragFeature.feature,
          gesture.dragFeature.layerId,
          point,
          event,
          this.scene.revision,
        );
      }
    } else if (gesture.kind === 'box' && gesture.boxStart) {
      this.clearBox();
      if (this.options.boxSelection) {
        const a = this.view.screenToPosition(gesture.startPoint);
        const b = this.view.screenToPosition(point);
        const bounds = boundsFromPositions(a, b);
        const result = this.scene.querySelection(bounds);
        this.scene.selection.set(result);
      }
      this.emitPointer('moveend', point, event);
    }
  };

  private onPointerCancel = (): void => {
    if (this.destroyed) return;
    this.pressed.clear();
    this.pendingDrag = null;
    this.pinchDistance = undefined;
    this.pinchMidpoint = undefined;
    this.gesture = null;
    this.clearBox();
    this.element.style.cursor = 'grab';
  };

  private onPointerLeave = (): void => {
    // A readback already in flight must not re-enter after the pointer left.
    this.hoverToken++;
    if (this.destroyed || !this.options.hover) return;
    if (this.hovered) {
      this.emitFeature('mouseout', this.hovered, this.lastPointer, new MouseEvent('mouseout'));
      this.setHoveredState(this.hovered, false);
      this.hovered = null;
    }
    if (!this.gesture) this.element.style.cursor = 'grab';
  };

  private panBy(dx: number, dy: number): void {
    const scale = Math.pow(2, this.view.zoom);
    const center = this.view.getSnapshot().center;
    const world = this.scene.crs.toWorld(center);
    const next = this.scene.crs.fromWorld({ x: world.x - dx / scale, y: world.y - dy / scale });
    this.view.set({ center: next });
    this.emitPointer('move', this.lastPointer, new Event('move'));
  }

  private handlePinch(): void {
    const points = Array.from(this.gesture!.pointers.values());
    if (points.length < 2) return;
    const [a, b] = points as [ScreenPoint, ScreenPoint];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const previous = this.pinchDistance;
    this.pinchDistance = distance;
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const previousMid = this.pinchMidpoint ?? midpoint;
    if (previous !== undefined && previous > 0) {
      const delta = Math.log2(distance / previous);
      if (Math.abs(delta) > 1e-4) this.view.zoomAround(midpoint, delta);
    }
    this.panBy(midpoint.x - previousMid.x, midpoint.y - previousMid.y);
    this.pinchMidpoint = midpoint;
  }

  private pinchDistance: number | undefined;
  private pinchMidpoint: ScreenPoint | undefined;

  private onWheel = (event: WheelEvent): void => {
    if (this.destroyed || !this.options.wheelZoom) return;
    // A blocked wheel must keep scrolling the page, so the check runs before
    // `preventDefault` (INPUT-09).
    if (!this.allowGesture('wheel', event, 'mouse', 1)) return;
    event.preventDefault();
    const point = this.pointOf(event);
    const delta = -event.deltaY / 1000;
    const clamped = Math.max(-0.5, Math.min(0.5, event.deltaMode === 1 ? -event.deltaY / 30 : delta));
    if (Math.abs(clamped) < 1e-4) return;
    this.view.zoomAround(point, clamped);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.destroyed || !this.options.doubleClickZoom) return;
    if (!this.allowGesture('doubleClick', event, 'mouse', 1)) return;
    this.view.zoomAround(this.pointOf(event), 1);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || !this.options.keyboard) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return; // never steal input from form fields (INPUT-07)
    }
    const panStep = 60;
    switch (event.key) {
      case 'ArrowLeft':
        this.panBy(panStep, 0);
        break;
      case 'ArrowRight':
        this.panBy(-panStep, 0);
        break;
      case 'ArrowUp':
        this.panBy(0, panStep);
        break;
      case 'ArrowDown':
        this.panBy(0, -panStep);
        break;
      case '+':
      case '=':
        this.view.zoomAround(this.centerScreen(), 0.5);
        break;
      case '-':
        this.view.zoomAround(this.centerScreen(), -0.5);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  private centerScreen(): ScreenPoint {
    const size = this.view.size;
    return { x: size.width / 2, y: size.height / 2 };
  }

  /* -------------------------------- events --------------------------------- */

  private scheduleHover(point: ScreenPoint, event: PointerEvent): void {
    this.lastPointer = point;
    if (!this.options.hover || this.hoverScheduled) return;
    this.hoverScheduled = true;
    const run = (): void => {
      this.hoverScheduled = false;
      if (this.destroyed) return;
      void this.updateHover(this.lastPointer, event);
    };
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (raf) raf(run);
    else setTimeout(run, 50);
  }

  private async updateHover(point: ScreenPoint, originalEvent: Event): Promise<void> {
    const token = ++this.hoverToken;
    const hits = await this.backend.pick(this.scene, point, { limit: 1 });
    // PICK-09: a readback of an older pointer position never overwrites the
    // state produced by a newer one.
    if (this.destroyed || token !== this.hoverToken) return;
    const hit = hits[0] ?? null;
    const previous = this.hovered;
    if (
      previous &&
      (!hit ||
        previous.feature.id !== hit.feature.id ||
        previous.feature.sourceId !== hit.feature.sourceId ||
        previous.layerId !== hit.layerId)
    ) {
      this.emitFeature('mouseout', previous, point, originalEvent);
      this.setHoveredState(previous, false);
      this.hovered = null;
    }
    if (hit) {
      if (!this.hovered) {
        this.emitFeature('mouseover', hit, point, originalEvent);
        this.setHoveredState(hit, true);
      } else {
        this.emitFeature('mousemove', hit, point, originalEvent);
      }
      this.hovered = hit;
    }
    this.updateCursor(hit);
  }

  /** Mirrors the interaction into `state.hovered` so styles can react (STYLE-05). */
  private setHoveredState(hit: PickResult, value: boolean): void {
    const source = this.scene.getSourceImpl(hit.sourceId);
    if (!source) return;
    const record = source.store.get(hit.feature.id, hit.feature.namespace);
    if (!record || record.generation !== hit.feature.generation) return;
    this.scene.state.set(hit.feature, { hovered: value });
  }

  private updateCursor(hit: PickResult | null): void {
    if (this.gesture) return;
    if (!hit) {
      this.element.style.cursor = 'grab';
      return;
    }
    this.element.style.cursor = this.scene.layers.get(hit.layerId)?.draggable ? 'move' : 'pointer';
  }

  private async emitClick(point: ScreenPoint, originalEvent: Event): Promise<void> {
    const hits = await this.backend.pick(this.scene, point, { limit: 1 });
    if (this.destroyed) return;
    const hit = hits[0];
    if (hit) this.emitFeature('click', hit, point, originalEvent);
    else this.emitPointer('click', point, originalEvent);
  }

  private emitFeature(
    type: FeatureEventType,
    hit: PickResult,
    point: ScreenPoint,
    originalEvent: Event,
  ): void {
    this.emitFeatureEvent(type, hit.feature, hit.layerId, point, originalEvent, this.scene.renderedRevision);
  }

  private emitFeatureEvent(
    type: FeatureEventType,
    feature: FeatureRef,
    layerId: string,
    point: ScreenPoint,
    originalEvent: Event,
    revision: number,
  ): void {
    const source = this.scene.getSourceImpl(feature.sourceId);
    if (source) {
      const record = source.store.get(feature.id, feature.namespace);
      if (!record || record.generation !== feature.generation) return;
    } else if (
      !this.scene.getMediaSource(feature.sourceId) &&
      !this.scene.getRasterSource(feature.sourceId)
    ) {
      // Media records (images/videos) and interactive raster sources (WMS,
      // tiles) have their own identity and interactive area but no feature
      // slots; unknown refs are still dropped.
      return;
    }
    let stopped = false;
    this.scene.emitFeatureEvent({
      type,
      feature,
      layerId,
      sourceId: feature.sourceId,
      position: this.view.screenToPosition(point),
      screen: point,
      revision,
      originalEvent,
      stopPropagation: () => {
        stopped = true;
      },
      get propagationStopped() {
        return stopped;
      },
    });
  }

  private emitPointer(type: PointerEventType, point: ScreenPoint, originalEvent: Event): void {
    this.scene.emitter.emit('pointer', {
      type,
      position: this.view.screenToPosition(point),
      screen: point,
      originalEvent,
    });
  }

  /* --------------------------------- box ----------------------------------- */

  private boxElement: HTMLDivElement | null = null;

  private drawBox(a: ScreenPoint, b: ScreenPoint): void {
    if (!this.boxElement) {
      const element = document.createElement('div');
      element.style.position = 'absolute';
      element.style.border = '1px dashed #2563eb';
      element.style.background = 'rgba(37, 99, 235, 0.08)';
      element.style.pointerEvents = 'none';
      this.element.appendChild(element);
      this.boxElement = element;
    }
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    this.boxElement.style.left = `${left}px`;
    this.boxElement.style.top = `${top}px`;
    this.boxElement.style.width = `${Math.abs(b.x - a.x)}px`;
    this.boxElement.style.height = `${Math.abs(b.y - a.y)}px`;
    this.boxElement.style.display = 'block';
  }

  private clearBox(): void {
    if (this.boxElement) this.boxElement.style.display = 'none';
  }

  /* ------------------------------ drag helpers ----------------------------- */

  private deltaLatLng(from: Position, to: Position): { dx: number; dy: number } {
    if ('lat' in from && 'lat' in to) {
      return { dx: to.lng - from.lng, dy: to.lat - from.lat };
    }
    const a = from as { x: number; y: number };
    const b = to as { x: number; y: number };
    return { dx: b.x - a.x, dy: b.y - a.y };
  }
}

function addPosition(position: Position, delta: { dx: number; dy: number }): Position {
  if ('lat' in position) {
    return { ...position, lat: position.lat + delta.dy, lng: position.lng + delta.dx };
  }
  const planar = position as { x: number; y: number };
  return { x: planar.x + delta.dx, y: planar.y + delta.dy };
}

function boundsFromPositions(a: Position, b: Position): import('../math/bounds.ts').Bounds<Position> {
  if ('lat' in a && 'lat' in b) {
    return {
      southwest: { lat: Math.min(a.lat, b.lat), lng: Math.min(a.lng, b.lng) },
      northeast: { lat: Math.max(a.lat, b.lat), lng: Math.max(a.lng, b.lng) },
    };
  }
  const planarA = a as { x: number; y: number };
  const planarB = b as { x: number; y: number };
  return {
    southwest: { x: Math.min(planarA.x, planarB.x), y: Math.min(planarA.y, planarB.y) },
    northeast: { x: Math.max(planarA.x, planarB.x), y: Math.max(planarA.y, planarB.y) },
  };
}

export { DRAG_THRESHOLD_PX };
export type { FeatureId };
