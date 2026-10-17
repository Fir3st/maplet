/**
 * Label (text) battery: Czech diacritics through the glyph atlas, anchor and
 * offset, deterministic collision suppression, label picking/hover and atlas
 * pressure with reconstruction. No DOM element per label.
 *
 * Results: `window.__labelCheckResult`. All input is synthetic; ink is measured
 * by sampling the GL back buffer.
 */
import { createMap, style as expr } from '../dist/index.js';

const SIZE = 512;
const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const map = await createMap('map', {
  renderer: {
    primary: new URLSearchParams(location.search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl1',
    fallback: false,
  },
  size: { width: SIZE, height: SIZE },
  center: { lat: 50.03, lng: 14.03 },
  zoom: 12,
});

const source = map.data.vector({ id: 'pois' });
await source.features.replace([
  {
    id: 'dia',
    geometry: { type: 'point', position: { lat: 50.06, lng: 14.06 } },
    properties: { name: 'Příliš žluťoučký kůň' },
  },
  {
    id: 'A',
    geometry: { type: 'point', position: { lat: 50.0, lng: 14.0 } },
    properties: { name: 'ALFA-ALFA', rank: 2 },
  },
  {
    id: 'B',
    geometry: { type: 'point', position: { lat: 50.0, lng: 14.0035 } },
    properties: { name: 'BETA-BETA', rank: 1 },
  },
  {
    id: 'rot',
    geometry: { type: 'point', position: { lat: 50.0, lng: 14.055 } },
    properties: { name: 'ROTACE-ROTACE' },
  },
  {
    id: 'flat',
    geometry: { type: 'point', position: { lat: 49.985, lng: 14.06 } },
    properties: { name: 'ROTACE-ROTACE' },
  },
  {
    id: 'multi',
    geometry: { type: 'point', position: { lat: 50.012, lng: 14.0 } },
    properties: { name: 'WIDE-LINE-ONE\nNARROW' },
  },
]);
map.addLayer({
  id: 'labels',
  type: 'labels',
  source,
  filter: { id: 'dia' },
  style: { text: expr.field('name'), sizePx: 14, offsetPx: { x: 0, y: -18 } },
});
map.addLayer({
  id: 'colliding',
  type: 'labels',
  source,
  filter: { or: [{ id: 'A' }, { id: 'B' }] },
  style: { text: expr.field('name'), sizePx: 14, collision: true, priority: expr.field('rank') },
});
map.addLayer({
  id: 'rotated',
  type: 'labels',
  source,
  filter: { id: 'rot' },
  style: { text: expr.field('name'), sizePx: 14, rotate: 90 },
});
map.addLayer({
  id: 'flat',
  type: 'labels',
  source,
  filter: { id: 'flat' },
  style: { text: expr.field('name'), sizePx: 14 },
});
map.addLayer({
  id: 'multi-line',
  type: 'labels',
  source,
  filter: { id: 'multi' },
  style: { text: expr.field('name'), sizePx: 14 },
});

const element = document.getElementById('map');
// Diagnostics hook for the check page and manual inspection.
window.__labelDebug = { map, source };
const sample = async (x, y) => {
  const pixel = await map.debug.samplePixel({ x, y });
  return [pixel.r, pixel.g, pixel.b, pixel.a];
};

async function inkCount(box, step = 2, threshold = 620) {
  let count = 0;
  for (let y = Math.max(0, Math.ceil(box.y0)); y < Math.min(SIZE, Math.floor(box.y1)); y += step) {
    for (
      let x = Math.max(0, Math.ceil(box.x0));
      x < Math.min(SIZE, Math.floor(box.x1));
      x += step
    ) {
      const [r, g, b, a] = await sample(x, y);
      if (a > 200 && r + g + b < threshold) count += 1;
    }
  }
  return count;
}

function pointer(type, point, options = {}) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: options.pointerId ?? 91,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerdown' ? 1 : 0,
      clientX: rect.left + point.x,
      clientY: rect.top + point.y,
    }),
  );
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    result.checks.push({ name, pass: outcome.pass, detail: outcome.detail });
  } catch (error) {
    result.errors.push(`${name}: ${String(error)}`);
    result.checks.push({ name, pass: false, detail: String(error) });
  }
}

const started = performance.now();
await sleep(400);

await check('TEXT-02 diacritics with anchor offset', async () => {
  const anchor = map.positionToScreen({ lat: 50.06, lng: 14.06 });
  // offsetPx y=-18 puts the label centre 18 CSS px above the anchor.
  const above = await inkCount(
    { x0: anchor.x - 90, y0: anchor.y - 34, x1: anchor.x + 90, y1: anchor.y - 8 },
    2,
  );
  const below = await inkCount(
    { x0: anchor.x - 90, y0: anchor.y + 8, x1: anchor.x + 90, y1: anchor.y + 34 },
    2,
  );
  const plan = map.debug.layerLabels('labels').find((entry) => entry.text.startsWith('Příliš'));
  return {
    pass: above >= 10 && below === 0 && plan?.text === 'Příliš žluťoučký kůň',
    detail: { inkAbove: above, inkBelow: below, text: plan?.text },
  };
});

await check('TEXT-01 text follows the source feature', async () => {
  source.features.update('dia', { properties: { name: 'Nový název' } });
  await sleep(250);
  const changed = map.debug.layerLabels('labels').find((entry) => entry.feature.id === 'dia');
  source.features.update('dia', { properties: { name: 'Příliš žluťoučký kůň' } });
  await sleep(250);
  const restored = map.debug.layerLabels('labels').find((entry) => entry.feature.id === 'dia');
  return {
    pass: changed?.text === 'Nový název' && restored?.text === 'Příliš žluťoučký kůň',
    detail: { changed: changed?.text, restored: restored?.text },
  };
});

await check('TEXT-07 collision suppression is deterministic', async () => {
  const a = map.positionToScreen({ lat: 50.0, lng: 14.0 });
  const b = map.positionToScreen({ lat: 50.0, lng: 14.0035 });
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '14px system-ui, sans-serif';
  const wa = measure.measureText('ALFA-ALFA').width;
  const wb = measure.measureText('BETA-BETA').width;
  // Strip right of A's box and left of B's right edge: only B would reach it.
  const exclusive = {
    x0: Math.ceil(a.x + wa / 2 + 1),
    y0: a.y - 12,
    x1: Math.ceil(b.x + wb / 2 - 2),
    y1: a.y + 12,
  };
  const withCollision = await inkCount(exclusive, 1);
  map.layers
    .get('colliding')
    .setStyle({ text: expr.field('name'), sizePx: 14, priority: expr.field('rank') });
  await sleep(300);
  const withoutCollision = await inkCount(exclusive, 1);
  const order = map.debug.layerLabels('colliding').map((entry) => entry.text);
  return {
    pass: withCollision === 0 && withoutCollision >= 4 && order.join(',') === 'ALFA-ALFA,BETA-BETA',
    detail: { withCollision, withoutCollision, order },
  };
});

await check('TEXT-06 label picking and hover', async () => {
  const events = [];
  map.onFeature((event) => events.push(`${event.type}:${String(event.feature.id)}`));
  const anchor = map.positionToScreen({ lat: 50.06, lng: 14.06 });
  const point = { x: Math.round(anchor.x), y: Math.round(anchor.y - 18) };
  pointer('pointermove', point);
  await sleep(400);
  const hovered = map.state.get(source.features.ref('dia')).hovered;
  const cursor = element.style.cursor;
  pointer('pointerdown', point);
  await sleep(40);
  pointer('pointerup', point);
  await sleep(350);
  return {
    pass:
      hovered &&
      cursor === 'pointer' &&
      events.includes('mouseover:dia') &&
      events.includes('click:dia'),
    detail: { hovered, cursor, events },
  };
});

await check('TEXT-06 label rotation keeps the anchor and turns the ink box', async () => {
  const rotAnchor = map.positionToScreen({ lat: 50.0, lng: 14.055 });
  const flatAnchor = map.positionToScreen({ lat: 49.985, lng: 14.06 });
  const box = async (anchor, halfWidth, halfHeight, stepX, stepY) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let ink = 0;
    for (let y = anchor.y - halfHeight; y <= anchor.y + halfHeight; y += stepY) {
      for (let x = anchor.x - halfWidth; x <= anchor.x + halfWidth; x += stepX) {
        const [r, g, b, a] = await sample(Math.round(x), Math.round(y));
        if (a > 200 && r + g + b < 620) {
          ink += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return ink > 0
      ? {
          ink,
          width: maxX - minX,
          height: maxY - minY,
          cx: (minX + maxX) / 2,
          cy: (minY + maxY) / 2,
        }
      : { ink: 0, width: 0, height: 0, cx: anchor.x, cy: anchor.y };
  };
  const turned = await box(rotAnchor, 12, 52, 1, 2);
  const flat = await box(flatAnchor, 52, 12, 1, 2);
  // Picking follows the rotated glyph area: the vertical text run is hit far
  // above/below the anchor, where the flat label has no ink at all.
  const probes = [];
  for (const dy of [-36, -24, -12, 12, 24, 36]) {
    const point = { x: Math.round(rotAnchor.x), y: Math.round(rotAnchor.y + dy) };
    const hits = await map.query.rendered(point);
    probes.push({ dy, rotated: hits.some((hit) => hit.feature.id === 'rot') });
  }
  // Sideways, where an unrotated label would have glyph ink, the rotated one
  // must not be hit.
  const sideHits = [];
  for (const dx of [-40, -30, 30, 40]) {
    const point = { x: Math.round(rotAnchor.x + dx), y: Math.round(rotAnchor.y) };
    const hits = await map.query.rendered(point);
    sideHits.push(hits.some((hit) => hit.feature.id === 'rot'));
  }
  const rotatedHits = probes.filter((entry) => entry.rotated).length;
  return {
    pass:
      turned.ink > 0 &&
      flat.ink > 0 &&
      Math.abs(turned.width - flat.height) <= 4 &&
      Math.abs(turned.height - flat.width) <= 6 &&
      Math.abs(turned.cx - rotAnchor.x) <= 4 &&
      Math.abs(turned.cy - rotAnchor.y) <= 4 &&
      rotatedHits >= 2 &&
      sideHits.every((value) => !value),
    detail: { turned, flat, probes, sideHits },
  };
});

await check('TEXT-09 multi-line text keeps line order, spacing and the anchor centre', async () => {
  const anchor = map.positionToScreen({ lat: 50.012, lng: 14.0 });
  const inkAt = async (dx, dy) => {
    const [r, g, b, a] = await sample(Math.round(anchor.x + dx), Math.round(anchor.y + dy));
    // Looser than the strict ink threshold: a band must cover glyph stems that
    // fall between coarse sample columns, not only the darkest texels.
    return a > 120 && r + g + b < 700;
  };
  // Vertical ink profile over a strip wider than the first line.
  const bands = [];
  let current = null;
  for (let dy = -40; dy <= 40; dy += 1) {
    let ink = 0;
    for (let dx = -58; dx <= 58; dx += 2) if (await inkAt(dx, dy)) ink += 1;
    if (ink > 0) {
      if (current) {
        current.y1 = dy;
        current.ink += ink;
      } else {
        current = { y0: dy, y1: dy, ink };
        bands.push(current);
      }
    } else current = null;
  }
  const widths = [];
  for (const band of bands) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (let dx = -58; dx <= 58; dx += 2) {
      for (let dy = band.y0; dy <= band.y1; dy += 2) {
        if (await inkAt(dx, dy)) {
          if (dx < minX) minX = dx;
          if (dx > maxX) maxX = dx;
        }
      }
    }
    widths.push(maxX === -Infinity ? 0 : maxX - minX);
  }
  const [top, bottom] = bands;
  const gap = bands.length === 2 ? bottom.y0 - top.y1 : -1;
  const lineGap = bands.length === 2 ? (bottom.y0 + bottom.y1 - top.y0 - top.y1) / 2 : -1;
  const centre = bands.length === 2 ? (top.y0 + bottom.y1) / 2 : 99;
  // Glyph ink picks on both lines; the blank inter-line band and the space
  // above the block do not.
  const picks = [];
  for (const band of bands) {
    let hit = false;
    for (const dx of [0, 10, -10, 20, -20]) {
      const hits = await map.query.rendered({
        x: Math.round(anchor.x + dx),
        y: Math.round(anchor.y + (band.y0 + band.y1) / 2),
      });
      if (hits.some((entry) => entry.feature.id === 'multi')) {
        hit = true;
        break;
      }
    }
    picks.push(hit);
  }
  const gapY =
    bands.length === 2 ? Math.round(anchor.y + (top.y1 + bottom.y0) / 2) : Math.round(anchor.y);
  const gapHits = (await map.query.rendered({ x: Math.round(anchor.x), y: gapY })).some(
    (entry) => entry.feature.id === 'multi',
  );
  const aboveHits = (
    await map.query.rendered({ x: Math.round(anchor.x), y: Math.round(anchor.y + top.y0 - 6) })
  ).some((entry) => entry.feature.id === 'multi');
  const plan = map.debug.layerLabels('multi-line').find((entry) => entry.feature.id === 'multi');
  return {
    pass:
      plan?.text === 'WIDE-LINE-ONE\nNARROW' &&
      bands.length === 2 &&
      widths[0] > widths[1] + 20 &&
      gap >= 4 &&
      Math.abs(lineGap - 19) <= 4 &&
      Math.abs(centre) <= 5 &&
      picks[0] === true &&
      picks[1] === true &&
      !gapHits &&
      !aboveHits,
    detail: { bands, widths, gap, lineGap, centre, picks, gapHits, aboveHits, text: plan?.text },
  };
});

await check('TEXT-08 atlas pressure reconstructs pages', async () => {
  const clusters = map.data.vector({ id: 'clusters' });
  const clusterA = [];
  for (let i = 0; i < 80; i++) {
    clusterA.push({
      id: `a${i}`,
      geometry: {
        type: 'point',
        position: { lat: 49.99 + (i % 10) * 0.0012, lng: 13.9 + Math.floor(i / 10) * 0.0016 },
      },
      properties: { name: `A-${String(i).padStart(3, '0')}` },
    });
  }
  const clusterB = [];
  for (let i = 0; i < 270; i++) {
    clusterB.push({
      id: `b${i}`,
      geometry: {
        type: 'point',
        position: { lat: 49.99 + (i % 18) * 0.0008, lng: 14.16 + Math.floor(i / 18) * 0.001 },
      },
      properties: { name: `B-${String(i).padStart(3, '0')}` },
    });
  }
  await clusters.features.replace([...clusterA, ...clusterB]);
  map.addLayer({
    id: 'cluster-labels',
    type: 'labels',
    source: clusters,
    style: { text: expr.field('name'), sizePx: 9 },
  });

  const viewA = { center: { lat: 49.9954, lng: 13.9056 }, zoom: 12 };
  const viewB = { center: { lat: 49.9966, lng: 14.167 }, zoom: 12 };
  const inkNearA0 = async () => {
    const anchor = map.positionToScreen({ lat: 49.99, lng: 13.9 });
    return inkCount(
      { x0: anchor.x - 16, y0: anchor.y - 8, x1: anchor.x + 16, y1: anchor.y + 8 },
      1,
      620,
    );
  };
  const waitInk = async () => {
    for (let i = 0; i < 20; i++) {
      const ink = await inkNearA0();
      if (ink >= 2) return ink;
      await sleep(150);
    }
    return 0;
  };

  map.setView(viewA);
  const before = await waitInk();
  map.setView(viewB);
  await sleep(700);
  const pressureInk = await inkNearA0(); // A is off-screen now, nothing to count
  map.setView(viewA);
  const after = await waitInk();
  return {
    pass: before >= 2 && after >= 2 && pressureInk === 0,
    detail: { inkBefore: before, inkAfterPressure: after, offscreenInk: pressureInk },
  };
});

await check('TEXT-08 no DOM element per label', async () => {
  const canvases = element.querySelectorAll('canvas').length;
  return {
    pass: canvases === 1 && element.children.length === canvases,
    detail: { canvases, children: element.children.length },
  };
});

result.ms = Math.round(performance.now() - started);
result.pass = result.errors.length === 0 && result.checks.every((entry) => entry.pass);
window.__labelCheckResult = result;
document.title = 'labels-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
