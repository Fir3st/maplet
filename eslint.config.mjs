import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const jsFiles = ['**/*.js', '**/*.mjs'];
const tsFiles = ['**/*.ts'];
// Declaration-only modules that belong to no TypeScript project: parsed with the
// TypeScript parser and checked by the non-type-aware rule set (tsc checks them
// through the test program instead).
const tsDeclarationFiles = ['scripts/**/*.d.mts'];
const browserFiles = ['demo/**/*.js', 'demo/**/*.mjs', 'examples/**/*.js', 'examples/**/*.mjs'];
const nodeFiles = ['scripts/**/*.mjs', 'demo/e2e/**/*.mjs', 'eslint.config.mjs'];

// Type-checked rules per project shape: src/ lives in tsconfig.json, test/ and
// type-tests/ in their own configurations (the project service resolves each
// file to the tsconfig that includes it).
const [tsBase, tsRecommended, tsRules] = tseslint.configs.recommendedTypeChecked;

export default [
  {
    name: 'maplet/ignores',
    ignores: [
      'dist/**',
      '.example-build/**',
      '.playwright-mcp/**',
      'demo/vendor/**',
      'demo/tiles/**',
      'demo/tiles-providers/**',
      'demo/checks/**',
      '*.tgz',
    ],
  },
  {
    name: 'maplet/js',
    files: jsFiles,
    ...js.configs.recommended,
    rules: {
      // `const { omitted, ...rest } = value` is an intentional omit, not a leak.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    ...tsBase,
    files: [...tsFiles, ...tsDeclarationFiles],
  },
  tsRecommended,
  {
    ...tsRules,
    files: tsFiles,
    rules: {
      ...tsRules.rules,
      // `const { omitted, ...rest } = value` is an intentional omit, not a leak.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    name: 'maplet/typescript-project',
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    name: 'maplet/typescript-test-project',
    files: ['test/**/*.ts', 'type-tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Consumer type tests resolve the package to its sources for linting
        // (tsconfig.lint.json); the published-declaration check stays with
        // `typecheck:types`, which builds `dist/` first.
        project: ['./tsconfig.test.json', './tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    name: 'maplet/ambient-declarations',
    files: ['**/*.d.ts'],
    rules: {
      // Ambient handle interfaces (WebGPU object types in webgpu.d.ts) are
      // deliberately opaque placeholders, not empty object types.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    name: 'maplet/node-test-declarations',
    files: ['test/**/*.ts'],
    rules: {
      // `test(...)` and friends register with the node:test runner; the runner
      // owns those promises, so a top-level call is a declaration, not a
      // floating promise.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              name: [
                'test',
                'it',
                'describe',
                'suite',
                'before',
                'after',
                'beforeEach',
                'afterEach',
              ],
              package: 'node:test',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'maplet/browser-globals',
    files: browserFiles,
    languageOptions: { globals: globals.browser },
  },
  {
    name: 'maplet/node-globals',
    files: nodeFiles,
    languageOptions: { globals: globals.node },
  },
  prettier,
];
