import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { buildDocumentation, documentHtml, escapeHtml, renderMarkdown } from './docs-site.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');
const stylesheetHash = createHash('sha256').update(read('examples/style.css')).digest('hex').slice(0, 12);
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

/** Recursive list of `.js` files under a directory, sorted for deterministic fingerprints. */
function siteModules(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...siteModules(join(directory, entry.name), relative));
    else if (entry.name.endsWith('.js')) files.push(relative);
  }
  return files.sort();
}

const RELATIVE_MODULE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']+)\1/g;
const RELATIVE_URL = /new URL\(\s*(["'])(\.\.?\/[^"']+)\1/g;

/**
 * Every relative module or URL the site loads must exist inside the site. All
 * examples share one module graph, so a single missing file breaks every page,
 * and a URL that 404s once can stay cached as an error long after a fixed deploy.
 */
export function assertModuleGraph(site) {
  const missing = [];
  for (const relative of siteModules(site)) {
    const source = readFileSync(join(site, relative), 'utf8');
    for (const pattern of [RELATIVE_MODULE, RELATIVE_URL]) {
      for (const match of source.matchAll(pattern)) {
        const target = match[2].split(/[?#]/)[0];
        const resolved = resolve(dirname(join(site, relative)), target);
        if (!resolved.startsWith(`${site}/`)) continue;
        if (!existsSync(resolved)) missing.push(`${relative} → ${match[2]}`);
      }
    }
  }
  if (missing.length) throw new Error(`The documentation site loads missing modules:\n  ${missing.join('\n  ')}`);
}

function exampleHtml(entry, catalog, version, source, tutorial, { home = '../../', script = 'example.js' } = {}) {
  const index = catalog.indexOf(entry);
  const previous = catalog[index - 1], next = catalog[index + 1];
  const parts = tutorial.split('<!-- example -->');
  if (parts.length !== 2) throw new Error(`Tutorial ${entry.id} needs one live-example marker`);
  const context = { source: `docs/tutorials/${entry.id}.md`, home, highlight: highlightJavaScript };
  const before = renderMarkdown(parts[0], context), after = renderMarkdown(parts[1], context);
  const body = `<a class="breadcrumb" href="${home}tutorials/">Tutorials / ${escapeHtml(entry.group)}</a>${before.html}
  <section class="workspace" aria-label="Interactive example">
    <div class="map-column">
      <div class="map-toolbar"><label for="backend">Renderer <select id="backend"><option value="webgl1">WebGL 1</option><option value="webgpu">WebGPU + fallback</option></select></label><button type="button" id="reset-view" disabled>Reset view</button></div>
      <div id="map" tabindex="0" aria-label="${escapeHtml(entry.title)} interactive map"></div>
      <div class="map-foot"><span>${escapeHtml(entry.hint)}</span><output id="map-stats">Initializing renderer…</output></div>
    </div>
    <aside class="example-aside"><h2>Try it</h2><div id="example-extra"></div><div id="example-tools"></div><output id="status" aria-live="polite">Starting the map…</output><p class="data-note">${escapeHtml(entry.note)}</p></aside>
  </section>
  <details class="source" open><summary>Complete example source</summary>
    <div class="source-toolbar"><button type="button" id="copy-source">Copy source</button><a href="./example.js" download>Download JavaScript</a><a id="gist-link" aria-disabled="true">Gist not published yet</a></div>
    <pre tabindex="0" aria-label="JavaScript source"><code id="source-code">${highlightJavaScript(source)}</code></pre>
    <p class="source-note">The shared <a href="./shared.js">page setup</a> creates the map and controls. In your application, import from <code>@fir3st/maplet</code>. <a href="https://github.com/${repository}/blob/main/${entry.origin}">Original diagnostic demo ↗</a></p>
  </details>${after.html}
  <nav class="example-nav" aria-label="Other tutorials">${previous ? `<a href="${home}examples/${previous.id}/">← ${escapeHtml(previous.title)}</a>` : `<a href="${home}tutorials/">← All tutorials</a>`}${next ? `<a href="${home}examples/${next.id}/">${escapeHtml(next.title)} →</a>` : `<a href="${home}reference/">API reference →</a>`}</nav>`;
  return documentHtml({ title: entry.title, description: entry.summary, body, version, home, route: `examples/${entry.id}/`, section: 'Tutorials', catalog, headings: [...before.headings, ...after.headings], cssHash: stylesheetHash, script, attributes: `data-example="${entry.id}" data-gallery="${escapeHtml(home)}"` });
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
  const css = read('examples/style.css'), shared = read('examples/shared.js');
  const sources = new Map(catalog.map(entry => [entry.id, read(`examples/${entry.id}.js`)]));
  // Content-fingerprinted module paths: every module the documentation loads lives
  // at a URL that changes whenever any of them changes, so a deploy can never mix
  // a stale cached copy (or a cached 404) with a fresh graph. The stable `dist/`
  // copy stays for external consumers and published Gists.
  const modules = createHash('sha256').update([
    ...siteModules(join(site, 'dist')).map(file => readFileSync(join(site, 'dist', file), 'utf8')),
    shared, read('examples/gallery.js'), ...sources.values(),
  ].join('\n')).digest('hex').slice(0, 12);
  const distDirectory = `dist-${modules}`;
  const runtime = `runtime-${modules}.js`;
  const sharedRuntime = `shared-${modules}.js`;
  copyBuild(join(root, 'dist'), join(site, distDirectory));
  const license = read('LICENSE'), notice = read('NOTICE');
  const pageCount = buildDocumentation({ root, site, catalog, version, css, cssHash: stylesheetHash, scriptHash: modules, highlight: highlightJavaScript });
  writeFileSync(join(site, 'gists.json'), '{}\n');
  writeFileSync(join(site, '.nojekyll'), '');
  writeFileSync(join(site, 'LICENSE'), license);
  writeFileSync(join(site, 'NOTICE'), notice);
  const gists = [];
  for (const entry of catalog) {
    const directory = join(site, 'examples', entry.id);
    mkdirSync(directory, { recursive: true });
    const source = sources.get(entry.id), tutorial = read(`docs/tutorials/${entry.id}.md`);
    const files = {
      'index.html': exampleHtml(entry, catalog, version, source, tutorial, { script: runtime }),
      'example.js': source,
      'shared.js': shared,
      [runtime]: source.replace("from './shared.js'", `from './${sharedRuntime}'`),
      [sharedRuntime]: shared.replace("from '../../dist/index.js'", `from '../../${distDirectory}/index.js'`),
      'style.css': css,
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    gists.push({ id: entry.id, title: entry.title, files: {
      'index.html': exampleHtml(entry, catalog, version, source, tutorial, { home: base.href }),
      'example.js': source,
      'shared.js': shared.replace("from '../../dist/index.js'", `from '${new URL('dist/index.js', base).href}'`),
      'style.css': css,
      'README.md': `# ${entry.title}\n\n${entry.summary}\n\n[Read the live tutorial](${new URL(`examples/${entry.id}/`, base).href}) · [Documentation](${base.href})\n\n${entry.learn}\n\n${entry.note}\n\nDownload all files into one directory and serve it over HTTP (for example with Python's http.server). The example loads the compiled Maplet library from ${base.href}; an internet connection is required for that hosted library. Gist itself does not execute HTML.\n\nGenerated from [${repository}](https://github.com/${repository}/tree/main/examples), version ${version}. Edit the repository sources rather than this generated Gist.\n\nApache-2.0; see LICENSE and NOTICE.\n`,
      LICENSE: license, NOTICE: notice,
    } });
  }
  assertModuleGraph(site);
  const plan = { repository, baseUrl: base.href, version, gists };
  if (Buffer.byteLength(JSON.stringify(plan)) > 1024 * 1024) throw new Error('Example Gist payloads exceed the 1 MiB build budget');
  writeFileSync(join(output, 'gist-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return { site, plan, pageCount: pageCount + catalog.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { site, plan, pageCount } = buildExamples({ baseUrl: process.argv[2] });
  console.log(`Built ${pageCount} documentation pages with ${plan.gists.length} live tutorials in ${site}`);
}
