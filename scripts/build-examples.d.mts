/**
 * Typed surface of the documentation/tutorial builder for the publication tests.
 *
 * The implementation stays plain executable JavaScript (`build-examples.mjs`);
 * this declaration types the boundary so tests compile without `@ts-expect-error`
 * and without `any` flowing into their assertions.
 */

export interface ExampleGist {
  readonly id: string;
  readonly title: string;
  files: Record<string, string>;
}

export interface ExamplePlan {
  readonly repository: string;
  readonly baseUrl: string;
  readonly version: string;
  readonly gists: ExampleGist[];
}

export function highlightJavaScript(source: string): string;

export function assertModuleGraph(site: string): void;

export function buildExamples(options?: { readonly output?: string; readonly baseUrl?: string }): {
  readonly site: string;
  readonly plan: ExamplePlan;
  readonly pageCount: number;
};
