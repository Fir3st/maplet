/**
 * Typed surface of the release planner used by the release workflow and tests.
 *
 * The implementation stays plain executable JavaScript (`release-plan.mjs`).
 */

export interface ReleasePlan {
  readonly version: string;
  readonly tag: string;
  readonly changed: boolean;
  readonly prerelease: boolean;
}

/** Validates the version and compares it with the previous release. */
export function releasePlan(version: unknown, previousVersion: unknown): ReleasePlan;

/** Reads the manifest at the given commit and plans its release. */
export function planForPush(previousCommit: string): ReleasePlan;
