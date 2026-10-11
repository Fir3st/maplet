/**
 * Publish archive and consumer/bundler contract (P8). The packed package must
 * contain everything a consumer needs — including the import worker asset that
 * `new URL(..., import.meta.url)` resolves at runtime — and the emitted modules
 * must use relative specifiers only, so a consumer without a bundler (or with a
 * bundler that leaves the worker URL alone) still gets the documented CSP /
 * inline fallback instead of a broken import graph.
 *
 * `npm pack --dry-run` is local packaging: it downloads and executes nothing
 * (package.json defines no pack lifecycle scripts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function distModules(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js')) files.push(full);
    }
  };
  walk(join(root, 'dist'));
  return files;
}

test('npm pack includes the runtime assets and no development files', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const [report] = JSON.parse(output) as [{ files: { path: string }[] }];
  const files = report.files.map((entry) => entry.path);
  for (const required of [
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/math/index.js',
    'dist/formats/geojson.js',
    'dist/workers/import.worker.js',
    'README.md',
    'NOTICE',
    'LICENSE',
    'CHANGELOG.md',
  ]) {
    assert.ok(files.includes(required), `packed archive is missing ${required}`);
  }
  for (const file of files) {
    for (const prefix of ['src/', 'test/', 'demo/', 'docs/', 'scripts/']) {
      assert.ok(!file.startsWith(prefix), `development file packed: ${file}`);
    }
  }
});

test('every exports subpath resolves to a packed file', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, { types: string; import: string }>;
  };
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    for (const [kind, file] of Object.entries(target)) {
      assert.ok(existsSync(join(root, file)), `exports["${subpath}"].${kind} points at missing ${file}`);
    }
  }
});

test('dist modules use relative specifiers only and keep the worker URL', () => {
  const files = distModules();
  assert.ok(files.length > 20, 'dist should contain the emitted modules');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;
        assert.ok(
          specifier.startsWith('./') || specifier.startsWith('../'),
          `${relative(root, file)} uses a bare specifier: ${specifier}`,
        );
      }
    }
  }
  const pipeline = readFileSync(join(root, 'dist', 'io', 'import-pipeline.js'), 'utf8');
  assert.match(
    pipeline,
    /new URL\('\.\.\/workers\/import\.worker\.js', import\.meta\.url\)/,
    'the import worker must stay resolvable next to the emitted module',
  );
  assert.ok(existsSync(join(root, 'dist', 'workers', 'import.worker.js')), 'worker asset missing');
});
