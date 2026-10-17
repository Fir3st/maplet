/**
 * Typed surface of the Markdown/documentation tooling for its tests.
 *
 * The implementation stays plain executable JavaScript (`docs-site.mjs`); only
 * the functions the tests exercise are declared.
 */

export interface MarkdownOptions {
  readonly source?: string;
  readonly home?: string;
  readonly highlight?: (code: string) => string;
}

export interface RenderedMarkdown {
  readonly html: string;
  readonly headings: readonly { readonly id: string; readonly title: string }[];
}

export function renderMarkdown(markdown: string, options?: MarkdownOptions): RenderedMarkdown;
