import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Build tooling is a JavaScript module, not part of the library API.
import { buildExamples, highlightJavaScript } from '../../scripts/build-examples.mjs';
// @ts-expect-error Publication tooling is tested with fake GitHub responses only.
import { publishGists } from '../../scripts/publish-gists.mjs';

test('all eight examples build under a Pages subdirectory, with honest Gist links', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maplet-examples-test-'));
  try {
    const { site, plan } = buildExamples({ output: directory, baseUrl: 'https://example.github.io/project/' });
    assert.equal(plan.gists.length, 8);
    const gallery = readFileSync(join(site, 'index.html'), 'utf8');
    assert.match(gallery, /Schematic preview/);
    assert.match(gallery, /Maplet examples/);
    assert.ok(!gallery.includes('Small examples.'));
    assert.ok(!gallery.includes('Learning examples, not performance benchmarks.'));
    assert.match(gallery, /class="syntax-keyword"/);
    assert.deepEqual(JSON.parse(readFileSync(join(site, 'gists.json'), 'utf8')), {});
    assert.ok(readFileSync(join(site, 'dist', 'workers', 'import.worker.js'), 'utf8').length > 0);
    for (const gist of plan.gists) {
      assert.ok(gallery.includes(`href="./examples/${gist.id}/"`));
      const html = readFileSync(join(site, 'examples', gist.id, 'index.html'), 'utf8');
      assert.match(html, /id="map"/);
      assert.match(html, /class="syntax-string"/);
      assert.match(html, /Gist not published yet/);
      assert.match(html, /src="\.\/example\.js"/);
      assert.match(gist.files['shared.js'], /from 'https:\/\/example.github.io\/project\/dist\/index.js'/);
      assert.match(gist.files['index.html'], /data-gallery="https:\/\/example.github.io\/project\/"/);
      assert.match(gist.files['README.md'], /Gist itself does not execute HTML/);
      assert.deepEqual(Object.keys(gist.files).sort(), ['LICENSE', 'NOTICE', 'README.md', 'example.js', 'index.html', 'shared.js', 'style.css'].sort());
      assert.ok(new TextEncoder().encode(JSON.stringify(gist.files)).length < 128 * 1024);
    }
    assert.throws(() => buildExamples({ output: directory, baseUrl: 'file:///local/' }), /Pages base URL/);
    assert.throws(() => buildExamples({ output: directory, baseUrl: 'https://user:example@example.com/' }), /Pages base URL/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
