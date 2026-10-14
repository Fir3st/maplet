import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { version } from '../../src/index.ts';
// @ts-expect-error The release helper is an executable-tool JavaScript module.
import { planForPush, releasePlan } from '../../scripts/release-plan.mjs';

test('public version matches the package manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(version, manifest.version);
});

test('release only on a changed version, including the first push', () => {
  assert.equal(releasePlan('0.1.0-alpha.1', '0.1.0-alpha.1').changed, false);
  assert.deepEqual(releasePlan('0.1.0-alpha.2', '0.1.0-alpha.1'), {
    version: '0.1.0-alpha.2', tag: 'v0.1.0-alpha.2', changed: true, prerelease: true,
  });
  assert.equal(releasePlan('1.0.0', undefined).changed, true);
});

test('stable versions and build metadata are not prereleases', () => {
  assert.equal(releasePlan('1.0.0', '0.9.0').prerelease, false);
  assert.equal(releasePlan('1.0.0+build.1', '0.9.0').prerelease, false);
  assert.equal(releasePlan('1.0.0-rc.1+build.1', '0.9.0').prerelease, true);
});

test('reject invalid versions before using them in workflow outputs', () => {
  for (const version of [undefined, 'v1.0.0', '01.0.0', '1.0.0-01', '1.0', '1.0.0\n', '1.0.0\ntag=bad']) {
    assert.throws(() => releasePlan(version, '0.9.0'), /valid SemVer/);
  }
});

test('push planning compares the actual previous commit manifest', () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const previous = JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { encoding: 'utf8' }));
  assert.equal(planForPush(commit).changed, planForPush(commit).version !== previous.version);
  assert.equal(planForPush('0'.repeat(40)).changed, true);
  assert.throws(() => planForPush('main:package.json'), /commit SHA/);
});
