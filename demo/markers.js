/**
 * Marker battery (MARKER-01..14): Leaflet-style pins with a hover/permanent
 * tooltip, a click popup, per-marker dragging and optional clustering into
 * count badges. Pins are GPU sprites — never a DOM element per marker — while
 * the tooltip and popup are bounded DOM overlays with the UI-06 content
 * contract (strings stay text). Results: `window.__markerCheckResult`.
 */
import { createMap } from '../dist/index.js';

const WIDTH = 640;
const HEIGHT = 480;
const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass = result.errors.length === 0 && result.checks.length === 14 && result.checks.every((entry) => entry.pass);
  window.__markerCheckResult = result;
  document.title = 'marker-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
let started = 0;

const map = await createMap('map', {
  renderer: { primary: new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1', fallback: false },
  size: { width: WIDTH, height: HEIGHT },
  center: { lat: 50.0, lng: 14.0 }, zoom: 13,
});

const element = document.getElementById('map');
// Diagnostics hook for the check page and manual inspection.
window.__markerDebug = { map, element };
const screen = (x, y) => map.screenToPosition({ x, y });
const sample = (x, y) => map.debug.samplePixel({ x, y });
const near = (pixel, [r, g, b, a], tolerance = 8) =>
  Math.abs(pixel.r - r) <= tolerance &&
  Math.abs(pixel.g - g) <= tolerance &&
  Math.abs(pixel.b - b) <= tolerance &&
  (a === undefined || Math.abs(pixel.a - a) <= tolerance);
const describe = (pixel) => `rgba(${pixel.r},${pixel.g},${pixel.b},${pixel.a})`;
const anchorOf = (marker) => map.positionToScreen(marker.getPosition());
const markerLayerId = () =>
  map.layers.list({ recursive: true }).find((layer) => String(layer.id).startsWith('markers:')).id;
/** Internal count badges as frame-plan sprites; the asset id carries the label. */
const badgeSprites = () =>
  map.debug.layerSprites(markerLayerId()).filter((sprite) => String(sprite.assetId).startsWith('maplet-cluster-asset:'));
const badgeLabel = (sprite) => String(sprite.assetId).split(':').pop();

const rect = element.getBoundingClientRect();
/** DOM box in container-relative coordinates (the same space as positionToScreen). */
const domBox = (node) => {
  const box = node.getBoundingClientRect();
  return {
    left: box.left - rect.left,
    right: box.right - rect.left,
    top: box.top - rect.top,
    bottom: box.bottom - rect.top,
    cx: (box.left + box.right) / 2 - rect.left,
    width: box.width,
    height: box.height,
  };
};
const pointer = (type, x, y) =>
  element.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons: type === 'pointerdown' ? 1 : 0,
    clientX: rect.left + x, clientY: rect.top + y,
  }));
const hover = async (x, y) => { pointer('pointermove', x, y); await sleep(200); };
const click = async (x, y) => { pointer('pointerdown', x, y); await sleep(50); pointer('pointerup', x, y); await sleep(200); };
async function poll(fn, timeout = 2500) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = fn();
    if (value || Date.now() > deadline) return value;
    await sleep(60);
  }
}
async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: !!outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.checks.push({ name, pass: false, detail: String(error) });
    result.errors.push(`${name}: ${String(error)}`);
  }
}

const PIN_BODY = [37, 99, 235, 255];
const PIN_CIRCLE = [255, 255, 255, 255];
const SQUARE_GREEN = [22, 163, 74, 255];

let markerA;
let markerB;
let markerC;
// Kept reachable so the clustering checks can start from a clean layer.
let markerD;
let markerD2;
let markerE;
let markerF;
let markerG;
let markerH;
let markerI;

started = performance.now();

await check('MARKER-01 the default pin draws at the position and setPosition moves it', async () => {
  markerA = map.addMarker({ id: 'a', position: screen(320, 240), tooltip: 'Centrum', popup: 'Ahoj z markeru' });
  markerB = map.addMarker({ id: 'b', position: screen(200, 170), popup: '<b>plain</b>' });
  markerC = map.addMarker({ id: 'c', position: screen(500, 170), popup: 'C' });
  await sleep(80);
  const a = anchorOf(markerA);
  const body = await sample(Math.round(a.x), Math.round(a.y) - 26);
  const circle = await sample(Math.round(a.x), Math.round(a.y) - 19);
  const belowTip = await sample(Math.round(a.x), Math.round(a.y) + 4);
  const aboveTop = await sample(Math.round(a.x), Math.round(a.y) - 40);
  markerA.setPosition(screen(380, 260));
  await sleep(120);
  const moved = anchorOf(markerA);
  const movedBody = await sample(Math.round(moved.x), Math.round(moved.y) - 26);
  const oldBody = await sample(Math.round(a.x), Math.round(a.y) - 26);
  return {
    pass:
      near(body, PIN_BODY) &&
      near(circle, PIN_CIRCLE) &&
      belowTip.a === 0 &&
      aboveTop.a === 0 &&
      Math.abs(moved.x - 380) <= 1 &&
      Math.abs(moved.y - 260) <= 1 &&
      near(movedBody, PIN_BODY) &&
      oldBody.a === 0,
    detail: {
      body: describe(body),
      circle: describe(circle),
      belowTip: describe(belowTip),
      aboveTop: describe(aboveTop),
      movedBody: describe(movedBody),
      oldBody: describe(oldBody),
    },
  };
});

await check('MARKER-02 hover shows the tooltip text above the marker and mouseout hides it', async () => {
  const overhead = () => element.querySelector('[data-maplet-tooltip]');
  const a = anchorOf(markerA);
  await hover(Math.round(a.x), Math.round(a.y) - 18);
  const tooltip = await poll(overhead);
  const text = tooltip?.querySelector('[data-maplet-tooltip-content]')?.textContent ?? null;
  const role = tooltip?.getAttribute('role') === 'tooltip';
  const box = tooltip ? domBox(tooltip) : null;
  const above = box ? Math.abs(box.bottom - (a.y - 36)) <= 6 && Math.abs(box.cx - a.x) <= 6 : false;
  const pointerNone = tooltip ? getComputedStyle(tooltip).pointerEvents === 'none' : false;
  const openFlag = markerA.tooltipOpen;
  await hover(30, 300);
  const hidden = (await poll(() => (overhead() === null ? true : null))) === true;
  const closedFlag = !markerA.tooltipOpen;
  // A tooltip opened by API stays through mouseout until closed.
  markerA.openTooltip();
  const sticky = await poll(overhead);
  await hover(30, 320);
  const stickyStays = overhead() !== null;
  markerA.closeTooltip();
  const stickyClosed = overhead() === null;
  return {
    pass: !!tooltip && text === 'Centrum' && role && above && pointerNone && openFlag && hidden && closedFlag && !!sticky && stickyStays && stickyClosed,
    detail: { text, role, above, pointerNone, openFlag, hidden, stickyStays, stickyClosed },
  };
});

await check('MARKER-03 a click opens the popup; the close button and a background click close it', async () => {
  const a = anchorOf(markerA);
  await click(Math.round(a.x), Math.round(a.y) - 18);
  const popup = await poll(() => element.querySelector('[data-maplet-popup]'));
  const content = popup?.querySelector('[data-maplet-popup-content]')?.textContent ?? null;
  const role = popup?.getAttribute('role') === 'dialog';
  const openFlag = markerA.popupOpen;
  const box = popup ? domBox(popup) : null;
  const above = box ? Math.abs(box.bottom - (a.y - 36)) <= 6 : false;
  popup?.querySelector('button[aria-label="Close popup"]')?.click();
  await sleep(60);
  const closedByButton = element.querySelector('[data-maplet-popup]') === null && !markerA.popupOpen;
  markerA.openPopup();
  const reopened = await poll(() => element.querySelector('[data-maplet-popup]'));
  await click(30, 340);
  const closedByMap = element.querySelector('[data-maplet-popup]') === null && !markerA.popupOpen;
  return {
    pass: content === 'Ahoj z markeru' && role && openFlag && above && !!reopened && closedByButton && closedByMap,
    detail: { content, role, openFlag, above, closedByButton, closedByMap },
  };
});

await check('MARKER-04 one popup at a time and strings stay plain text', async () => {
  const b = anchorOf(markerB);
  await click(Math.round(b.x), Math.round(b.y) - 18);
  const popup = await poll(() => element.querySelector('[data-maplet-popup]'));
  const host = popup?.querySelector('[data-maplet-popup-content]');
  const text = host?.textContent ?? null;
  const parsedHtml = host?.querySelector('b') ?? null;
  const textNode = host?.querySelector('[data-maplet-text]') !== null;
  const countAfterB = element.querySelectorAll('[data-maplet-popup]').length;
  const a = anchorOf(markerA);
  await click(Math.round(a.x), Math.round(a.y) - 18);
  await sleep(150);
  const active = element.querySelector('[data-maplet-popup]');
  const activeContent = active?.querySelector('[data-maplet-popup-content]')?.textContent ?? null;
  const countAfterA = element.querySelectorAll('[data-maplet-popup]').length;
  return {
    pass:
      text === '<b>plain</b>' &&
      parsedHtml === null &&
      textNode === true &&
      countAfterB === 1 &&
      countAfterA === 1 &&
      activeContent === 'Ahoj z markeru' &&
      markerA.popupOpen &&
      !markerB.popupOpen,
    detail: { text, parsedHtml: parsedHtml === null, textNode, countAfterB, countAfterA, activeContent },
  };
});

await check('MARKER-05 Node content, permanent tooltip and set-then-unbind updates', async () => {
  const popupAt = () => element.querySelector('[data-maplet-popup]');
  const tooltipAt = () => element.querySelector('[data-maplet-tooltip]');
  const node = document.createElement('div');
  node.dataset.markerNode = 'true';
  node.textContent = 'Uzel';
  markerC.setPopup({ content: node });
  markerC.openPopup();
  const popup = await poll(popupAt);
  const containsNode = popup?.querySelector('[data-maplet-popup-content] [data-marker-node]') === node;
  markerC.setPopup(null);
  const unbound = popupAt() === null && !markerC.popupOpen;
  markerC.openPopup();
  const staysClosed = popupAt() === null;
  markerC.setPopup('Později');
  markerC.openPopup();
  const later = await poll(popupAt);
  const laterText = later?.querySelector('[data-maplet-popup-content]')?.textContent ?? null;
  markerC.closePopup();
  // Permanent tooltips appear at bind time and ignore hover in/out.
  markerC.setTooltip({ content: 'Stálý', permanent: true });
  const permanent = tooltipAt();
  const permanentText = permanent?.querySelector('[data-maplet-tooltip-content]')?.textContent ?? null;
  const permanentFlag = markerC.tooltipOpen;
  await hover(40, 260);
  const permanentStays = tooltipAt() !== null;
  markerC.setTooltip(null);
  const cleared = tooltipAt() === null && !markerC.tooltipOpen;
  markerC.setTooltip({ content: 'Zpět', permanent: true });
  const restored = tooltipAt() !== null;
  markerC.closeTooltip();
  return {
    pass: containsNode && unbound && staysClosed && laterText === 'Později' && permanentText === 'Stálý' && permanentFlag && permanentStays && cleared && restored,
    detail: { containsNode, unbound, staysClosed, laterText, permanentText, permanentFlag, permanentStays, cleared, restored },
  };
});

await check('MARKER-06 tooltip and popup follow pan and zoom', async () => {
  markerA.openTooltip();
  markerA.openPopup();
  await sleep(80);
  const boxOf = (selector) => domBox(element.querySelector(selector));
  const before = { anchor: anchorOf(markerA), popup: boxOf('[data-maplet-popup]'), tooltip: boxOf('[data-maplet-tooltip]') };
  map.setCenter({ lat: 50.012, lng: 14.012 });
  await sleep(120);
  const panned = { anchor: anchorOf(markerA), popup: boxOf('[data-maplet-popup]'), tooltip: boxOf('[data-maplet-tooltip]') };
  const dx = panned.anchor.x - before.anchor.x;
  const dy = panned.anchor.y - before.anchor.y;
  const follows = (a, b) => Math.abs(a.left - b.left - dx) <= 2 && Math.abs(a.top - b.top - dy) <= 2;
  const panFollows = follows(panned.popup, before.popup) && follows(panned.tooltip, before.tooltip);
  map.setZoom(14);
  await sleep(150);
  const zoomed = { anchor: anchorOf(markerA), popup: boxOf('[data-maplet-popup]'), tooltip: boxOf('[data-maplet-tooltip]') };
  const placed = (box, anchor) => Math.abs(box.bottom - (anchor.y - 36)) <= 6 && Math.abs(box.cx - anchor.x) <= 6;
  const zoomFollows = placed(zoomed.popup, zoomed.anchor) && placed(zoomed.tooltip, zoomed.anchor);
  markerA.closePopup();
  markerA.closeTooltip();
  return {
    pass: Math.hypot(dx, dy) > 40 && panFollows && zoomFollows,
    detail: { dx: Math.round(dx), dy: Math.round(dy), panFollows, zoomFollows },
  };
});

await check('MARKER-07 auto-pan brings an edge popup into view; autoPan: false does not', async () => {
  const popupAt = () => element.querySelector('[data-maplet-popup]');
  markerD = map.addMarker({ id: 'd', position: screen(320, 30), popup: 'Nahoru' });
  await sleep(80);
  const beforeY = anchorOf(markerD).y;
  markerD.openPopup();
  await sleep(120);
  const afterY = anchorOf(markerD).y;
  const box = popupAt() ? domBox(popupAt()) : null;
  const fits = box ? box.top >= 4 && box.bottom <= HEIGHT - 4 && box.left >= 4 && box.right <= WIDTH - 4 : false;
  const pannedDown = afterY - beforeY >= 30;
  markerD.closePopup();
  // Placed after the pan so its screen position is deterministic; auto-pan off.
  markerD2 = map.addMarker({ id: 'd2', position: screen(520, 30), popup: { content: 'Bez autopanu', autoPan: false } });
  await sleep(80);
  const d2Before = anchorOf(markerD2).y;
  markerD2.openPopup();
  await sleep(120);
  const d2Box = popupAt() ? domBox(popupAt()) : null;
  const overflowed = d2Box ? d2Box.top < 0 : false;
  const notPanned = Math.abs(anchorOf(markerD2).y - d2Before) <= 1;
  markerD2.closePopup();
  return {
    pass: pannedDown && fits && overflowed && notPanned,
    detail: { beforeY: Math.round(beforeY), afterY: Math.round(afterY), fits, overflowed, notPanned },
  };
});

await check('MARKER-08 custom icons, tint, batch add, events and removal', async () => {
  const SQUARE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    '<rect width="16" height="16" fill="#16a34a"/></svg>';
  await map.assets
    .addImage({ id: 'marker-square', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SQUARE_SVG) })
    .ready();
  const batch = map.addMarkers([
    { id: 'e', position: screen(160, 380), icon: 'marker-square', iconSize: 16, iconAnchor: { x: 0, y: -8 } },
    { id: 'f', position: screen(420, 380), iconTint: '#00ff00' },
  ]);
  await sleep(120);
  markerE = batch[0];
  markerF = batch[1];
  const e = anchorOf(markerE);
  const square = await sample(Math.round(e.x), Math.round(e.y) - 8);
  const beforeIcon = await sample(Math.round(e.x), Math.round(e.y) - 5);
  const f = anchorOf(markerF);
  const tintedBody = await sample(Math.round(f.x), Math.round(f.y) - 26);
  const tintedCircle = await sample(Math.round(f.x), Math.round(f.y) - 19);

  const events = [];
  const offClick = markerF.on('click', (event) => events.push(`click:${String(event.feature.id)}`));
  const offOver = markerF.on('mouseover', (event) => events.push(`over:${String(event.feature.id)}`));
  await hover(Math.round(f.x), Math.round(f.y) - 18);
  await poll(() => (events.includes('over:f') ? true : null));
  await click(Math.round(f.x), Math.round(f.y) - 18);
  offClick();
  offOver();

  // A popup opened near an edge autopans; measure after the view settles.
  markerA.openPopup();
  await sleep(150);
  const a = anchorOf(markerA);
  markerA.remove();
  await sleep(80);
  const removedFlag = markerA.removed === true;
  const popupGone = element.querySelector('[data-maplet-popup]') === null;
  const removedPixel = await sample(Math.round(a.x), Math.round(a.y) - 26);

  markerE.setIcon(null);
  await sleep(100);
  const eNow = anchorOf(markerE);
  const afterIcon = await sample(Math.round(eNow.x), Math.round(eNow.y) - 5);
  // Markers keep rendering without any per-marker DOM element.
  const perMarkerDom = element.querySelectorAll('[data-maplet-marker]').length;
  const openUi = element.querySelectorAll('[data-maplet-tooltip], [data-maplet-popup]').length;
  return {
    pass:
      batch.length === 2 &&
      near(square, SQUARE_GREEN, 10) &&
      near(beforeIcon, SQUARE_GREEN, 10) &&
      near(tintedBody, [0, 99, 0, 255], 10) &&
      near(tintedCircle, [0, 255, 0, 255], 10) &&
      events.includes('over:f') &&
      events.includes('click:f') &&
      removedFlag &&
      popupGone &&
      removedPixel.a === 0 &&
      near(afterIcon, PIN_BODY, 12) &&
      perMarkerDom === 0 &&
      openUi === 0,
    detail: {
      square: describe(square),
      tintedBody: describe(tintedBody),
      tintedCircle: describe(tintedCircle),
      beforeIcon: describe(beforeIcon),
      afterIcon: describe(afterIcon),
      events,
      removedFlag,
      popupGone,
      removedPixel: describe(removedPixel),
      perMarkerDom,
      openUi,
    },
  };
});

await check('MARKER-09 a draggable pin follows the pointer without panning; plain pins pan the map', async () => {
  markerG = map.addMarker({ id: 'g', position: screen(260, 320), draggable: true, tooltip: 'Drag me', popup: 'Moved' });
  markerH = map.addMarker({ id: 'h', position: screen(430, 300), tooltip: 'Fixed', popup: 'Fixed' });
  await sleep(140);
  const events = [];
  const offs = [
    markerG.on('dragstart', () => events.push('dragstart')),
    markerG.on('drag', () => events.push('drag')),
    markerG.on('dragend', (event) => events.push(`dragend:${event.screen.x.toFixed(1)},${event.screen.y.toFixed(1)}`)),
  ];

  // A draggable pin shows the move cursor; a plain pin keeps the pointer cursor.
  const g0 = anchorOf(markerG);
  await hover(Math.round(g0.x), Math.round(g0.y) - 22);
  await poll(() => (element.style.cursor === 'move' ? true : null));
  const moveCursor = element.style.cursor;
  const h0 = anchorOf(markerH);
  await hover(Math.round(h0.x), Math.round(h0.y) - 22);
  await poll(() => (element.style.cursor === 'pointer' ? true : null));
  const plainCursor = element.style.cursor;

  // Drag the pin +90/-40 px from the press point; the view must not move.
  const centerBefore = map.getCenter();
  const press = { x: Math.round(g0.x), y: Math.round(g0.y) - 22 };
  let px = press.x;
  let py = press.y;
  pointer('pointerdown', px, py);
  await sleep(80);
  for (const [dx, dy] of [[30, -14], [30, -13], [30, -13]]) {
    px += dx;
    py += dy;
    pointer('pointermove', px, py);
    await sleep(60);
  }
  pointer('pointerup', px, py);
  await sleep(160);
  const g1 = anchorOf(markerG);
  const centerAfter = map.getCenter();
  const movedBody = await sample(Math.round(g1.x), Math.round(g1.y) - 26);
  const oldSpot = await sample(Math.round(g0.x), Math.round(g0.y) - 26);
  const popupStayedShut = !markerG.popupOpen;

  // Rebuilding the appearance override (setIcon) must keep the pin draggable.
  markerG.setIcon(null);
  await sleep(140);
  const g2 = anchorOf(markerG);
  pointer('pointerdown', Math.round(g2.x), Math.round(g2.y) - 22);
  await sleep(80);
  pointer('pointermove', Math.round(g2.x) + 24, Math.round(g2.y) - 32);
  await sleep(60);
  pointer('pointerup', Math.round(g2.x) + 24, Math.round(g2.y) - 32);
  await sleep(160);
  const g3 = anchorOf(markerG);

  // A press without movement is still a click: the draggable pin opens its popup.
  const gClick = anchorOf(markerG);
  await click(Math.round(gClick.x), Math.round(gClick.y) - 22);
  await sleep(200);
  const clickOpenedPopup = markerG.popupOpen;
  markerG.closePopup();
  await sleep(100);

  // Control: pressing a plain pin and moving pans the view, never the pin.
  const hBefore = anchorOf(markerH);
  const fixedPosition = markerH.getPosition();
  const fixedCenter = map.getCenter();
  pointer('pointerdown', Math.round(hBefore.x), Math.round(hBefore.y) - 22);
  await sleep(80);
  pointer('pointermove', Math.round(hBefore.x) + 40, Math.round(hBefore.y) + 20);
  await sleep(60);
  pointer('pointerup', Math.round(hBefore.x) + 40, Math.round(hBefore.y) + 20);
  await sleep(160);
  const hPosition = markerH.getPosition();
  const pannedCenter = map.getCenter();
  const plainUnmoved = Math.abs(hPosition.lat - fixedPosition.lat) < 1e-9 && Math.abs(hPosition.lng - fixedPosition.lng) < 1e-9;
  const didPan = Math.abs(pannedCenter.lat - fixedCenter.lat) > 1e-7 || Math.abs(pannedCenter.lng - fixedCenter.lng) > 1e-7;

  // setDraggable(false) turns dragging off at runtime: the cursor returns to
  // pointer, the same gesture pans and the position stays put.
  markerG.setDraggable(false);
  await sleep(120);
  const g4 = anchorOf(markerG);
  await hover(Math.round(g4.x), Math.round(g4.y) - 22);
  await poll(() => (element.style.cursor === 'pointer' ? true : null));
  const cursorAfterOff = element.style.cursor;
  const beforeOff = markerG.getPosition();
  pointer('pointerdown', Math.round(g4.x), Math.round(g4.y) - 22);
  await sleep(80);
  pointer('pointermove', Math.round(g4.x) - 35, Math.round(g4.y) - 37);
  await sleep(60);
  pointer('pointerup', Math.round(g4.x) - 35, Math.round(g4.y) - 37);
  await sleep(160);
  const afterOff = markerG.getPosition();
  const offUnmoved = Math.abs(afterOff.lat - beforeOff.lat) < 1e-9 && Math.abs(afterOff.lng - beforeOff.lng) < 1e-9;
  for (const off of offs) off();

  const noPanWhileDragging = Math.abs(centerAfter.lat - centerBefore.lat) < 1e-9 && Math.abs(centerAfter.lng - centerBefore.lng) < 1e-9;
  return {
    pass:
      moveCursor === 'move' &&
      plainCursor === 'pointer' &&
      events.includes('dragstart') &&
      events.filter((entry) => entry === 'drag').length >= 2 &&
      events.some((entry) => entry.startsWith('dragend:')) &&
      noPanWhileDragging &&
      Math.abs(g1.x - (g0.x + 90)) <= 1.5 &&
      Math.abs(g1.y - (g0.y - 40)) <= 1.5 &&
      near(movedBody, PIN_BODY, 12) &&
      oldSpot.a === 0 &&
      Math.abs(g3.x - (g2.x + 24)) <= 1.5 &&
      Math.abs(g3.y - (g2.y - 10)) <= 1.5 &&
      popupStayedShut &&
      clickOpenedPopup &&
      plainUnmoved &&
      didPan &&
      cursorAfterOff === 'pointer' &&
      offUnmoved,
    detail: {
      moveCursor,
      plainCursor,
      events,
      noPanWhileDragging,
      anchorAfterDrag: [Math.round(g1.x), Math.round(g1.y)],
      expectedAfterDrag: [Math.round(g0.x + 90), Math.round(g0.y - 40)],
      movedBody: describe(movedBody),
      oldSpot: describe(oldSpot),
      anchorAfterIconReset: [Math.round(g3.x), Math.round(g3.y)],
      expectedAfterIconReset: [Math.round(g2.x + 24), Math.round(g2.y - 10)],
      popupStayedShut,
      clickOpenedPopup,
      plainUnmoved,
      didPan,
      cursorAfterOff,
      offUnmoved,
    },
  };
});

await check('MARKER-10 a permanent tooltip tracks its pin exactly and parks off-view', async () => {
  markerI = map.addMarker({ id: 'i', position: screen(30, 240), popup: 'Edge' });
  await sleep(140);
  markerI.setTooltip({ content: 'Edge pin', permanent: true });
  await sleep(180);
  const read = () => {
    const node = markerI.tooltipElement();
    if (!node) return null;
    const frame = element.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const anchor = anchorOf(markerI);
    return {
      dx: Math.round((box.left + box.right) / 2 - frame.left - anchor.x),
      dy: Math.round(anchor.y - (box.bottom - frame.top)),
      anchorX: Math.round(anchor.x),
      visibility: node.style.visibility,
    };
  };
  const pan = async (dx, dy) => {
    const startX = 330;
    const startY = 440;
    pointer('pointerdown', startX, startY);
    await sleep(90);
    pointer('pointermove', startX + dx / 2, startY + dy / 2);
    await sleep(70);
    pointer('pointermove', startX + dx, startY + dy);
    await sleep(70);
    pointer('pointerup', startX + dx, startY + dy);
    await sleep(240);
  };

  const before = read();
  // The tooltip used to clamp to the container edge, so panning slid it away
  // from its pin; the offset must stay the same as the view moves.
  await pan(60, -20);
  const after = read();
  // Push the pin out of the container: the overlay parks instead of sticking
  // to the edge with an arrow pointing at nothing.
  await pan(-520, 0);
  const parked = read();
  await pan(520, 0);
  const returned = read();
  markerI.remove();
  await sleep(80);
  return {
    pass:
      before !== null && Math.abs(before.dx) <= 1 && Math.abs(before.dy - 36) <= 1 &&
      after !== null && Math.abs(after.dx - before.dx) <= 1 && Math.abs(after.dy - before.dy) <= 1 &&
      parked !== null && parked.visibility === 'hidden' && parked.anchorX < 0 &&
      returned !== null && returned.visibility === '' && Math.abs(returned.dx) <= 1 && Math.abs(returned.dy - 36) <= 1,
    detail: { before, after, parked, returned },
  };
});

await check('MARKER-11 nearby pins become one count badge; a badge click zooms them apart', async () => {
  // The earlier checks leave their pins on the shared layer; the grouping
  // checks want a clean set, so remove every pin they created.
  for (const marker of [markerA, markerB, markerC, markerD, markerD2, markerE, markerF, markerG, markerH, markerI]) {
    if (marker && !marker.removed) marker.remove();
  }
  await sleep(200);
  const pinSprites = () =>
    map.debug.layerSprites(markerLayerId()).filter((sprite) => String(sprite.assetId) === 'maplet-marker-pin');
  const group = map.addMarkers([
    { id: 'j1', position: screen(200, 260) },
    { id: 'j2', position: screen(222, 274) },
    { id: 'j3', position: screen(236, 252) },
  ]);
  const far = map.addMarker({ id: 'j4', position: screen(520, 120) });
  await sleep(240);
  // Control: with clustering off every pin draws its own sprite.
  const drawnBefore = pinSprites().length;
  map.setMarkerClustering({ radiusPx: 64 });
  const options = map.getMarkerClustering();
  await sleep(280);
  const sprites = badgeSprites();
  const badge = sprites[0] ?? null;
  const spots = group.map(anchorOf);
  const centroid = {
    x: spots.reduce((sum, point) => sum + point.x, 0) / spots.length,
    y: spots.reduce((sum, point) => sum + point.y, 0) / spots.length,
  };
  const paints = {
    atCentroid: badge ? Math.abs(badge.sx - centroid.x) <= 1 && Math.abs(badge.sy - centroid.y) <= 1 : false,
    label: badge ? badgeLabel(badge) : null,
    size: badge ? badge.sizePx : null,
    // The badge replaces the pinned sprites: only the distant pin still draws.
    onlyFarPin: pinSprites().length === 1,
    farDrawn: near(await sample(520, 120 - 26), PIN_BODY),
  };
  await hover(Math.round(centroid.x), Math.round(centroid.y));
  const tooltip = await poll(() => element.querySelector('[data-maplet-tooltip]'));
  const tooltipText = tooltip?.querySelector('[data-maplet-tooltip-content]')?.textContent ?? null;
  const zoomBefore = map.getZoom();
  await click(Math.round(centroid.x), Math.round(centroid.y));
  await sleep(320);
  await hover(20, 440);
  const zoomAfter = map.getZoom();
  const badgesAfter = badgeSprites().length;
  const spread = group.map(anchorOf);
  const drawn = await Promise.all(spread.map((point) => sample(Math.round(point.x), Math.round(point.y) - 26)));
  const pinsDrawn = drawn.every((pixel) => near(pixel, PIN_BODY));
  group.forEach((marker) => marker.remove());
  far.remove();
  map.setMarkerClustering(null);
  await sleep(160);
  return {
    pass:
      drawnBefore === 4 &&
      options?.radiusPx === 64 && options?.minCount === 2 && options?.disableAtZoom === null &&
      sprites.length === 1 && paints.atCentroid && paints.label === '3' && paints.size === 34 &&
      paints.onlyFarPin && paints.farDrawn &&
      tooltipText === '3 pins' &&
      zoomAfter > zoomBefore + 1 && badgesAfter === 0 && pinsDrawn,
    detail: {
      drawnBefore, options, badges: sprites.length, ...paints, tooltipText,
      zoomBefore, zoomAfter: Math.round(zoomAfter * 100) / 100, badgesAfter, pinsDrawn,
    },
  };
});

await check('MARKER-12 cluster: false stays individual and hide() drops a member from the badge', async () => {
  map.setMarkerClustering({ radiusPx: 80 });
  const left = map.addMarker({ id: 'k1', position: screen(240, 300) });
  const middle = map.addMarker({ id: 'k2', position: screen(260, 310), cluster: false });
  const right = map.addMarker({ id: 'k3', position: screen(278, 296) });
  await sleep(260);
  const sprites = badgeSprites();
  const middleAnchor = anchorOf(middle);
  const leftAnchor = anchorOf(left);
  const middleDrawn = near(await sample(Math.round(middleAnchor.x), Math.round(middleAnchor.y) - 26), PIN_BODY);
  const leftHidden = (await sample(Math.round(leftAnchor.x), Math.round(leftAnchor.y) - 26)).a === 0;
  const label = sprites[0] ? badgeLabel(sprites[0]) : null;
  right.hide();
  await sleep(220);
  const afterHide = badgeSprites().map(badgeLabel);
  const rightGone = (await sample(Math.round(anchorOf(right).x), Math.round(anchorOf(right).y) - 26)).a === 0;
  right.show();
  await sleep(220);
  const afterShow = badgeSprites().map(badgeLabel);
  [left, middle, right].forEach((marker) => marker.remove());
  map.setMarkerClustering(null);
  await sleep(160);
  return {
    pass: sprites.length === 1 && label === '2' && middleDrawn && leftHidden &&
      afterHide.length === 0 && rightGone && afterShow.join() === '2',
    detail: { badges: sprites.length, label, middleDrawn, leftHidden, afterHide, rightGone, afterShow },
  };
});

await check('MARKER-13 radius and disableAtZoom bound the grouping', async () => {
  const left = map.addMarker({ id: 'm1', position: screen(280, 300) });
  const right = map.addMarker({ id: 'm2', position: screen(340, 300) });
  map.setMarkerClustering({ radiusPx: 40 });
  await sleep(240);
  const tight = badgeSprites().length;
  const tightDrawn = (await sample(280, 300 - 26)).a !== 0 && (await sample(340, 300 - 26)).a !== 0;
  map.setMarkerClustering({ radiusPx: 80 });
  await sleep(240);
  const wide = badgeSprites().map(badgeLabel);
  map.setMarkerClustering({ radiusPx: 80, disableAtZoom: map.getZoom() });
  await sleep(240);
  const disabled = badgeSprites().length;
  const disabledDrawn = (await sample(280, 300 - 26)).a !== 0;
  map.setMarkerClustering({ radiusPx: 80, disableAtZoom: map.getZoom() + 1 });
  await sleep(240);
  const below = badgeSprites().length;
  [left, right].forEach((marker) => marker.remove());
  map.setMarkerClustering(null);
  await sleep(160);
  return {
    pass: tight === 0 && tightDrawn && wide.join() === '2' && disabled === 0 && disabledDrawn && below === 1,
    detail: { tight, tightDrawn, wide, disabled, disabledDrawn, below, zoom: Math.round(map.getZoom() * 100) / 100 },
  };
});

await check('MARKER-14 a grouped member parks overlays and a dragged pin joins the count', async () => {
  const host = map.addMarker({ id: 'n1', position: screen(300, 300), popup: 'Host popup' });
  const partner = map.addMarker({ id: 'n2', position: screen(320, 308) });
  const rover = map.addMarker({ id: 'n3', position: screen(500, 380), draggable: true });
  await sleep(200);
  host.setTooltip({ content: 'Host pin', permanent: true });
  host.openPopup();
  await sleep(160);
  const overlayBefore = host.tooltipElement() !== null && host.popupOpen;
  map.setMarkerClustering({ radiusPx: 80 });
  await sleep(260);
  const parked = { tooltip: host.tooltipElement() === null, popup: !host.popupOpen, badges: badgeSprites().map(badgeLabel) };
  // Drag the rover onto the group: at dragend it joins the badge and disappears.
  const from = anchorOf(rover);
  const to = anchorOf(partner);
  pointer('pointerdown', Math.round(from.x), Math.round(from.y) - 22);
  await sleep(90);
  pointer('pointermove', Math.round((from.x + to.x) / 2), Math.round((from.y - 22 + to.y - 22) / 2));
  await sleep(70);
  pointer('pointermove', Math.round(to.x), Math.round(to.y - 22));
  await sleep(70);
  pointer('pointerup', Math.round(to.x), Math.round(to.y - 22));
  await sleep(300);
  const joined = {
    atTarget: Math.abs(anchorOf(rover).x - to.x) <= 1.5 && Math.abs(anchorOf(rover).y - to.y) <= 1.5,
    badges: badgeSprites().map(badgeLabel),
    hidden: (await sample(Math.round(anchorOf(rover).x), Math.round(anchorOf(rover).y) - 26)).a === 0,
  };
  map.setMarkerClustering(null);
  await sleep(220);
  const returned = {
    tooltip: host.tooltipElement() !== null,
    badges: badgeSprites().length,
    pins: (await sample(Math.round(anchorOf(host).x), Math.round(anchorOf(host).y) - 26)).a !== 0 &&
      (await sample(Math.round(to.x), Math.round(to.y) - 26)).a !== 0,
  };
  [host, partner, rover].forEach((marker) => marker.remove());
  await sleep(140);
  return {
    pass:
      overlayBefore && parked.tooltip && parked.popup && parked.badges.join() === '2' &&
      joined.atTarget && joined.badges.join() === '3' && joined.hidden &&
      returned.tooltip && returned.badges === 0 && returned.pins,
    detail: { overlayBefore, parked, joined, returned },
  };
});

result.ms = Math.round(performance.now() - started);
finalize();