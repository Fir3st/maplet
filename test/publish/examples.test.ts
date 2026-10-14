import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Build tooling is a JavaScript module, not part of the library API.
import { buildExamples, highlightJavaScript } from '../../scripts/build-examples.mjs';
// @ts-expect-error Publication tooling is tested with fake GitHub responses only.
import { publishGists } from '../../scripts/publish-gists.mjs';
// @ts-expect-error Documentation tooling is not part of the package API.
import { renderMarkdown } from '../../scripts/docs-site.mjs';

test('complete documentation and eight tutorials build under a Pages subdirectory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maplet-examples-test-'));
  try {
    const { site, plan, pageCount } = buildExamples({ output: directory, baseUrl: 'https://example.github.io/project/' });
    assert.equal(plan.gists.length, 8);
    assert.ok(pageCount >= 30);
    const gallery = readFileSync(join(site, 'index.html'), 'utf8');
    assert.match(gallery, /Maplet documentation/);
    assert.ok(!gallery.includes('Schematic preview'));
    assert.match(gallery, /href="\.\/reference\/"/);
    assert.match(gallery, /href="\.\/tutorials\/"/);
    assert.ok(!gallery.includes('Small examples.'));
    assert.ok(!gallery.includes('Learning examples, not performance benchmarks.'));
    assert.match(gallery, /class="syntax-keyword"/);
    const stylesheet = /href="(\.\/style\.css\?v=[0-9a-f]{12})"/.exec(gallery)?.[1];
    assert.ok(stylesheet, 'Gallery stylesheet must have a content fingerprint');
    assert.deepEqual(JSON.parse(readFileSync(join(site, 'gists.json'), 'utf8')), {});
    assert.ok(readFileSync(join(site, 'dist', 'workers', 'import.worker.js'), 'utf8').length > 0);
    const symbols = JSON.parse(readFileSync(join(site, 'api-symbols.json'), 'utf8'));
    for (const required of ['MapHandle', 'LayerHandle', 'SourceLayerSpec', 'MapOptions', 'style', 'crs', 'FeaturesHandle', 'LocateResult', 'boundsFromPositions', 'parseGeoJson']) assert.ok(symbols.includes(required));
    const mapReference = readFileSync(join(site, 'reference', 'map', 'index.html'), 'utf8');
    for (const member of ['MapHandle-addPoints', 'MapHandle-use', 'MapHandle-whenRendered', 'MapOptions-controls', 'MapOptions-projection']) assert.ok(mapReference.includes(`id="${member}"`), `Missing inherited API member ${member}`);
    assert.ok(!mapReference.includes('MapHandle-groups'));
    for (const route of ['download', 'tutorials', 'plugins', 'guides/maps', 'guides/layers', 'guides/data', 'guides/rendering', 'guides/interaction', 'guides/status', 'guides/contracts', 'guides/development']) assert.ok(existsSync(join(site, route, 'index.html')), `Missing documentation section ${route}`);
    for (const gist of plan.gists) {
      assert.ok(gallery.includes(`href="./examples/${gist.id}/"`));
      const html = readFileSync(join(site, 'examples', gist.id, 'index.html'), 'utf8');
      assert.match(html, /id="map"/);
      assert.match(html, /aria-label="Documentation"/);
      assert.match(html, /id="live-example"/);
      assert.match(html, /Complete example source/);
      assert.match(html, /class="syntax-string"/);
      assert.ok(html.includes(`href="${stylesheet}"`), 'Each detail must use the fingerprinted stylesheet');
      assert.ok(gist.files['index.html'].includes(`href="${stylesheet}"`), 'Gist HTML must use the fingerprinted stylesheet');
      assert.match(html, /Gist not published yet/);
      assert.match(html, /src="\.\/example\.js"/);
      assert.match(gist.files['shared.js'], /from 'https:\/\/example.github.io\/project\/dist\/index.js'/);
      assert.match(gist.files['index.html'], /data-gallery="https:\/\/example.github.io\/project\/"/);
      assert.match(gist.files['README.md'], /Gist itself does not execute HTML/);
      assert.deepEqual(Object.keys(gist.files).sort(), ['LICENSE', 'NOTICE', 'README.md', 'example.js', 'index.html', 'shared.js', 'style.css'].sort());
      assert.ok(new TextEncoder().encode(JSON.stringify(gist.files)).length < 128 * 1024);
    }
    // Check every static local link and fragment independently of the builder.
    const documents: string[] = [];
    function collect(path: string) {
      for (const name of readdirSync(path)) {
        if (name === 'dist') continue;
        const file = join(path, name);
        if (statSync(file).isDirectory()) collect(file);
        else if (name === 'index.html') documents.push(file);
      }
    }
    collect(site);
    assert.equal(documents.length, pageCount);
    for (const file of documents) {
      const html = readFileSync(file, 'utf8');
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
      assert.equal(new Set(ids).size, ids.length, `Duplicate anchors in ${file}`);
      for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        if (/^(https?:|data:)/.test(match[1]!)) continue;
        const url = new URL(match[1]!, `file://${file}`);
        const target = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
        assert.ok(existsSync(target), `Broken local link: ${file} → ${match[1]}`);
        if (url.hash) assert.ok(readFileSync(target, 'utf8').includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Broken fragment: ${file} → ${match[1]}`);
      }
    }
    assert.throws(() => buildExamples({ output: directory, baseUrl: 'file:///local/' }), /Pages base URL/);
    assert.throws(() => buildExamples({ output: directory, baseUrl: 'https://user:example@example.com/' }), /Pages base URL/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('guide Markdown renders safe code, tables and project-relative links', () => {
  const rendered = renderMarkdown('# Guide\n\n## Types\n\n| Type | Meaning |\n| --- | --- |\n| `string | number` | **ID** |\n\n[Objects](api.md#collections-and-objects)\n\n```html\n<script>alert(1)</script>\n```', { source: 'docs/maps.md', home: '../../' });
  assert.match(rendered.html, /<code>string \| number<\/code>/);
  assert.match(rendered.html, /<strong>ID<\/strong>/);
  assert.match(rendered.html, /href="\.\.\/\.\.\/guides\/layers\/#collections-and-objects"/);
  assert.ok(!rendered.html.includes('<script>'));
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.deepEqual(rendered.headings, [{ id: 'types', title: 'Types' }]);
  assert.throws(() => renderMarkdown('```js\nconst unfinished = 1'), /Unclosed code fence/);
});

test('syntax highlighting preserves JavaScript text and escapes HTML', () => {
  const source = '// comment\nconst value = `hello ${Math.round(2.5)} <script>`;\n/* end */\n';
  const html = highlightJavaScript(source);
  assert.match(html, /class="syntax-comment"/);
  assert.match(html, /class="syntax-number"/);
  assert.match(html, /class="syntax-function"/);
  assert.ok(!html.includes('<script>'));
  const text = html.replace(/<span class="syntax-[a-z]+">|<\/span>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.equal(text, source);
});

function fakeGitHub(seed: any[] = []) {
  const gists = [...seed];
  const calls: { path: string; method: string; body?: any }[] = [];
  let serial = 1;
  const api = async (path: string, options: { method?: string; body?: any } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ path, method, body: options.body });
    if (path === 'user') return { login: 'Fir3st' };
    if (path.startsWith('users/Fir3st/gists?')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      return gists.slice((page - 1) * 100, page * 100);
    }
    if (method === 'POST' && path === 'gists') {
      const id = (serial++).toString(16).padStart(32, '0');
      const gist = { id, html_url: `https://gist.github.com/Fir3st/${id}`, public: true, owner: { login: 'Fir3st' }, description: options.body.description };
      gists.push(gist);
      return gist;
    }
    if (method === 'PATCH') {
      const gist = gists.find(entry => path === `gists/${entry.id}`);
      assert.ok(gist);
      gist.description = options.body.description;
      return gist;
    }
    throw new Error(`Unexpected GitHub call: ${method} ${path}`);
  };
  return { api, calls, gists };
}

const fixture = () => ({ repository: 'Fir3st/maplet', baseUrl: 'https://fir3st.github.io/maplet/', version: '0.1.0-alpha.3',
  gists: [{ id: 'basics', title: 'Your first map', files: { 'index.html': '<h1>Map</h1>', 'README.md': 'An example' } }] });

test('Gists create once, skip unchanged files, and update existing URLs', async () => {
  const fake = fakeGitHub();
  const plan = fixture();
  const first = await publishGists(plan, fake.api);
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 2);
  assert.ok(fake.calls.filter(call => call.method === 'POST').every(call => call.body.public === true));
  assert.ok(fake.calls.find(call => call.body?.files['README.md']?.content.includes('[source Gist]')));
  fake.calls.length = 0;
  assert.deepEqual(await publishGists(plan, fake.api), first);
  assert.equal(fake.calls.filter(call => call.method !== 'GET').length, 0);
  plan.gists[0]!.files['index.html'] = '<h1>Updated map</h1>';
  fake.calls.length = 0;
  assert.deepEqual(await publishGists(plan, fake.api), first);
  assert.equal(fake.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0);
});

test('complete metadata discovery paginates without reading unrelated contents', async () => {
  const unrelated = Array.from({ length: 100 }, (_, i) => ({ id: i.toString(16), description: 'Unrelated public Gist' }));
  const fake = fakeGitHub(unrelated);
  await publishGists(fixture(), fake.api);
  assert.ok(fake.calls.some(call => call.path.endsWith('page=2')));
  assert.ok(fake.calls.filter(call => call.method === 'GET').every(call => call.path === 'user' || call.path.startsWith('users/Fir3st/gists?')));
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 2);
});

test('partial publication can resume without duplicating the created example', async () => {
  const fake = fakeGitHub();
  let failed = false;
  const interrupted = async (path: string, options: any) => {
    if (options?.body?.description.includes(' index ') && !failed) { failed = true; throw new Error('Synthetic API failure'); }
    return fake.api(path, options);
  };
  await assert.rejects(publishGists(fixture(), interrupted), /Synthetic API failure/);
  assert.equal(fake.gists.length, 1);
  const firstId = fake.gists[0].id;
  await publishGists(fixture(), fake.api);
  assert.equal(fake.gists.length, 2);
  assert.equal(fake.gists[0].id, firstId);
});

test('wrong ownership, duplicate IDs, API failures and unbounded scans fail before writes', async () => {
  const fake = fakeGitHub();
  await assert.rejects(publishGists(fixture(), async () => ({ login: 'someone-else' })), /repository owner/);
  const duplicate = fixture(); duplicate.gists.push(duplicate.gists[0]!);
  await assert.rejects(publishGists(duplicate, fake.api), /duplicate Gist ID/);
  await assert.rejects(publishGists(fixture(), async () => { throw new Error('API denied'); }), /API denied/);
  const fullPage = Array.from({ length: 100 }, () => ({ description: 'Unrelated Gist' }));
  let writes = 0;
  await assert.rejects(publishGists(fixture(), async (path: string, options: any) => {
    if (options?.method !== undefined) writes++;
    return path === 'user' ? { login: 'Fir3st' } : fullPage;
  }), /2,000 entries/);
  assert.equal(writes, 0);
});

test('duplicate managed Gists are rejected rather than overwritten', async () => {
  const fake = fakeGitHub();
  await publishGists(fixture(), fake.api);
  fake.gists.push({ ...fake.gists[0], id: 'f'.repeat(32) });
  fake.calls.length = 0;
  await assert.rejects(publishGists(fixture(), fake.api), /Multiple managed Gists/);
  assert.equal(fake.calls.filter(call => call.method !== 'GET').length, 0);
});
