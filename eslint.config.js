// ESLint 9 flat config with typescript-eslint
import tseslint from 'typescript-eslint'

const noDefaultExport = {
  selector:
    'ExportDefaultDeclaration:not([declaration.type="Identifier"]):not([declaration.type="CallExpression"])',
  message: 'Use named exports only. `export default` is not permitted in this repo.',
}

const noDirectLangchainImport = {
  selector: "ImportDeclaration[source.value=/^@langchain\\//]",
  message:
    'Do not import @langchain/* in this package. LLM-framework access lives in @delfini/action-core (the orchestrator adapter) only.',
}

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.output/**', '**/.cache/**', '**/*.gen.ts', 'eslint.config.js'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', noDefaultExport],
    },
  },
  {
    // packages/drift-engine is pure-logic — no I/O, no LLM client, no
    // credentials, no fetch. Runtime deps: zod + picomatch (both pure CPU).
    // FR139 / NFR44 cross-cutting invariant; adding any of the blocked
    // imports below is a regression that breaks algorithm parity between
    // the Action and @delfini/cli (both surfaces import the same core).
    files: ['packages/drift-engine/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noDefaultExport, noDirectLangchainImport],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'node:fs', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'fs/promises', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'node:fs/promises', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'child_process', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'node:child_process', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'http', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'node:http', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'https', message: 'No I/O in @delfini/drift-engine.' },
            { name: 'node:https', message: 'No I/O in @delfini/drift-engine.' },
            {
              name: '@anthropic-ai/sdk',
              message: 'No LLM client in @delfini/drift-engine.',
            },
            { name: 'openai', message: 'No LLM client in @delfini/drift-engine.' },
          ],
          patterns: [
            {
              group: ['@langchain/*'],
              message: 'No LLM framework in @delfini/drift-engine.',
            },
          ],
        },
      ],
    },
  },
  {
    // packages/cli — the @delfini/cli binary is deterministic and NEVER
    // calls an LLM ("No LLM calls from packages/cli (v6.5) — adding any
    // fetch / Anthropic / OpenAI / LangChain dep to packages/cli is a
    // regression"). The CLI legitimately performs I/O (read/write
    // doc-scope.json, shell out to git via simple-git, walk the filesystem
    // with tinyglobby) — that is the job — so the I/O blocks from
    // packages/drift-engine do NOT apply here. The blocklist is strictly
    // LLM clients.
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noDefaultExport, noDirectLangchainImport],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message: 'No LLM client in @delfini/cli — the CLI is deterministic (FR140).',
            },
            { name: 'openai', message: 'No LLM client in @delfini/cli — the CLI is deterministic (FR140).' },
          ],
          patterns: [
            {
              group: ['@langchain/*'],
              message: 'No LLM framework in @delfini/cli — the CLI is deterministic (FR140).',
            },
          ],
        },
      ],
    },
  },
  {
    // Action artifact + shared core — the pipeline code uses `_`-prefixed
    // parameters for intentionally-unused arguments (signature-compatibility
    // params, ports).
    files: ['packages/action-core/src/**/*.ts', 'apps/action/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
