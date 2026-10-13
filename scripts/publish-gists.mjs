import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Authentication is delegated to gh in the Actions runner. This tool does not
// read auth files or inspect credential values, and logs only managed Gist IDs.
function githubApi(path, { method = 'GET', body } = {}) {
  const fields = path === 'user' ? '{login}' : method === 'GET'
    ? '[.[] | {id, description, public, html_url, owner: {login: .owner.login}}]'
    : '{id, html_url, owner: {login: .owner.login}}';
  const args = ['api', path, '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28', '--jq', fields];
  if (body) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', maxBuffer: 512 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  }));
}

const digest = files => createHash('sha256').update(JSON.stringify(files)).digest('hex');

export async function publishGists(plan, api = githubApi) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(plan.repository)) throw new Error('Invalid repository');
  const [owner] = plan.repository.split('/');
  const user = await api('user');
  if (user.login.toLowerCase() !== owner.toLowerCase()) throw new Error('Gist account must match the repository owner');
  const expected = new Set(['index']);
  const allowedFiles = new Set(['index.html', 'example.js', 'shared.js', 'style.css', 'README.md', 'LICENSE', 'NOTICE']);
  for (const gist of plan.gists) {
    if (!/^[a-z][a-z0-9-]*$/.test(gist.id) || expected.has(gist.id)) throw new Error('Invalid or duplicate Gist ID');
    expected.add(gist.id);
    if (Object.keys(gist.files).some(name => !allowedFiles.has(name))) throw new Error('Unexpected public example file');
    if (Buffer.byteLength(JSON.stringify(gist.files)) > 128 * 1024) throw new Error('A single example exceeds the 128 KiB Gist budget');
  }
  const prefix = `Maplet examples [${plan.repository}] `;
  const existing = new Map();
  // List public metadata only. Never read other Gists' file contents. Complete
  // discovery precedes writes, so a truncated list cannot create duplicates.
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('Gist discovery exceeds 2,000 entries; no Gists were written');
    const gists = await api(`users/${owner}/gists?per_page=100&page=${page}`);
    for (const gist of gists) {
      if (!gist.description?.startsWith(prefix)) continue;
      const match = /^([a-z][a-z0-9-]*) sha256:([0-9a-f]{64})$/.exec(gist.description.slice(prefix.length));
      if (!match || !expected.has(match[1])) continue;
      if (!gist.public || gist.owner.login.toLowerCase() !== owner.toLowerCase() || !/^[0-9a-f]+$/.test(gist.id)) throw new Error('Unexpected managed Gist ownership or visibility');
      if (existing.has(match[1])) throw new Error(`Multiple managed Gists for ${match[1]}; resolve them before publishing`);
      existing.set(match[1], { ...gist, digest: match[2] });
    }
    if (gists.length < 100) break;
  }
  const links = {};
  async function upsert(id, files) {
    const hash = digest(files);
    const prior = existing.get(id);
    let gist = prior;
    if (!prior || prior.digest !== hash) {
      const body = {
        description: `${prefix}${id} sha256:${hash}`,
        files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }])),
      };
      if (!prior) body.public = true;
      gist = await api(prior ? `gists/${prior.id}` : 'gists', { method: prior ? 'PATCH' : 'POST', body });
    }
    if (!/^https:\/\/gist\.github\.com\/[A-Za-z0-9-]+\/[0-9a-f]+$/.test(gist.html_url)) throw new Error('Invalid Gist URL returned by GitHub');
    links[id] = gist.html_url;
  }
  // One documented REST write per changed Gist; sequential writes keep this
  // nine-Gist collection below GitHub's secondary content-creation limits.
  for (const gist of plan.gists) await upsert(gist.id, gist.files);
  const readme = `# Maplet examples\n\n[Open the live collection](${plan.baseUrl})\n\n` +
    plan.gists.map(gist => `- **${gist.title}** — [run](${plan.baseUrl}examples/${gist.id}/) · [source Gist](${links[gist.id]})`).join('\n') +
    `\n\nBuilt from [${plan.repository}](https://github.com/${plan.repository}/tree/main/examples), version ${plan.version}.\n\nGist stores source code; live HTML runs on GitHub Pages. Each example includes its setup, stylesheet, license and attribution. This index is updated by the examples workflow; its URL remains stable.\n`;
  await upsert('index', { 'README.md': readme });
  return links;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(readFileSync('.example-build/gist-plan.json', 'utf8'));
  const links = await publishGists(plan);
  writeFileSync('.example-build/site/gists.json', `${JSON.stringify(links, null, 2)}\n`);
  console.log(`Published ${Object.keys(links).length} managed Gists; links saved for Pages`);
}
