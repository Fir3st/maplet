/**
 * Media battery (MEDIA-01..07, LIFE-05): an image with four known corners in
 * explicit bounds (order/opacity against other layers), URL/bounds changes that
 * touch exactly one source, placement rotation (texture corners, picking and
 * revision), partial `updateRegion` uploads with validation, a two-frame video
 * whose pump idles on pause while keeping the final frame, and clean
 * removal/destroy during playback. Results: `window.__mediaCheckResult`.
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
  result.pass = result.errors.length === 0 && result.checks.length === 10 && result.checks.every((entry) => entry.pass);
  window.__mediaCheckResult = result;
  document.title = 'media-check-done';
  const summary = document.getElementById('summary');
  summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
  summary.className = result.pass ? 'pass' : 'fail';
  document.getElementById('details').textContent = JSON.stringify(result, null, 2);
}
let started = 0;

const map = await createMap('map', {
    renderer: new URLSearchParams(location.search).get('backend') === 'webgpu'
        ? { primary: 'webgpu', fallback: false }
        : { primary: 'webgl1', fallback: false },
    size: { width: 600, height: 600 },
    center: { lat: 50.05, lng: 14.45 }, zoom: 12
});

const element = document.getElementById('map');
// Debug handle for post-mortem probing (`?keep=1` keeps the map alive).
window.__mediaMap = map;
const boundsFor = (x0, y0, x1, y1) => ({
  southwest: map.screenToPosition({ x: x0, y: y1 }),
  northeast: map.screenToPosition({ x: x1, y: y0 }),
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

const imageA = map.data.image({ id: 'image-a', url: './media/corners.png', bounds: boundsFor(40, 40, 240, 240) });
const imageB = map.data.image({ id: 'image-b', url: './media/corners-alt.png', bounds: boundsFor(200, 200, 400, 400) });
const imagePix = map.data.image({ id: 'image-pix', pixels: pixelsFixture(), bounds: boundsFor(430, 430, 510, 510) });
const video = map.data.video({
  id: 'video-a',
  url: './media/two-frames.mp4',
  bounds: boundsFor(40, 420, 232, 548),
  loop: true,
});
// A dedicated 80x160 placement for the rotation checks, clear of every other
// fixture (the video ends at x=232, image-pix starts at x=430).
const imageRot = map.data.image({ id: 'image-rot', url: './media/corners.png', bounds: boundsFor(300, 420, 380, 580) });

const shapes = map.data.vector({ id: 'shapes' });
await shapes.features.replace([
  { id: 'plate', geometry: { type: 'rectangle', ...boundsFor(280, 40, 480, 240) }, properties: {} },
]);

map.addLayer({ id: 'media-a', type: 'raster', source: imageA });
map.addLayer({
  id: 'plate',
  type: 'fills',
  source: shapes,
  style: { fillColor: '#f97316', fillOpacity: 1, strokeWidthPx: 0 },
});
map.addLayer({ id: 'media-b', type: 'raster', source: imageB, style: { opacity: 0.5 } });
map.addLayer({ id: 'media-pix', type: 'raster', source: imagePix });
map.addLayer({ id: 'media-video', type: 'raster', source: video });
map.addLayer({ id: 'media-rot', type: 'raster', source: imageRot });

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
await imageRot.ready();

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

await check('MEDIA-07 rotation maps texture corners and picking to the turned quad', async () => {
  const before = {
    topLeft: await sample(320, 460),
    topRight: await sample(360, 460),
    bottomLeft: await sample(320, 540),
    bottomRight: await sample(360, 540),
  };
  const revisionBefore = imageRot.snapshot().revision;
  const pixelVersionBefore = imageRot.snapshot().pixelVersion;
  // The 80x160 placement turns 90 degrees clockwise about its centre: the
  // texture corners follow, so the old top/bottom strips empty and the left and
  // right strips fill in.
  imageRot.update({ rotate: 90 });
  await sleep(120);
  const rotated = {
    topRightRed: await sample(380, 480),
    bottomRightGreen: await sample(380, 520),
    topLeftBlue: await sample(300, 480),
    bottomLeftWhite: await sample(300, 520),
    // Inside the old axis-aligned bounds, outside the turned quad.
    oldTop: await sample(340, 440),
    oldBottom: await sample(340, 560),
    // Outside the old bounds, inside the turned quad.
    newRight: await sample(410, 470),
  };
  const snapshot = imageRot.snapshot();
  const hits = (entries) => entries.filter((entry) => entry.feature.id === 'image-rot').length;
  const pickNewRight = hits(await map.query.rendered({ x: 410, y: 470 }));
  const pickNewLeft = hits(await map.query.rendered({ x: 280, y: 500 }));
  const pickOldTop = hits(await map.query.rendered({ x: 340, y: 440 }));
  return {
    pass:
      near(before.topLeft, [255, 0, 0, 255]) &&
      near(before.topRight, [0, 200, 0, 255]) &&
      near(before.bottomLeft, [0, 0, 255, 255]) &&
      near(before.bottomRight, [255, 255, 255, 255]) &&
      near(rotated.topRightRed, [255, 0, 0, 255]) &&
      near(rotated.bottomRightGreen, [0, 200, 0, 255]) &&
      near(rotated.topLeftBlue, [0, 0, 255, 255]) &&
      near(rotated.bottomLeftWhite, [255, 255, 255, 255]) &&
      rotated.oldTop.a === 0 &&
      rotated.oldBottom.a === 0 &&
      near(rotated.newRight, [255, 0, 0, 255]) &&
      snapshot.rotate === 90 &&
      snapshot.revision > revisionBefore &&
      snapshot.pixelVersion === pixelVersionBefore &&
      pickNewRight === 1 &&
      pickNewLeft === 1 &&
      pickOldTop === 0,
    detail: {
      before: Object.fromEntries(Object.entries(before).map(([key, pixel]) => [key, describe(pixel)])),
      rotated: Object.fromEntries(Object.entries(rotated).map(([key, pixel]) => [key, describe(pixel)])),
      revision: [revisionBefore, snapshot.revision],
      pixelVersion: [pixelVersionBefore, snapshot.pixelVersion],
      picks: [pickNewRight, pickNewLeft, pickOldTop],
    },
  };
});

await check('MEDIA-07 rotation at an arbitrary angle keeps only the turned placement', async () => {
  const revisionBeforeTurn = imageRot.snapshot().revision;
  imageRot.update({ rotate: 45 });
  await sleep(120);
  const pixels = {
    // A 45 degree turn leaves the corners of its axis-aligned box empty.
    emptyCorner: await sample(258, 418),
    emptyRight: await sample(428, 500),
    // Filled at 90 degrees, empty once the placement has turned past it.
    turnedAway: await sample(300, 460),
    filledGreen: await sample(380, 480),
    filledBlue: await sample(300, 520),
  };
  const snapshot = imageRot.snapshot();
  const hits = (entries) => entries.filter((entry) => entry.feature.id === 'image-rot').length;
  const pickFilled = hits(await map.query.rendered({ x: 380, y: 480 }));
  const pickTurnedAway = hits(await map.query.rendered({ x: 300, y: 460 }));
  const pickLeftOfDiamond = hits(await map.query.rendered({ x: 270, y: 470 }));
  return {
    pass:
      pixels.emptyCorner.a === 0 &&
      pixels.emptyRight.a === 0 &&
      pixels.turnedAway.a === 0 &&
      near(pixels.filledGreen, [0, 200, 0, 255]) &&
      near(pixels.filledBlue, [0, 0, 255, 255]) &&
      snapshot.rotate === 45 &&
      snapshot.revision > revisionBeforeTurn &&
      pickFilled === 1 &&
      pickTurnedAway === 0 &&
      pickLeftOfDiamond === 0,
    detail: {
      pixels: Object.fromEntries(Object.entries(pixels).map(([key, pixel]) => [key, describe(pixel)])),
      revision: [revisionBeforeTurn, snapshot.revision],
      picks: [pickFilled, pickTurnedAway, pickLeftOfDiamond],
    },
  };
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
  const off = map.onFeature((event) => {
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
  map.data.remove('video-a');
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
  map.data.video({ id: 'video-late', url: './media/two-frames.mp4', bounds: boundsFor(300, 420, 492, 548) });
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
