/**
 * Media battery (MEDIA-01..06, LIFE-05): an image with four known corners in
 * explicit bounds (order/opacity against other layers), URL/bounds changes that
 * touch exactly one source, partial `updateRegion` uploads with validation, a
 * two-frame video whose pump idles on pause while keeping the final frame, and
 * clean removal/destroy during playback. Results: `window.__mediaCheckResult`.
 */
import { createMap } from '../dist/index.js';

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => {
  // A failure anywhere in the module (setup included) still reports a result
  // instead of leaving the battery silent.
  result.errors.push(`unhandled: ${String(event.reason)}`);
  finalize();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  result.ms = Math.round(performance.now() - started);
  result.pass = result.errors.length === 0 && result.checks.length === 8 && result.checks.every((entry) => entry.pass);
  window.__mediaCheckResult = result;
  document.title = 'media-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
let started = 0;

const map = await createMap({
  container: 'map',
  renderer:
    new URLSearchParams(location.search).get('backend') === 'webgpu'
      ? { primary: 'webgpu', fallback: false }
      : { primary: 'webgl1', fallback: false },
  size: { width: 600, height: 600 },
  view: { center: { lat: 50.05, lng: 14.45 }, zoom: 12 },
});

const element = document.getElementById('map');
// Debug handle for post-mortem probing (`?keep=1` keeps the map alive).
window.__mediaMap = map;
const boundsFor = (x0, y0, x1, y1) => ({
  southwest: map.view.screenToPosition({ x: x0, y: y1 }),
  northeast: map.view.screenToPosition({ x: x1, y: y0 }),
});

/** 8x8 RGBA pixel fixture: color(x, y) = (x*30, y*30, 128, 255). */
function pixelsFixture() {
  const data = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const at = (y * 8 + x) * 4;
      data[at] = x * 30;
      data[at + 1] = y * 30;
      data[at + 2] = 128;
      data[at + 3] = 255;
    }
  }
  return { width: 8, height: 8, data };
}

const imageA = map.sources.image({ id: 'image-a', url: './media/corners.png', bounds: boundsFor(40, 40, 240, 240) });
const imageB = map.sources.image({ id: 'image-b', url: './media/corners-alt.png', bounds: boundsFor(200, 200, 400, 400) });
const imagePix = map.sources.image({ id: 'image-pix', pixels: pixelsFixture(), bounds: boundsFor(430, 430, 510, 510) });
const video = map.sources.video({
  id: 'video-a',
  url: './media/two-frames.mp4',
  bounds: boundsFor(40, 420, 232, 548),
  loop: true,
});

const shapes = map.sources.vector({ id: 'shapes' });
await shapes.features.replace([
  { id: 'plate', geometry: { type: 'rectangle', ...boundsFor(280, 40, 480, 240) }, properties: {} },
]);

map.layers.add({ id: 'media-a', type: 'raster', source: imageA });
map.layers.add({
  id: 'plate',
  type: 'fills',
  source: shapes,
  style: { fillColor: '#f97316', fillOpacity: 1, strokeWidthPx: 0 },
});
map.layers.add({ id: 'media-b', type: 'raster', source: imageB, style: { opacity: 0.5 } });
map.layers.add({ id: 'media-pix', type: 'raster', source: imagePix });
map.layers.add({ id: 'media-video', type: 'raster', source: video });

/* --------------------------------- helpers -------------------------------- */

const sample = (x, y) => map.debug.samplePixel({ x, y });
const near = (pixel, [r, g, b, a], tolerance = 6) =>
  Math.abs(pixel.r - r) <= tolerance &&
  Math.abs(pixel.g - g) <= tolerance &&
  Math.abs(pixel.b - b) <= tolerance &&
  Math.abs(pixel.a - a) <= tolerance;
/** Region checks sample 10 px texels; a sub-pixel quad placement can blend in
 *  a fraction of a neighbouring texel, so texel centres carry a sampling
 *  tolerance far below the changed/unchanged contrast. */
const nearTexel = (pixel, expected) => near(pixel, expected, 20);
const describe = (pixel) => `rgba(${pixel.r},${pixel.g},${pixel.b},${pixel.a})`;

async function pollSample(x, y, predicate, timeout = 2500) {
  const deadline = Date.now() + timeout;
  let pixel = await sample(x, y);
  while (Date.now() < deadline) {
    if (predicate(pixel)) return pixel;
    await sleep(80);
    pixel = await sample(x, y);
  }
  return pixel;
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

const red = (pixel) => pixel.r > 180 && pixel.g < 80 && pixel.b < 80;
const blue = (pixel) => pixel.b > 180 && pixel.r < 80 && pixel.g < 80;

const startedMark = performance.now();
started = startedMark;
await imageA.ready();
await imageB.ready();
await video.ready();

await check('MEDIA-01 image corners, opacity and layer order', async () => {
  const samples = {
    aTopLeft: await sample(90, 90),
    aTopRight: await sample(190, 90),
    aBottomLeft: await sample(90, 190),
    aBottomRight: await sample(190, 190),
    plate: await sample(400, 120),
    bOverA: await sample(220, 220),
    bOverPlate: await sample(340, 220),
    bOverBackground: await sample(220, 360),
  };
  const pass =
    near(samples.aTopLeft, [255, 0, 0, 255]) &&
    near(samples.aTopRight, [0, 200, 0, 255]) &&
    near(samples.aBottomLeft, [0, 0, 255, 255]) &&
    near(samples.aBottomRight, [255, 255, 255, 255]) &&
    near(samples.plate, [249, 115, 22, 255]) &&
    // B (yellow @ 0.5) over A's white: 0.5 * yellow + 0.5 * white.
    near(samples.bOverA, [255, 255, 128, 255]) &&
    // B (cyan @ 0.5) over the orange plate.
    near(samples.bOverPlate, [124, 185, 138, 255]) &&
    // B (magenta @ 0.5) over nothing: premultiplied readback.
    near(samples.bOverBackground, [128, 0, 128, 128]);
  const detail = Object.fromEntries(Object.entries(samples).map(([key, pixel]) => [key, describe(pixel)]));
  return { pass, detail };
});

let revisionABeforeUrl = 0;
let revisionBBeforeUrl = 0;

await check('MEDIA-02 URL and bounds changes update exactly one source', async () => {
  const before = await sample(100, 100);
  revisionABeforeUrl = imageA.snapshot().revision;
  revisionBBeforeUrl = imageB.snapshot().revision;
  imageA.update({ url: './media/corners-alt.png' });
  const ready = await imageA.ready();
  const afterUrl = await sample(100, 100);
  const otherUnchanged = await sample(340, 220);
  // Move A to the bottom-right; the old area becomes empty, the new one filled.
  // (450, 370) is A's top-right quadrant, outside B's quad.
  imageA.update({ bounds: boundsFor(300, 340, 500, 540) });
  await sleep(120);
  const oldArea = await sample(100, 100);
  const newArea = await sample(450, 370);
  const movedRevision = imageA.snapshot().revision;
  return {
    pass:
      near(before, [255, 0, 0, 255]) &&
      ready.state === 'ready' &&
      near(afterUrl, [255, 255, 0, 255]) &&
      near(otherUnchanged, [124, 185, 138, 255]) &&
      oldArea.a === 0 &&
      near(newArea, [0, 255, 255, 255]) &&
      movedRevision > revisionABeforeUrl &&
      imageB.snapshot().revision === revisionBBeforeUrl,
    detail: {
      before: describe(before),
      afterUrl: describe(afterUrl),
      otherUnchanged: describe(otherUnchanged),
      oldArea: describe(oldArea),
      newArea: describe(newArea),
      revisions: {
        a: [revisionABeforeUrl, movedRevision],
        b: [revisionBBeforeUrl, imageB.snapshot().revision],
      },
    },
  };
});

await check('MEDIA media records have their own id and interactive area', async () => {
  // Control: vector picking keeps working next to media records.
  const plateHits = await map.query.rendered({ x: 400, y: 120 });
  const hits = await map.query.rendered({ x: 450, y: 370 });
  const hit = hits[0] ?? null;
  const clicks = [];
  const off = map.on('feature', (event) => {
    if (event.type === 'click') clicks.push({ sourceId: event.sourceId, feature: event.feature });
  });
  const rect = element.getBoundingClientRect();
  const point = { x: 450, y: 370 };
  const pointer = (type) =>
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        clientX: rect.left + point.x,
        clientY: rect.top + point.y,
      }),
    );
  pointer('pointerdown');
  await sleep(60);
  pointer('pointerup');
  await sleep(350);
  off();
  return {
    pass:
      hit !== null &&
      hit.sourceId === 'image-a' &&
      hit.feature.id === 'image-a' &&
      hit.layerId === 'media-a' &&
      plateHits.length === 1 &&
      plateHits[0].feature.id === 'plate' &&
      clicks.length === 1 &&
      clicks[0].sourceId === 'image-a' &&
      clicks[0].feature.id === 'image-a',
    detail: {
      rendered: hit && { sourceId: hit.sourceId, id: hit.feature.id, layerId: hit.layerId },
      clicks: clicks.length,
      platePick: plateHits.map((entry) => `${entry.layerId}:${entry.feature.id}`),
    },
  };
});

let pixelVersionBeforeRegion = 0;

await check('MEDIA-03 updateRegion changes only the given pixels', async () => {
  const before = {
    one: await sample(445, 445),
    three: await sample(465, 465),
    five: await sample(485, 455),
  };
  pixelVersionBeforeRegion = imagePix.snapshot().pixelVersion;
  const green = new Uint8Array(2 * 2 * 4);
  for (let index = 0; index < 4; index++) {
    green[index * 4] = 0;
    green[index * 4 + 1] = 255;
    green[index * 4 + 2] = 0;
    green[index * 4 + 3] = 255;
  }
  imagePix.updateRegion({ x: 2, y: 2, width: 2, height: 2 }, green);
  await sleep(120);
  const after = {
    one: await sample(445, 445),
    twoTwo: await sample(455, 455),
    threeTwo: await sample(465, 455),
    twoThree: await sample(455, 465),
    threeThree: await sample(465, 465),
    five: await sample(485, 455),
  };
  return {
    pass:
      nearTexel(before.one, [30, 30, 128, 255]) &&
      nearTexel(before.three, [90, 90, 128, 255]) &&
      nearTexel(before.five, [150, 60, 128, 255]) &&
      nearTexel(after.one, [30, 30, 128, 255]) &&
      nearTexel(after.twoTwo, [0, 255, 0, 255]) &&
      nearTexel(after.threeTwo, [0, 255, 0, 255]) &&
      nearTexel(after.twoThree, [0, 255, 0, 255]) &&
      nearTexel(after.threeThree, [0, 255, 0, 255]) &&
      nearTexel(after.five, [150, 60, 128, 255]) &&
      imagePix.snapshot().pixelVersion === pixelVersionBeforeRegion + 1,
    detail: {
      before: { one: describe(before.one), three: describe(before.three), five: describe(before.five) },
      after: Object.fromEntries(Object.entries(after).map(([key, pixel]) => [key, describe(pixel)])),
      pixelVersion: [pixelVersionBeforeRegion, imagePix.snapshot().pixelVersion],
    },
  };
});

await check('MEDIA-04 invalid regions are refused before any change', async () => {
  const before = await sample(445, 445);
  const version = imagePix.snapshot().pixelVersion;
  const codes = [];
  const attempt = (run) => {
    try {
      run();
      codes.push('no-error');
    } catch (error) {
      codes.push(error && error.code ? error.code : String(error));
    }
  };
  attempt(() => imagePix.updateRegion({ x: 7, y: 7, width: 2, height: 2 }, new Uint8Array(16)));
  attempt(() => imagePix.updateRegion({ x: 0, y: 0, width: 2, height: 2 }, new Uint8Array(16), { stride: 4 }));
  attempt(() => imagePix.updateRegion({ x: 0, y: 0, width: 2, height: 2 }, new Uint8Array(8)));
  await sleep(80);
  const after = await sample(445, 445);
  return {
    pass:
      codes.length === 3 &&
      codes.every((code) => code === 'invalid-region') &&
      imagePix.snapshot().pixelVersion === version &&
      near(after, [before.r, before.g, before.b, before.a]),
    detail: { codes, pixelVersion: version, before: describe(before), after: describe(after) },
  };
});

let videoRevision = 0;

await check('MEDIA-05 video frames update the texture and pause stops the pump', async () => {
  const ready = video.snapshot();
  videoRevision = ready.revision;
  video.play();
  const first = await pollSample(136, 484, red);
  const second = await pollSample(136, 484, blue);
  video.pause();
  const versionAtPause = video.snapshot().pixelVersion;
  const framesAtPause = map.stats().frames;
  await sleep(700);
  const settled = await sample(136, 484);
  const snapshot = video.snapshot();
  return {
    pass:
      ready.state === 'ready' &&
      ready.width === 96 &&
      ready.height === 64 &&
      red(first) &&
      blue(second) &&
      near(settled, [second.r, second.g, second.b, second.a], 1) &&
      map.stats().frames - framesAtPause <= 1 &&
      snapshot.pixelVersion === versionAtPause &&
      snapshot.revision === videoRevision &&
      snapshot.bounds.southwest.lat === ready.bounds.southwest.lat,
    detail: {
      first: describe(first),
      second: describe(second),
      settled: describe(settled),
      frames: [framesAtPause, map.stats().frames],
      pixelVersion: [versionAtPause, snapshot.pixelVersion],
      revision: [videoRevision, snapshot.revision],
    },
  };
});

await check('LIFE-05 the scheduler draws while playing and returns to idle', async () => {
  video.play();
  const firstFrame = await pollSample(136, 484, red);
  const playingBaseline = map.stats().frames;
  await sleep(1300);
  const playingFrames = map.stats().frames - playingBaseline;
  video.pause();
  await sleep(150); // the pause final-update frame is applied here
  const idleBaseline = map.stats().frames;
  await sleep(700);
  const idleFrames = map.stats().frames - idleBaseline;
  return {
    pass: red(firstFrame) && playingFrames >= 1 && idleFrames === 0,
    detail: {
      firstFrame: describe(firstFrame),
      playingFrames,
      idleFrames,
      playError: video.snapshot().playError,
    },
  };
});

await check('MEDIA-06 removal and destroy during playback apply no late frame', async () => {
  video.play();
  await sleep(300);
  map.layers.remove('media-video');
  map.sources.remove('video-a');
  await sleep(200);
  const removedBaseline = map.stats().frames;
  await sleep(600);
  const lateFrames = map.stats().frames - removedBaseline;
  const removed = await sample(136, 484);
  const errorsBeforeDestroy = result.errors.length;

  // Destroy while a second video source is still decoding: no late frame, no
  // unhandled rejection, no callback after destroy. `?keep=1` skips the destroy
  // so the page stays inspectable while debugging the battery.
  if (new URLSearchParams(location.search).has('keep')) {
    return { pass: lateFrames === 0 && removed.a === 0 && errorsBeforeDestroy === 0, detail: { lateFrames, removed: describe(removed), keep: true } };
  }
  map.sources.video({ id: 'video-late', url: './media/two-frames.mp4', bounds: boundsFor(300, 420, 492, 548) });
  map.destroy();
  await sleep(500);
  return {
    pass:
      lateFrames === 0 &&
      removed.a === 0 &&
      errorsBeforeDestroy === 0 &&
      result.errors.length === 0,
    detail: {
      lateFrames,
      removed: describe(removed),
      errors: result.errors.length,
    },
  };
});

result.ms = Math.round(performance.now() - started);
finalize();
