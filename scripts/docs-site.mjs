import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const repository = 'https://github.com/Fir3st/maplet';
const pages = [
  ['docs/README.md', '', 'Overview', 'Start here'],
  ['docs/tutorials/README.md', 'tutorials/', 'Tutorials', 'Start here'],
  ['docs/api-index.md', 'reference/', 'API reference', 'Start here'],
  ['docs/installation.md', 'download/', 'Download & installation', 'Start here'],
  ['docs/maps.md', 'guides/maps/', 'Maps & coordinates', 'Guides'],
  ['docs/api.md', 'guides/layers/', 'Layers & objects', 'Guides'],
  ['docs/data.md', 'guides/data/', 'Data & transactions', 'Guides'],
  ['docs/rendering.md', 'guides/rendering/', 'Styles & rendering', 'Guides'],
  ['docs/interaction.md', 'guides/interaction/', 'Interaction & UI', 'Guides'],
  ['docs/plugins.md', 'plugins/', 'Plugins', 'Guides'],
  ['docs/decisions.md', 'guides/contracts/', 'API contracts', 'Project'],
  ['docs/status.md', 'guides/status/', 'Status & limitations', 'Project'],
  ['docs/development.md', 'guides/development/', 'Development', 'Project'],
  ['docs/examples.md', 'guides/website/', 'Website publication', 'Project'],
  ['docs/background.md', 'guides/background/', 'Background', 'Project'],
];
const routes = new Map(pages.map(([file, route]) => [file, route]));
const slug = text => text.toLowerCase().replace(/[`*]/g, '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/ /g, '-');

function linkTo(target, source, home) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [file, fragment] = target.split('#');
  const path = posix.normalize(posix.join(posix.dirname(source), file));
  const route = routes.get(path);
  return (route === undefined ? `${repository}/blob/main/${path}` : `${home}${route}`) + (fragment ? `#${fragment}` : '');
}

function inline(text, source, home) {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let html = '', end = 0;
  for (const match of text.matchAll(pattern)) {
    html += escapeHtml(text.slice(end, match.index));
    if (match[1] !== undefined) html += `<code>${escapeHtml(match[1])}</code>`;
    else if (match[2] !== undefined) html += `<a href="${escapeHtml(linkTo(match[3], source, home))}">${escapeHtml(match[2])}</a>`;
    else html += `<strong>${escapeHtml(match[4])}</strong>`;
    end = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(end));
}

function tableCells(line) {
  const cells = [];
  let cell = '', code = false;
  for (const char of line.trim().replace(/^\||\|$/g, '')) {
    if (char === '`') code = !code;
    if (char === '|' && !code) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** Render the deliberately small Markdown vocabulary used by the authored guides. */
export function renderMarkdown(markdown, { source = 'docs/README.md', home = './', highlight = escapeHtml } = {}) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const headings = [], used = new Map();
  let html = '', i = 0;
  const text = value => inline(value, source, home);
  const boundary = line => !line.trim() || /^(#{1,6} |```|[-*] |\d+\. |>|\|)/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const block = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) block.push(lines[i]);
      if (i === lines.length) throw new Error(`Unclosed code fence in ${source}`);
      i++;
      const code = block.join('\n');
      html += `<pre tabindex="0" aria-label="${escapeHtml(language || 'Code')} example"><code>${/^(ts|js|javascript|typescript)$/.test(language) ? highlight(code) : escapeHtml(code)}</code></pre>`;
    } else if (/^#{1,6} /.test(line)) {
      const [, hashes, title] = /^(#{1,6}) (.+)$/.exec(line);
      const base = slug(title), count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      if (hashes.length === 2) headings.push({ id, title });
      html += `<h${hashes.length} id="${id}">${text(title)}<a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(title)}">#</a></h${hashes.length}>`;
      i++;
    } else if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const head = tableCells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(tableCells(lines[i]));
      html += `<div class="table-scroll" tabindex="0" role="region" aria-label="Reference table"><table><thead><tr>${head.map(cell => `<th scope="col">${text(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${text(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else if (/^[-*] |^\d+\. /.test(line)) {
      const ordered = /^\d/.test(line), items = [];
      const start = ordered ? /^\d+\. / : /^[-*] /;
      while (i < lines.length && start.test(lines[i])) {
        const item = [lines[i++].replace(start, '')];
        while (i < lines.length && /^\s+\S/.test(lines[i])) item.push(lines[i++].trim());
        items.push(item.join(' '));
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>${items.map(item => `<li>${text(item)}</li>`).join('')}</${tag}>`;
    } else if (line.startsWith('>')) {
      const block = [];
      while (i < lines.length && lines[i].startsWith('>')) block.push(lines[i++].replace(/^> ?/, ''));
      html += `<blockquote>${text(block.join(' '))}</blockquote>`;
    } else {
      const block = [lines[i++]];
      while (i < lines.length && !boundary(lines[i])) block.push(lines[i++]);
      html += `<p>${text(block.join(' '))}</p>`;
    }
  }
  return { html, headings };
}

export function header(version, home, section) {
  const nav = [['Overview', ''], ['Tutorials', 'tutorials/'], ['Reference', 'reference/'], ['Download', 'download/'], ['Plugins', 'plugins/']];
  return `<a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="${home}"><svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M3 7l7-3 8 3 7-3v19l-7 3-8-3-7 3V7zM10 4v19M18 7v19" stroke="currentColor" stroke-width="1.7"/></svg>Maplet <span class="version">${escapeHtml(version)}</span></a><nav class="header-links" aria-label="Main">${nav.map(([title, route]) => `<a href="${home}${route}"${section === title ? ' aria-current="page"' : ''}>${title}</a>`).join('')}<a href="${repository}">GitHub ↗</a></nav></header>`;
}

export function sidebar(home, current, catalog) {
  let content = '';
  if (current.startsWith('reference/')) content += `<div class="nav-group"><span>API reference</span>${referenceGroups.map(([id, title]) => `<a href="${home}reference/${id}/"${current === `reference/${id}/` ? ' aria-current="page"' : ''}>${title}</a>`).join('')}<a href="${home}reference/types/"${current === 'reference/types/' ? ' aria-current="page"' : ''}>Other types & utilities</a></div>`;
  for (const group of ['Start here', 'Guides', 'Tutorials', 'Project']) {
    const entries = group === 'Tutorials'
      ? catalog.map(entry => [`examples/${entry.id}/`, entry.title])
      : pages.filter(page => page[3] === group).map(page => [page[1], page[2]]);
    content += `<div class="nav-group"><span>${group}</span>${entries.map(([route, title]) => `<a href="${home}${route}"${route === current ? ' aria-current="page"' : ''}>${escapeHtml(title)}</a>`).join('')}</div>`;
  }
  return `<aside class="sidebar"><details open><summary>Documentation menu</summary><nav aria-label="Documentation">${content}</nav></details></aside>`;
}

export function documentHtml({ title, description, body, version, home = './', route = '', section = 'Overview', catalog, headings = [], cssHash, script, attributes = '' }) {
  const toc = headings.length ? `<aside class="toc"><nav aria-label="On this page"><span>On this page</span>${headings.map(heading => `<a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.title.replace(/[`*]/g, ''))}</a>`).join('')}</nav></aside>` : '';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><title>${escapeHtml(title)} · Maplet documentation</title><link rel="stylesheet" href="./style.css?v=${cssHash}"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='5' fill='%23176c4a'/%3E%3Cpath d='M6 9l6-2 8 2 6-2v16l-6 2-8-2-6 2V9zM12 7v16M20 9v16' fill='none' stroke='white'/%3E%3C/svg%3E"></head><body ${attributes}>${header(version, home, section)}<div class="docs-layout">${sidebar(home, route, catalog)}<main id="main" class="doc-content">${body}</main>${toc}</div><footer class="site-footer"><span>Maplet · ${escapeHtml(version)} · Apache-2.0</span><a href="${home}guides/status/#known-limitations">Alpha limitations</a><a href="${repository}/issues">Report an issue ↗</a></footer><script>const menu=document.querySelector('.sidebar details');const narrow=matchMedia('(max-width: 800px)');function setMenu(){menu.open=!narrow.matches;}setMenu();narrow.addEventListener('change',setMenu);</script>${script ? `<script type="module" src="./${script}"></script>` : ''}</body></html>\n`;
}

const referenceGroups = [
  ['map', 'Map & view', ['createMap', 'MapHandle', 'MapOptions', 'RendererOptions', 'ViewSnapshot', 'ViewUpdate', 'FitOptions', 'FlyOptions', 'FitPadding', 'Clock', 'defaultClock']],
  ['layers', 'Layers & objects', ['LayerHandle', 'LayerContent', 'LayerEntry', 'LayerOptions', 'LayersHandle', 'SourceLayerSpec', 'RenderLayerHandle', 'ObjectOptions', 'MoveTarget', 'FeatureHandle', 'PointHandle', 'LineHandle', 'PolygonHandle', 'PointsLayerHandle', 'LinesLayerHandle', 'PolygonsLayerHandle', 'VectorLayerHandle', 'RasterLayerHandle', 'PointInput', 'LineInput', 'PolygonInput']],
  ['data', 'Sources & data', ['SourcesHandle', 'VectorSourceHandle', 'FeaturesHandle', 'FeatureInput', 'FeaturePatch', 'FeatureRef', 'FeatureId', 'SourceSnapshot', 'SourceChange', 'FeatureQueryOptions', 'ColumnarBatch', 'ColumnarPointBatch', 'ColumnarPartsBatch', 'ColumnarImportOptions', 'RasterTilesOptions', 'WmsOptions', 'TilesOptions', 'WmsLayerOptions', 'RasterSourceHandle', 'VectorTilesOptions', 'VectorTilesSourceHandle', 'VectorTilesFeaturesHandle', 'ImageSourceOptions', 'VideoSourceOptions', 'MediaSourceHandle', 'RelationsHandle', 'RelationInput', 'BindingsHandle', 'BindingInput', 'GeometryBindingDescriptor', 'CopyPropertyDescriptor']],
  ['styles', 'Styles & assets', ['style', 'PointsLayerStyle', 'LinesLayerStyle', 'FillsLayerStyle', 'LabelsLayerStyle', 'RasterLayerStyle', 'FeatureOverride', 'Expression', 'ExpressionInput', 'Filter', 'ColorValue', 'AssetsHandle', 'ImageAssetHandle', 'FontAssetHandle']],
  ['interaction', 'Events & UI', ['InteractionHandle', 'InteractionOptions', 'FeatureEvents', 'FeatureEvent', 'FeatureEventType', 'MapEventTypes', 'MapClickEvent', 'MapFeatureEvent', 'MapPointerEvent', 'SubscribeOptions', 'Unsubscribe', 'StateHandle', 'SelectionHandle', 'QueryHandle', 'AreaQueryOptions', 'AreaQueryResult', 'QueryCursor', 'ControlKind', 'ControlSpec', 'ControlHandle', 'ListControlOptions', 'DetailServiceHandle', 'DetailOptions', 'DetailHandle', 'LocateHandle', 'LocateOptions', 'LocateResult', 'LocateWatchOptions', 'LocateWatch']],
  ['plugins', 'Plugins & rendering', ['Plugin', 'PluginContext', 'PluginHandle', 'RenderHandle', 'CustomRenderer', 'RenderFrame', 'FramePlan', 'PlanBatch', 'PickResult', 'Capabilities', 'MapStats', 'DebugHandle', 'MapletError', 'MapletErrorCode', 'isMapletError']],
];

// Behavioral descriptions complement signatures, which always come from declarations.
const memberDescriptions = {
  MapHandle: {
    getView: 'Read the current canonical view snapshot.', setView: 'Update center and/or zoom in one commit.',
    getCenter: 'Read the canonical center as an object position.', setCenter: 'Change center; geographic tuples use latitude first.',
    getZoom: 'Read the current zoom.', setZoom: 'Change zoom within configured limits.',
    getBounds: 'Read the visible geographic or planar bounds.', fitBounds: 'Fit data bounds with optional padding and maximum zoom; null is a no-op.',
    flyTo: 'Animate to a view and resolve when motion ends.', stop: 'Cancel the current view animation.',
    zoomAround: 'Change zoom while keeping a CSS-pixel screen anchor fixed.', resize: 'Update layout size in CSS pixels.',
    positionToScreen: 'Convert a position to CSS pixels from the top-left of the container.', screenToPosition: 'Convert CSS pixels to a canonical position.',
    base: 'Lazy shared root layer for direct map additions; id base is reserved.',
    batch: 'Commit synchronous edits atomically; failures roll back and nested batches join the outer batch.',
    whenRendered: 'Wait for a logical revision to reach the screen; supports AbortSignal cancellation.',
    addLayer: 'Create a root logical layer, or an advanced source-backed render pass.',
    addPoints: 'Add a typed point collection to the shared base, from inline data or a shared vector source.',
    addLines: 'Add a typed line collection to the shared base.', addPolygons: 'Add a fill collection; rings are exterior first, then holes.',
    addLabels: 'Render labels from shared vector data; text defaults to the name property.',
    addTiles: 'Create an XYZ/TMS tile source and raster pass together.', addWms: 'Create a WMS source and raster pass together.',
    addImage: 'Place an image or RGBA pixels into explicit bounds.', addVideo: 'Place a video into explicit bounds.',
    on: 'Subscribe to a named event and return an unsubscribe function.', once: 'Subscribe until the requested event occurs once.',
    off: 'Remove a map listener by event type and callback.', onFeature: 'Observe feature events only, excluding background clicks.',
    use: 'Install a synchronous plugin and return its API and removal handle.', destroy: 'Release the scene, renderer, subscriptions, controls and plugins.',
    destroyed: 'Whether this map has been destroyed.', capabilities: 'Inspect the effective backend and supported capabilities.',
    stats: 'Read current revision, feature, draw-call, GPU storage and picking counters.',
  },
  LayerHandle: {
    isVisible: 'Read effective visibility, including all ancestor flags.',
    show: 'Set this layer visible without resetting hidden descendants.', hide: 'Hide this complete subtree without deleting data.',
    move: 'Reorder or reparent this entry and its current subtree; cycles are rejected.',
    remove: 'Remove current descendants; moved-out children survive and shared-source ownership is respected.',
    parentId: 'Current parent id, or null at the map root.', removed: 'Whether this handle has been invalidated by removal or map destruction.',
  },
  RenderLayerHandle: {
    setStyle: 'Replace the complete base style of this render pass.', setFilter: 'Replace its declarative filter; null removes the filter.',
    update: 'Patch render-pass options; changing parent requires move().',
    setFeatureStyle: 'Set a render-pass-local override for an ID or generation-bound reference.',
    clearFeatureStyle: 'Remove a render-pass-local override.',
  },
  FeatureHandle: {
    get: 'Return a readonly snapshot; geometry and top-level properties are copied, nested property values remain shared.',
    setProperties: 'Merge property keys; undefined deletes a key.', setGeometry: 'Replace canonical geometry in a commit.',
    setStyle: 'Patch this object’s local style override.', clearStyle: 'Restore the collection’s style.',
    hide: 'Exclude this object from rendering without deleting its data.', show: 'Restore this object’s visibility override.',
    select: 'Add this generation-bound reference to shared selection.', deselect: 'Remove it from shared selection.',
    remove: 'Remove source data, subject to graph ownership and endpoint policies.',
  },
};

function referencePages(root) {
  const entries = ['index', 'math/index', 'formats/geojson'].map(name => join(root, `dist/${name}.d.ts`));
  const program = ts.createProgram(entries, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
  const checker = program.getTypeChecker(), symbols = new Map();
  for (const [i, file] of entries.entries()) {
    const module = checker.getSymbolAtLocation(program.getSourceFile(file));
    for (const symbol of checker.getExportsOfModule(module)) {
      if (!symbols.has(symbol.name)) symbols.set(symbol.name, { symbol: symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol, entry: ['@fir3st/maplet', '@fir3st/maplet/math', '@fir3st/maplet/formats'][i] });
    }
  }
  const publicSymbols = [...symbols.keys()];
  const mapSymbol = symbols.get('MapHandle').symbol;
  const mapType = checker.getDeclaredTypeOfSymbol(mapSymbol);
  for (const [propertyName, name] of [['interaction', 'InteractionHandle'], ['debug', 'DebugHandle']]) {
    const property = checker.getPropertyOfType(mapType, propertyName);
    const propertyType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, property.declarations[0]));
    symbols.set(name, { symbol: propertyType.symbol, entry: `MapHandle['${propertyName}'] — reachable service type, not a root export` });
  }
  const optionsType = checker.getDeclaredTypeOfSymbol(symbols.get('MapOptions').symbol);
  const gestureProperty = checker.getPropertyOfType(optionsType, 'interaction');
  const gestureType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(gestureProperty, gestureProperty.declarations[0]));
  symbols.set('InteractionOptions', { symbol: gestureType.symbol, entry: "MapOptions['interaction'] — reachable option type, not a root export" });
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const cleanType = type => checker.typeToString(type, undefined, flags).replace(/import\("[^"]+"\)\./g, '');
  const assigned = new Set(referenceGroups.flatMap(group => group[2]));
  const groups = [...referenceGroups, ['types', 'Other types & utilities', [...symbols.keys()].filter(name => !assigned.has(name)).sort()]];
  const locations = new Map(groups.flatMap(([id, , names]) => names.map(name => [name, `reference/${id}/#${name}`])));
  const linkTypes = signature => signature.split(/(\b[A-Za-z_][A-Za-z_0-9]*\b)/).map(word => locations.has(word)
    ? `<a href="../../${locations.get(word)}">${escapeHtml(word)}</a>` : escapeHtml(word)).join('');
  const result = groups.map(([id, title, names]) => {
    let html = `<h1>${title}</h1><p class="lead">Public signatures for this package version. Optional fields carry <code>?</code>. See <a href="../">the API overview</a> for behavior and defaults.</p>`;
    const headings = [];
    for (const name of names) {
      const exported = symbols.get(name);
      if (!exported) throw new Error(`Reference symbol is not exported: ${name}`);
      const { symbol, entry } = exported;
      const declaration = symbol.declarations?.[0];
      const type = symbol.flags & ts.SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeOfSymbolAtLocation(symbol, declaration);
      const comments = ts.displayPartsToString(symbol.getDocumentationComment(checker));
      const alias = ts.isTypeAliasDeclaration(declaration) ? declaration.getText().replace(/^export /, '') : null;
      const signatures = type.getCallSignatures().map(signature => checker.signatureToString(signature, undefined, flags));
      headings.push({ id: name, title: name });
      html += `<section class="api-symbol" id="${name}"><h2>${name}<a class="heading-anchor" href="#${name}" aria-label="Link to ${name}">#</a></h2><p class="api-import">${entry}</p>${comments ? `<p>${inline(comments, 'docs/api-index.md', '../../')}</p>` : ''}`;
      if (alias || signatures.length || !(type.flags & ts.TypeFlags.Object)) html += `<pre tabindex="0" aria-label="${name} signature"><code>${linkTypes(alias ?? (signatures.length ? signatures.map(signature => `${name}${signature}`).join('\n') : `${name}: ${cleanType(type)}`))}</code></pre>`;
      const properties = type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection) ? checker.getPropertiesOfType(type) : [];
      if (properties.length) html += `<div class="table-scroll" tabindex="0" role="region" aria-label="${name} members"><table class="api-table"><thead><tr><th scope="col">Member</th><th scope="col">Type / signature</th></tr></thead><tbody>${properties.map(property => {
        const propertyType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations?.[0] ?? declaration);
        const doc = memberDescriptions[name]?.[property.name] ?? ts.displayPartsToString(property.getDocumentationComment(checker));
        return `<tr id="${name}-${escapeHtml(property.name)}"><td><code>${escapeHtml(property.name)}${property.flags & ts.SymbolFlags.Optional ? '?' : ''}</code>${doc ? `<p>${inline(doc, 'docs/api-index.md', '../../')}</p>` : ''}</td><td><code>${linkTypes(cleanType(propertyType))}</code></td></tr>`;
      }).join('')}</tbody></table></div>`;
      html += '</section>';
    }
    return { route: `reference/${id}/`, title, html, headings };
  });
  return { pages: result, groups, symbols: publicSymbols };
}

export function buildDocumentation({ root, site, catalog, version, css, cssHash, scriptHash, highlight }) {
  for (const entry of catalog) routes.set(`docs/tutorials/${entry.id}.md`, `examples/${entry.id}/`);
  const reference = referencePages(root);
  const referenceIndex = `<div class="reference-index">${reference.groups.map(([id, title, names]) => `<section><h3><a href="./${id}/">${title}</a></h3><p>${names.map(name => `<a href="./${id}/#${name}">${name}</a>`).join(' · ')}</p></section>`).join('')}</div>`;
  const outputs = [];
  for (const [source, route, title] of pages) {
    const home = route ? '../'.repeat(route.split('/').filter(Boolean).length) : './';
    const markdown = readFileSync(join(root, source), 'utf8');
    const rendered = renderMarkdown(markdown.replace(/<!-- tutorial-directory -->[\s\S]*<!-- \/tutorial-directory -->/, ''), { source, home, highlight });
    const tutorials = route === 'tutorials/' ? `<section class="tutorial-directory"><h2 id="find-a-tutorial">Find a tutorial</h2><label for="search">Search tutorials</label><input id="search" type="search" placeholder="e.g. GeoJSON, labels, layers" autocomplete="off"><p id="result-count" aria-live="polite">${catalog.length} tutorials</p>${catalog.map(entry => `<article class="example-card" data-group="${escapeHtml(entry.group)}"><span class="card-group">${escapeHtml(entry.group)}</span><h3><a href="${home}examples/${entry.id}/">${escapeHtml(entry.title)}</a></h3><p>${escapeHtml(entry.summary)}</p></article>`).join('')}<p id="empty" hidden>No tutorials match. Try another search.</p></section>` : '';
    outputs.push({ route, title, html: rendered.html + (route === 'reference/' ? referenceIndex : '') + tutorials, headings: tutorials ? [...rendered.headings, { id: 'find-a-tutorial', title: 'Find a tutorial' }] : rendered.headings, source });
  }
  const galleryScript = scriptHash ? `gallery-${scriptHash}.js` : 'gallery.js';
  for (const output of [...outputs, ...reference.pages]) {
    const home = output.route ? '../'.repeat(output.route.split('/').filter(Boolean).length) : './';
    const directory = join(site, output.route);
    mkdirSync(directory, { recursive: true });
    const section = output.route.startsWith('reference/') ? 'Reference' : output.route === 'tutorials/' ? 'Tutorials' : output.route === 'download/' ? 'Download' : output.route === 'plugins/' ? 'Plugins' : 'Overview';
    writeFileSync(join(directory, 'index.html'), documentHtml({ title: output.title, description: `${output.title}: Maplet ${version} documentation.`, body: output.html, version, home, route: output.route, section, catalog, headings: output.headings, cssHash, script: output.route === 'tutorials/' ? galleryScript : undefined }));
    writeFileSync(join(directory, 'style.css'), css);
    if (output.route === 'tutorials/') writeFileSync(join(directory, galleryScript), readFileSync(join(root, 'examples/gallery.js'), 'utf8'));
  }
  writeFileSync(join(site, 'api-symbols.json'), JSON.stringify(reference.symbols));
  return outputs.length + reference.pages.length;
}
