/**
 * Typed surface of the Gist publication tool for its tests.
 *
 * The implementation stays plain executable JavaScript (`publish-gists.mjs`);
 * the fake GitHub clients in the tests satisfy `GitHubApi` and the returned
 * plan shape mirrors the builder's `gist-plan.json`.
 */

export interface GistPlanGist {
  readonly id: string;
  readonly title?: string;
  files: Record<string, string>;
}

export interface GistPlan {
  readonly repository: string;
  readonly baseUrl?: string;
  readonly version?: string;
  readonly gists: GistPlanGist[];
}

export interface GitHubApiRequest {
  readonly method?: string;
  readonly body?: unknown;
}

/**
 * One GitHub API call. The tool awaits the result, so an implementation may
 * return a value synchronously (the `gh`-backed one does) or a promise.
 */
export type GitHubApi = (path: string, options?: GitHubApiRequest) => unknown;

export function publishGists(plan: GistPlan, api?: GitHubApi): Promise<Record<string, unknown>>;
