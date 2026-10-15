/**
 * Minimal ambient declarations for the Node built-ins used by Maplet tests.
 *
 * The test suite runs with Node's native TypeScript type stripping, which needs no
 * packages. These declarations exist only so `tsc -p tsconfig.test.json` can also
 * typecheck the tests without installing @types/node.
 */

declare module 'node:test' {
  export interface TestContext {
    readonly name: string | undefined;
    diagnostic(message: string): void;
  }
  export interface TestOptions {
    readonly skip?: boolean | string;
    readonly todo?: boolean | string;
    readonly timeout?: number;
    readonly concurrency?: number;
  }
  type TestFn = (t: TestContext) => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): Promise<void>;
    (name: string, options: TestOptions, fn: TestFn): Promise<void>;
    skip(name: string, fn: TestFn): Promise<void>;
  }
  const test: Test;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(promise: Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args?: readonly string[],
    options?: { readonly cwd?: string; readonly encoding?: 'utf8' },
  ): string;
}

declare module 'node:fs' {
  export interface Stats {
    isDirectory(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): Stats;
  export function mkdirSync(path: string, options?: { readonly recursive?: boolean }): void;
  export function writeFileSync(path: string, contents: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options: { readonly recursive?: boolean; readonly force?: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
