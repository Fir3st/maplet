/**
 * Font and text battery (TEXT-03/04/05, ASSET-01 font part): a registered font
 * loads late into the glyph atlas (fallback first, remeasure in a new revision),
 * failures stay visible and fall back, base direction changes bidi layout and
 * combining marks stay composed. Results: `window.__fontCheckResult`.
 */
import { createMap, crs, style as expr } from '../dist/index.js';

const result = { checks: [], pass: false, errors: [], ms: 0 };
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE_FAMILY = 'Maplet Fixture';
const MISSING_FAMILY = 'Maplet Missing Font';
const CZECH = 'Příliš žluťoučký kůň';
const BIDI = 'abc שלום';
const ACUTE = 'e\u0301';
const PRECOMPOSED = 'é';
// TEXT-03: the fixture subset carries Roboto's `liga`/`kern` features. U+200C
// (ZWNJ) blocks ligature formation and the A/V kerning pair, so the same code
// points with a ZWNJ are the unshaped control.
const LIGATURE = 'ffi';
const LIGATURE_CONTROL = 'ff\u200ci';
const KERNED = 'AV';
const LIGATURE_SET = [
  ['fi', 'f\u200ci'],
  ['fl', 'f\u200cl'],
  ['ffi', 'ff\u200ci'],
];

const mercator = crs.webMercator();
const worldCenter = mercator.toWorld({ lat: 50.05, lng: 14.45 });
const geoAt = (dx, dy) => mercator.fromWorld({
  x: worldCenter.x + dx / 2 ** 12,
  y: worldCenter.y + dy / 2 ** 12,
});

const map = await createMap('map', {
    renderer: new URLSearchParams(location.search).get('backend') === 'webgpu'
        ? { primary: 'webgpu', fallback: false }
        : { primary: 'webgl1', fallback: false },
    size: { width: 560, height: 560 },
    center: { lat: 50.05, lng: 14.45 }, zoom: 12
});

// Registered before the labels exist, with a delayed response: the first frames
// must render through the platform fallback and remeasure after the load.
const fixture = map.assets.addFont({
  id: 'fixture',
  family: FIXTURE_FAMILY,
  // Cache-busting: the checks rely on a single delayed fetch (TEXT-05).
  src: `./fonts/maplet-subset.woff2?delay=3500&r=${Date.now()}`,
});
const missing = map.assets.addFont({
  id: 'missing',
  family: MISSING_FAMILY,
  src: './fonts/does-not-exist.woff2',
});

const FEATURES = [
  ['late', geoAt(0, -240), CZECH],
  ['missing', geoAt(0, -180), 'Maplet'],
  ['dl', geoAt(0, -110), BIDI],
  ['dr', geoAt(0, -50), BIDI],
  ['s1', geoAt(0, 10), 'Maplet'],
  ['s2', geoAt(0, 70), 'Maplet'],
  ['ce', geoAt(0, 130), ACUTE],
  ['cp', geoAt(0, 190), PRECOMPOSED],
  ['lig', geoAt(150, -240), LIGATURE],
  ['ctl', geoAt(150, -180), LIGATURE_CONTROL],
  ['kern', geoAt(150, -120), KERNED],
];
const pois = map.data.vector({ id: 'pois' });
await pois.features.replace(
  FEATURES.map(([id, position, name]) => ({
    id,
    geometry: { type: 'point', position },
    properties: { name },
  })),
);
map.addLayer({ id: 'dots', type: 'points', source: pois, style: { radiusPx: 2, color: '#cbd5e1' } });
map.addLayer({
  id: 'late',
  type: 'labels',
  source: pois,
  filter: { id: 'late' },
  style: { text: expr.field('name'), sizePx: 18, fontFamily: FIXTURE_FAMILY },
});
map.addLayer({
  id: 'missing',
  type: 'labels',
  source: pois,
  filter: { id: 'missing' },
  style: { text: expr.field('name'), sizePx: 16, fontFamily: MISSING_FAMILY },
});
map.addLayer({
  id: 'dir-ltr',
  type: 'labels',
  source: pois,
  filter: { id: 'dl' },
  style: { text: expr.field('name'), sizePx: 18, fontFamily: FIXTURE_FAMILY, direction: 'ltr' },
});
map.addLayer({
  id: 'dir-rtl',
  type: 'labels',
  source: pois,
  filter: { id: 'dr' },
  style: { text: expr.field('name'), sizePx: 18, fontFamily: FIXTURE_FAMILY, direction: 'rtl' },
});
for (const [layerId, featureId] of [['share-a', 's1'], ['share-b', 's2']]) {
  map.addLayer({
    id: layerId,
    type: 'labels',
    source: pois,
    filter: { id: featureId },
    style: { text: expr.field('name'), sizePx: 16, fontFamily: FIXTURE_FAMILY },
  });
}
map.addLayer({
  id: 'comb-acute',
  type: 'labels',
  source: pois,
  filter: { id: 'ce' },
  style: { text: expr.field('name'), sizePx: 18, fontFamily: FIXTURE_FAMILY },
});
map.addLayer({
  id: 'comb-pre',
  type: 'labels',
  source: pois,
  filter: { id: 'cp' },
  style: { text: expr.field('name'), sizePx: 18, fontFamily: FIXTURE_FAMILY },
});
for (const [layerId, featureId] of [['shaping-lig', 'lig'], ['shaping-ctl', 'ctl'], ['shaping-kern', 'kern']]) {
  map.addLayer({
    id: layerId,
    type: 'labels',
    source: pois,
    filter: { id: featureId },
    style: { text: expr.field('name'), sizePx: 48, fontFamily: FIXTURE_FAMILY },
  });
}

/* --------------------------------- helpers -------------------------------- */

const anchorOf = (id) => {
  const snapshot = pois.features.get(id);
  return map.positionToScreen(snapshot.geometry.position);
};

async function inkBox(anchor, halfWidth, halfHeight, stepX = 2, stepY = 2) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let ink = 0;
  const columns = Math.floor((2 * halfWidth) / stepX) + 1;
  const profile = new Array(columns).fill(0);
  for (let y = anchor.y - halfHeight; y <= anchor.y + halfHeight; y += stepY) {
    let column = 0;
    for (let x = anchor.x - halfWidth; x <= anchor.x + halfWidth; x += stepX) {
      const pixel = await map.debug.samplePixel({ x: Math.round(x), y: Math.round(y) });
      if (pixel.a > 150 && pixel.r + pixel.g + pixel.b < 300) {
        ink++;
        profile[column]++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      column++;
    }
  }
  return { ink, width: ink > 0 ? maxX - minX : 0, height: ink > 0 ? maxY - minY : 0, profile };
}

/** Independent canvas oracle: rasterize the same text and measure its ink. */
function oracleInk(text, sizePx, family, direction, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  const font = `${sizePx}px ${family}`;
  const applyStyle = () => {
    context.font = font;
    context.direction = direction;
    context.textAlign = 'left';
    if ('fontKerning' in context) context.fontKerning = options.kerning ?? 'normal';
    context.textBaseline = 'middle';
  };
  applyStyle();
  canvas.width = canvas.width; // reset state after resize
  applyStyle();
  context.fillStyle = '#000000';
  context.fillText(text, 8, 32);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = Infinity;
  let maxX = -Infinity;
  let ink = 0;
  for (let x = 0; x < canvas.width; x++) {
    for (let y = 0; y < canvas.height; y++) {
      if (data[(y * canvas.width + x) * 4 + 3] > 150) {
        ink++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { ink, width: ink > 0 ? maxX - minX + 1 : 0 };
}

function profileDiff(a, b) {
  let diff = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    diff += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return diff;
}

function familyOf(face) {
  // CSSOM serializes family names containing spaces with quotes.
  return face.family.replace(/^["']|["']$/g, '');
}

function fixtureFaces() {
  return [...document.fonts].filter((face) => familyOf(face) === FIXTURE_FAMILY);
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

const started = performance.now();
await sleep(150);

// Measure the fallback rendering *before* the delayed font can arrive, so the
// remeasure check compares the two revisions deterministically.
const preReady = await inkBox(anchorOf('late'), 100, 14, 3, 2);
const preReadyBuild = map.debug.planBuildCount();

await check('FONT-01 a registered font is observable while loading', async () => {
  const snapshot = fixture.snapshot();
  return {
    pass:
      snapshot.state === 'loading' &&
      snapshot.family === FIXTURE_FAMILY &&
      fixtureFaces().length === 0 &&
      map.assets.listFonts().length === 2,
    detail: { snapshot, faces: fixtureFaces().length },
  };
});

await check('FONT-02 labels render with the fallback before the font is ready', async () => {
  return {
    pass: preReady.ink > 0 && fixtureFaces().length === 0,
    detail: { ink: preReady.ink, width: preReady.width, state: fixture.snapshot().state },
  };
});

let postReady = null;

await check('FONT-02b late font remeasures labels in a new revision (TEXT-05)', async () => {
  const ready = await fixture.ready();
  await sleep(250);
  postReady = await inkBox(anchorOf('late'), 100, 14, 3, 2);
  const builds = map.debug.planBuildCount();
  const oracle = oracleInk(CZECH, 18, `"${FIXTURE_FAMILY}"`, 'ltr');
  const widthDelta = Math.abs(postReady.width - oracle.width);
  const changed = Math.abs(postReady.width - preReady.width) > 2;
  return {
    pass:
      ready.state === 'ready' &&
      fixtureFaces().length === 1 &&
      builds > preReadyBuild &&
      changed &&
      postReady.ink > 0 &&
      widthDelta <= 6,
    detail: {
      ready: ready.state,
      faces: fixtureFaces().length,
      preWidth: preReady.width,
      postWidth: postReady.width,
      oracleWidth: oracle.width,
      widthDelta,
      builds: [preReadyBuild, builds],
    },
  };
});

await check('FONT-03 a failed font load is visible and falls back', async () => {
  const snapshot = await missing.ready();
  const ink = await inkBox(anchorOf('missing'), 60, 14);
  return {
    pass:
      snapshot.state === 'error' &&
      (snapshot.error ?? '').includes('failed to load') &&
      ink.ink > 0 &&
      fixtureFaces().length === 1,
    detail: { snapshot, ink: ink.ink },
  };
});

await check('FONT-04 base direction changes the bidi layout (TEXT-04)', async () => {
  const ltr = await inkBox(anchorOf('dl'), 70, 14);
  const rtl = await inkBox(anchorOf('dr'), 70, 14);
  const ltrOracle = oracleInk(BIDI, 18, `"${FIXTURE_FAMILY}"`, 'ltr');
  const rtlOracle = oracleInk(BIDI, 18, `"${FIXTURE_FAMILY}"`, 'rtl');
  const diff = profileDiff(ltr.profile, rtl.profile);
  return {
    pass:
      ltr.ink > 0 &&
      rtl.ink > 0 &&
      Math.abs(ltr.width - ltrOracle.width) <= 5 &&
      Math.abs(rtl.width - rtlOracle.width) <= 5 &&
      diff > 10,
    detail: {
      ltr: { width: ltr.width, oracle: ltrOracle.width },
      rtl: { width: rtl.width, oracle: rtlOracle.width },
      profileDiff: diff,
    },
  };
});

await check('FONT-05 combining marks stay composed (TEXT-03)', async () => {
  const acute = await inkBox(anchorOf('ce'), 24, 14, 1);
  const precomposed = await inkBox(anchorOf('cp'), 24, 14, 1);
  const acuteOracle = oracleInk(ACUTE, 18, `"${FIXTURE_FAMILY}"`, 'ltr');
  const precomposedOracle = oracleInk(PRECOMPOSED, 18, `"${FIXTURE_FAMILY}"`, 'ltr');
  return {
    pass:
      acute.ink > 0 &&
      precomposed.ink > 0 &&
      Math.abs(acute.width - precomposed.width) <= 4 &&
      Math.abs(acute.width - acuteOracle.width) <= 3 &&
      Math.abs(precomposed.width - precomposedOracle.width) <= 3,
    detail: {
      acute: { width: acute.width, oracle: acuteOracle.width, ink: acute.ink },
      precomposed: { width: precomposed.width, oracle: precomposedOracle.width, ink: precomposed.ink },
    },
  };
});

await check('FONT-07 the fixture ligature set shapes against the ZWNJ control (TEXT-03)', async () => {
  // Fixture contract first: a ligature is one glyph for several code points,
  // so its shaped ink is narrower than the ZWNJ-blocked control, which keeps
  // one glyph per code point. Measured against the fixed subset, not assumed.
  const rows = LIGATURE_SET.map(([ligature, control]) => {
    const ligatureOracle = oracleInk(ligature, 48, `"${FIXTURE_FAMILY}"`, 'ltr');
    const controlOracle = oracleInk(control, 48, `"${FIXTURE_FAMILY}"`, 'ltr');
    return {
      ligature,
      control,
      ligatureWidth: ligatureOracle.width,
      controlWidth: controlOracle.width,
    };
  });
  return {
    pass: rows.every((row) => row.ligatureWidth + 1 <= row.controlWidth),
    detail: rows,
  };
});

await check('FONT-08 atlas rendering keeps the shaped ligature and the ZWNJ control (TEXT-03)', async () => {
  // Our pipeline rasterizes the whole run and lays out by the measured
  // advance, so the shaped ligature must survive it: the rendered `ffi` is
  // narrower and has less ink (the i dot merges into the f hook) than the
  // ZWNJ control, and both match their oracle ink boxes.
  const ligature = await inkBox(anchorOf('lig'), 32, 24, 1, 2);
  const control = await inkBox(anchorOf('ctl'), 32, 24, 1, 2);
  const ligatureOracle = oracleInk(LIGATURE, 48, `"${FIXTURE_FAMILY}"`, 'ltr');
  const controlOracle = oracleInk(LIGATURE_CONTROL, 48, `"${FIXTURE_FAMILY}"`, 'ltr');
  return {
    pass:
      ligature.ink > 0 &&
      control.ink > 0 &&
      Math.abs(ligature.width - ligatureOracle.width) <= 4 &&
      Math.abs(control.width - controlOracle.width) <= 4 &&
      control.width - ligature.width >= 3 &&
      control.ink > ligature.ink,
    detail: {
      ligature: { width: ligature.width, ink: ligature.ink, oracle: ligatureOracle.width },
      control: { width: control.width, ink: control.ink, oracle: controlOracle.width },
    },
  };
});

await check('FONT-09 kerning comes from the shaped advance (TEXT-03)', async () => {
  // `AV` is a kerning pair of the fixture. The rendered label must match the
  // kerning-on oracle and stay clearly away from the kerning-off rendering, so
  // a pipeline that silently disabled kerning would fail here.
  const kerned = await inkBox(anchorOf('kern'), 44, 24, 1, 2);
  const kernedOracle = oracleInk(KERNED, 48, `"${FIXTURE_FAMILY}"`, 'ltr');
  const unkernedOracle = oracleInk(KERNED, 48, `"${FIXTURE_FAMILY}"`, 'ltr', { kerning: 'none' });
  return {
    pass:
      kerned.ink > 0 &&
      Math.abs(kerned.width - kernedOracle.width) <= 4 &&
      unkernedOracle.width - kerned.width >= 4,
    detail: {
      width: kerned.width,
      ink: kerned.ink,
      kernedOracle: kernedOracle.width,
      unkernedOracle: unkernedOracle.width,
    },
  };
});

await check('ASSET-01 two label layers share one font and one atlas entry', async () => {
  const shareA = await inkBox(anchorOf('s1'), 45, 12);
  const shareB = await inkBox(anchorOf('s2'), 45, 12);
  const labels = map.debug.layerLabels('share-a').length + map.debug.layerLabels('share-b').length;
  map.layers.remove('share-b');
  await sleep(50);
  const afterRemove = await inkBox(anchorOf('s1'), 45, 12);
  return {
    pass:
      shareA.ink > 0 &&
      shareB.ink > 0 &&
      labels === 2 &&
      fixtureFaces().length === 1 &&
      map.assets.listFonts().length === 2 &&
      afterRemove.ink > 0 &&
      map.assets.getFont('fixture')?.snapshot().state === 'ready',
    detail: {
      shareA: shareA.ink,
      shareB: shareB.ink,
      labels,
      faces: fixtureFaces().length,
      afterRemove: afterRemove.ink,
    },
  };
});

await check('FONT-06 removing the font falls back and cleans document.fonts', async () => {
  map.assets.remove('fixture');
  await sleep(250);
  const faces = fixtureFaces().length;
  const fallback = await inkBox(anchorOf('late'), 100, 14, 3, 2);
  const delta = Math.abs(fallback.width - preReady.width);
  map.destroy();
  const afterDestroy =
    fixtureFaces().length +
    [...document.fonts].filter((face) => familyOf(face) === MISSING_FAMILY).length;
  return {
    pass: faces === 0 && fallback.ink > 0 && delta <= 5 && afterDestroy === 0,
    detail: { faces, fallbackWidth: fallback.width, preReadyWidth: preReady.width, delta, afterDestroy },
  };
});

result.ms = Math.round(performance.now() - started);
result.pass = result.errors.length === 0 && result.checks.every((entry) => entry.pass) && result.checks.length === 11;
window.__fontCheckResult = result;
document.title = 'font-check-done';
const summary = document.getElementById('summary');
summary.textContent = `${result.pass ? 'PASS' : 'FAIL'} · ${result.checks.filter((entry) => entry.pass).length}/${result.checks.length} checks · ${result.ms} ms`;
summary.className = result.pass ? 'pass' : 'fail';
document.getElementById('details').textContent = JSON.stringify(result, null, 2);
