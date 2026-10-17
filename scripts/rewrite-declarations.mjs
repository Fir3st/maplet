#!/usr/bin/env node
/**
 * Rewrites relative `.ts` specifiers to `.js` in the emitted declarations.
 *
 * The compiler option `rewriteRelativeImportExtensions` rewrites emitted
 * JavaScript only: `dist/*.d.ts` keep `from './map.ts'`, which consumers on
 * TypeScript versions without `.ts` specifier resolution cannot follow. The
 * rewrite makes the declaration surface standard (`./map.js` resolves to
 * `map.d.ts`), and the script fails the build if any relative `.ts` specifier
 * survives, so the published types stay consumable by every supported TS.
 *
 * Declarations contain only types and string import specifiers, so a textual
 * rewrite cannot change runtime behaviour; emitted JavaScript is untouched.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const distDir = path.resolve(process.argv[2] ?? 'dist');

function* declarationFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) yield* declarationFiles(full);
    else if (entry.endsWith('.d.ts')) yield full;
  }
}

const SPECIFIER = /(['"])(\.\.?\/[^'"]+)\.ts\1/g;

let files = 0;
let rewrites = 0;
for (const file of declarationFiles(distDir)) {
  const source = readFileSync(file, 'utf8');
  const next = source.replace(SPECIFIER, (_match, quote, specifier) => {
    rewrites++;
    return `${quote}${specifier}.js${quote}`;
  });
  files++;
  if (next !== source) writeFileSync(file, next);
}

const leftovers = [];
for (const file of declarationFiles(distDir)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(SPECIFIER))
    leftovers.push(`${path.relative(distDir, file)}: ${match[2]}.ts`);
}
if (leftovers.length > 0) {
  console.error(`declaration specifiers still point at .ts:\n  ${leftovers.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `declarations: rewrote ${rewrites} specifier(s) in ${files} file(s), none left pointing at .ts`,
  );
}
