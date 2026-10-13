import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const read = file => readFileSync(join(root, file), 'utf8');
const logo = '<svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M3 7l7-3 8 3 7-3v19l-7 3-8-3-7 3V7z" stroke="currentColor" stroke-width="1.7"/><path d="M10 4v19M18 7v19" stroke="currentColor" stroke-width="1.7"/></svg>';
const repository = 'Fir3st/maplet';

export function highlightJavaScript(source) {
  const file = ts.createSourceFile('example.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const spans = [];
  function visit(node) {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    if (children.length) { children.forEach(visit); return; }
    const kind = node.kind;
    let style;
    if (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword) style = 'keyword';
    else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.RegularExpressionLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      kind >= ts.SyntaxKind.TemplateHead && kind <= ts.SyntaxKind.TemplateTail) style = 'string';
    else if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) style = 'number';
    else if (kind === ts.SyntaxKind.Identifier &&
      (ts.isCallExpression(node.parent) && node.parent.expression === node ||
       ts.isPropertyAccessExpression(node.parent) && node.parent.name === node &&
       ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent)) style = 'function';
    if (style) spans.push({ start: node.getStart(file), end: node.getEnd(), style });
    const start = node.getStart(file);
    for (const comment of [...ts.getLeadingCommentRanges(source, node.pos) ?? [], ...ts.getTrailingCommentRanges(source, node.pos) ?? []]) {
      if (comment.end <= start) spans.push({ start: comment.pos, end: comment.end, style: 'comment' });
    }
  }
  visit(file);
  spans.sort((a, b) => a.start - b.start);
  let html = '', position = 0;
  for (const span of spans) {
    if (span.start < position) continue;
    html += escapeHtml(source.slice(position, span.start));
    html += `<span class="syntax-${span.style}">${escapeHtml(source.slice(span.start, span.end))}</span>`;
    position = span.end;
  }
  return html + escapeHtml(source.slice(position));
}

// These are schematic illustrations, explicitly labeled on the gallery, not
// screenshots or claimed geographic/benchmark evidence.
function illustration(kind) {
  const grid = '<path d="M0 40H420M0 80H420M0 120H420M0 160H420M0 200H420M40 0V240M100 0V240M160 0V240M220 0V240M280 0V240M340 0V240M400 0V240" stroke="#d9e3d6" fill="none"/>';
  const dot = (x, y, color = '#176c4a') => `<circle cx="${x}" cy="${y}" r="8" fill="${color}" stroke="#fff" stroke-width="3"/>`;
  let subject;
  if (kind === 'geometry') subject = '<path d="M70 45H350V190H70Z M165 95V145H255V95Z" fill="#93bfa2" fill-rule="evenodd" stroke="#176c4a" stroke-width="2"/><path d="M30 210L115 145L200 130L275 140L385 35" fill="none" stroke="#b55337" stroke-width="5"/>';
  else if (kind === 'points') subject = Array.from({ length: 12 }, (_, i) => dot(115 + i % 4 * 64, 60 + Math.floor(i / 4) * 60, i % 3 === 0 ? '#b55337' : '#176c4a')).join('');
  else if (kind === 'bindings') subject = `<path d="M95 150L325 80" stroke="#176c4a" stroke-width="5"/>${dot(95, 150, '#b55337')}${dot(325, 80, '#b55337')}<path d="M325 100q-20 60-60 70" fill="none" stroke="#8baa92" stroke-dasharray="5 6" stroke-width="2"/>`;
  else if (kind === 'geojson') subject = '<rect x="80" y="40" width="260" height="165" rx="8" fill="#fff" stroke="#bdcbbf"/><text x="105" y="75" font-family="monospace" font-size="14" fill="#176c4a">{ FeatureCollection }</text><path d="M105 98H280M105 122H255M105 146H295M105 170H240" stroke="#bfcfc1" stroke-width="4"/>';
  else if (kind === 'labels') subject = `${dot(110, 140)}${dot(300, 140)}<rect x="70" y="82" width="80" height="30" rx="4" fill="#fff" stroke="#bdcbbf"/><rect x="248" y="82" width="104" height="30" rx="4" fill="#fff" stroke="#bdcbbf"/><text x="84" y="102" font-size="11" fill="#20372b">River walk</text><text x="260" y="102" font-size="11" fill="#20372b">Market square</text>`;
  else if (kind === 'raster') subject = '<rect x="70" y="35" width="280" height="170" fill="#e4ebd9" stroke="#8daa96"/><path d="M210 35V205M70 120H350" stroke="#8daa96"/><path d="M70 155Q160 70 210 155T350 90" fill="none" stroke="#96bcc6" stroke-width="18"/><path d="M140 35L180 205M70 75L350 175" stroke="#fff" stroke-width="9"/>';
  else if (kind === 'plugins') subject = `<rect x="80" y="45" width="260" height="154" rx="7" fill="#fff" stroke="#bdcbbf"/><path d="M80 80H340" stroke="#bdcbbf"/><text x="98" y="68" font-size="12" fill="#176c4a">map.use(pinsPlugin)</text>${dot(145, 133, '#b55337')}${dot(260, 118, '#b55337')}${dot(218, 170, '#b55337')}`;
  else subject = `<path d="M0 185Q90 90 180 130T420 65" stroke="#b9d4d3" stroke-width="22" fill="none"/><path d="M65 160L190 105L325 165" stroke="#176c4a" stroke-width="3" fill="none"/>${dot(65, 160)}${dot(190, 105)}${dot(325, 165)}<text x="45" y="135" font-size="13" fill="#20372b">Plzeň</text><text x="172" y="80" font-size="13" fill="#20372b">Praha</text><text x="307" y="140" font-size="13" fill="#20372b">Brno</text>`;
  return `<svg viewBox="0 0 420 240" aria-hidden="true">${grid}${subject}</svg>`;
}

function header(version, home) {
  return `<a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="${home}">${logo}Maplet <span class="version">${escapeHtml(version)}</span></a><nav class="header-links" aria-label="Main"><a href="${home}">Examples</a><a href="https://github.com/${repository}#readme">Documentation ↗</a><a href="https://github.com/${repository}">GitHub ↗</a></nav></header>`;
}
const footer = '<footer class="site-footer"><span>Maplet · Apache-2.0</span></footer>';
function documentHtml(title, body, script, attributes = '') {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Practical Maplet examples with live maps and source code."><title>${escapeHtml(title)} · Maplet examples</title><link rel="stylesheet" href="./style.css"></head><body ${attributes}>${body}<script type="module" src="./${script}"></script></body></html>\n`;
}

function galleryHtml(catalog, version) {
  const groups = ['All examples', ...new Set(catalog.map(entry => entry.group))];
  const cards = catalog.map((entry, i) => `
    <article class="example-card" data-group="${escapeHtml(entry.group)}">
      <a class="card-visual" href="./examples/${entry.id}/" tabindex="-1" aria-hidden="true">${illustration(entry.kind)}</a>
      <div class="card-body">
        <span class="card-number">${String(i + 1).padStart(2, '0')}</span>
        <span class="card-group">${escapeHtml(entry.group)}</span>
        <h3><a href="./examples/${entry.id}/">${escapeHtml(entry.title)}</a></h3>
        <p>${escapeHtml(entry.summary)}</p>
      </div>
      <div class="card-footer">
        <a href="./examples/${entry.id}/">Open example <span aria-hidden="true">→</span></a>
        <a class="gist-pending" data-gist="${entry.id}" aria-disabled="true">Gist not published yet</a>
      </div>
    </article>`).join('\n');
  return documentHtml('Maplet examples', `
${header(version, './')}
<main id="main" class="gallery">
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <h1 id="hero-title">Maplet examples</h1>
      <p>Interactive examples of maps, layers, data editing, GeoJSON and plugins. Each example includes its JavaScript source.</p>
      <a class="primary-link" href="./examples/basics/">Open basic example <span aria-hidden="true">→</span></a>
      <span class="hero-note">WebGL 1 by default · WebGPU available · TypeScript library</span>
    </div>
    <div class="featured">
      ${illustration('map')}
      <div class="featured-caption"><span>01 / Your first map</span><span>Schematic preview · demo data</span></div>
    </div>
  </section>
  <section aria-labelledby="collection-title">
    <div class="section-heading">
      <div><h2 id="collection-title">Examples by topic</h2><p>Filter by topic or search the examples.</p></div>
      <span class="eyebrow" id="result-count" aria-live="polite">${catalog.length} examples</span>
    </div>
    <div class="catalog-tools">
      <div role="group" aria-label="Filter by topic">${groups.map((group, i) => `<button type="button" data-filter="${escapeHtml(group)}" aria-pressed="${i === 0}">${escapeHtml(group)}</button>`).join(' ')}</div>
      <div class="search"><label for="search">Search</label><input id="search" type="search" placeholder="e.g. GeoJSON, pins…" autocomplete="off"></div>
    </div>
    <div class="example-grid">${cards}</div>
    <p class="empty" id="empty" hidden>No examples match. Try another search or choose All examples.</p>
    <noscript><p>All examples are available above. Search and filtering need JavaScript.</p></noscript>
  </section>
  <section class="getting-started" aria-labelledby="start-title">
    <div>
      <h2 id="start-title" style="margin-top:12px">Installation</h2>
      <p>These examples load the library built from this repository. In your application, install <code>@fir3st/maplet</code> from GitHub Packages or a release archive.</p>
      <p>The GitHub npm registry requires authentication. <a href="https://github.com/${repository}#builds-and-releases">Installation instructions ↗</a></p>
      <p>Original diagnostic pages and stress tests remain in <a href="https://github.com/${repository}/tree/main/demo">demo/</a>.</p>
      <p><a class="gist-pending" data-gist="index" aria-disabled="true">Collection Gist not published yet</a></p>
    </div>
    <pre class="install-code"><code>${highlightJavaScript(`import { createMap } from '@fir3st/maplet';

const map = await createMap({
  container: 'map',
  view: {
    center: { lat: 50.08, lng: 14.43 },
    zoom: 12,
  },
});

// Give #map a height, then add sources and layers.`)}</code></pre>
  </section>
</main>
${footer}`, 'gallery.js');
}

function exampleHtml(entry, catalog, version, source, gallery = '../../') {
  const index = catalog.indexOf(entry);
  const previous = catalog[index - 1], next = catalog[index + 1];
  const exampleUrl = id => `${gallery}examples/${id}/`;
  const body = `
${header(version, gallery)}
<main id="main" class="example-page">
  <div class="example-intro">
    <div>
      <a class="breadcrumb" href="${gallery}">← All examples</a>
      <span class="example-number">${String(index + 1).padStart(2, '0')} / ${escapeHtml(entry.group)}</span>
      <h1>${escapeHtml(entry.title)}</h1><p>${escapeHtml(entry.summary)}</p>
    </div>
    <p>${escapeHtml(entry.learn)}</p>
  </div>
  <section class="workspace" aria-label="Interactive example">
    <div class="map-column">
      <div class="map-toolbar">
        <label for="backend">Renderer <select id="backend"><option value="webgl1">WebGL 1</option><option value="webgpu">WebGPU + fallback</option></select></label>
        <button type="button" id="reset-view" disabled>Reset view</button>
      </div>
      <div id="map" tabindex="0" aria-label="${escapeHtml(entry.title)} interactive map"></div>
      <div class="map-foot"><span>${escapeHtml(entry.hint)}</span><output id="map-stats">Initializing renderer…</output></div>
    </div>
    <aside class="example-aside">
      <h2>Controls</h2>
      <div id="example-extra"></div><div id="example-tools"></div>
      <output id="status" aria-live="polite">Starting the map…</output>
      <p class="data-note">${escapeHtml(entry.note)}</p>
    </aside>
  </section>
  <details class="source" open>
    <summary>JavaScript source</summary>
    <div class="source-toolbar">
      <button type="button" id="copy-source">Copy source</button>
      <a href="./example.js">Download JavaScript</a>
      <a id="gist-link" aria-disabled="true">Gist not published yet</a>
      <a href="https://github.com/${repository}/blob/main/${entry.origin}">Original demo ↗</a>
    </div>
    <pre tabindex="0" aria-label="JavaScript source"><code id="source-code">${highlightJavaScript(source)}</code></pre>
    <p class="source-note">The shared <a href="./shared.js">page setup</a> creates the map and controls. For an application, import Maplet from <code>@fir3st/maplet</code> instead of the hosted build.</p>
  </details>
  <nav class="example-nav" aria-label="Other examples">
    ${previous ? `<a href="${exampleUrl(previous.id)}">← ${escapeHtml(previous.title)}</a>` : `<a href="${gallery}">← Example collection</a>`}
    ${next ? `<a href="${exampleUrl(next.id)}">${escapeHtml(next.title)} →</a>` : `<a href="${gallery}">Back to the collection →</a>`}
  </nav>
</main>
${footer}`;
  return documentHtml(entry.title, body, 'example.js', `data-example="${entry.id}" data-gallery="${escapeHtml(gallery)}"`);
}

function copyBuild(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (/(secret|token|credential|cert|crt|csr|keystore|truststore|vault|private|pass|enc)|^\.env|\.(env|pem|key|p12|pfx|cer)$/i.test(entry.name) || entry.isSymbolicLink()) {
      throw new Error('Refusing to copy a protected or linked file into the public site');
    }
    if (entry.isDirectory()) copyBuild(join(source, entry.name), join(target, entry.name));
    else if (/\.(js|d\.ts|map)$/.test(entry.name)) copyFileSync(join(source, entry.name), join(target, entry.name));
    else throw new Error('Unexpected file in the compiled library');
  }
}

export function buildExamples({ output = resolve(root, '.example-build'), baseUrl = 'https://fir3st.github.io/maplet/' } = {}) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Use a plain HTTP(S) Pages base URL');
  const catalog = JSON.parse(read('examples/catalog.json'));
  const ids = new Set();
  for (const entry of catalog) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || entry.id === 'index' || ids.has(entry.id)) throw new Error('Invalid or duplicate example ID');
    ids.add(entry.id);
  }
  const { version } = JSON.parse(read('package.json'));
  const site = join(output, 'site');
  mkdirSync(site, { recursive: true });
  copyBuild(join(root, 'dist'), join(site, 'dist'));
  const css = read('examples/style.css');
  const shared = read('examples/shared.js');
  const license = read('LICENSE'), notice = read('NOTICE');
  writeFileSync(join(site, 'index.html'), galleryHtml(catalog, version));
  writeFileSync(join(site, 'style.css'), css);
  writeFileSync(join(site, 'gallery.js'), read('examples/gallery.js'));
  writeFileSync(join(site, 'gists.json'), '{}\n');
  writeFileSync(join(site, '.nojekyll'), '');
  writeFileSync(join(site, 'LICENSE'), license);
  writeFileSync(join(site, 'NOTICE'), notice);
  const gists = [];
  for (const entry of catalog) {
    const directory = join(site, 'examples', entry.id);
    mkdirSync(directory, { recursive: true });
    const source = read(`examples/${entry.id}.js`);
    const html = exampleHtml(entry, catalog, version, source);
    const files = { 'index.html': html, 'example.js': source, 'shared.js': shared, 'style.css': css };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    gists.push({ id: entry.id, title: entry.title, files: {
      ...files,
      'index.html': exampleHtml(entry, catalog, version, source, base.href),
      'shared.js': shared.replace("from '../../dist/index.js'", `from '${new URL('dist/index.js', base).href}'`),
      'README.md': `# ${entry.title}\n\n${entry.summary}\n\n[Run the live example](${new URL(`examples/${entry.id}/`, base).href}) · [All examples](${base.href})\n\n${entry.learn}\n\n${entry.note}\n\nDownload all files into one directory and serve it over HTTP (for example with Python's http.server). The example loads the compiled Maplet library from ${base.href}; an internet connection is required for that hosted library. Gist itself does not execute HTML.\n\nGenerated from [${repository}](https://github.com/${repository}/tree/main/examples), version ${version}. These files are maintained by the examples workflow; edit the repository sources rather than this generated Gist.\n\nApache-2.0; see LICENSE and NOTICE.\n`,
      LICENSE: license, NOTICE: notice,
    } });
  }
  const plan = { repository, baseUrl: base.href, version, gists };
  if (Buffer.byteLength(JSON.stringify(plan)) > 1024 * 1024) throw new Error('Example Gist payloads exceed the 1 MiB build budget');
  writeFileSync(join(output, 'gist-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return { site, plan };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { site, plan } = buildExamples({ baseUrl: process.argv[2] });
  console.log(`Built ${plan.gists.length} examples in ${site}`);
}
