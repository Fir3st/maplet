import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Strict SemVer keeps package versions safe to use as tag names and filenames.
const numeric = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function releasePlan(version, previousVersion) {
  const match = typeof version === 'string' ? semver.exec(version) : null;
  if (!match || match[0] !== version) {
    throw new Error('package.json version must be a valid SemVer version');
  }
  return {
    version,
    tag: `v${version}`,
    changed: version !== previousVersion,
    prerelease: Boolean(match[1]),
  };
}

export function planForPush(previousCommit) {
  if (!/^[0-9a-f]{40}$/.test(previousCommit)) {
    throw new Error('Expected the previous push commit SHA');
  }
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  // An initial branch push has no previous commit.
  const previousVersion = /^0+$/.test(previousCommit) ? undefined : JSON.parse(
    execFileSync('git', ['show', `${previousCommit}:package.json`], { encoding: 'utf8' }),
  ).version;
  const plan = releasePlan(version, previousVersion);
  // A build fix after a failed version bump must still release that version.
  // Full-history CI checkouts include tags; publication remains idempotent.
  const tag = execFileSync('git', ['tag', '--list', plan.tag], { encoding: 'utf8' }).trim();
  return { ...plan, changed: plan.changed || tag !== plan.tag };
}
