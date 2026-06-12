import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import type { AnalysisInput } from '@delfini/drift-engine'

// NFR44 release-gate C — bundled-CLI parity.
//
// Imports `buildPrompt` from the tsup-bundled `dist/__engine-probe__.js` — NOT
// from the `@delfini/drift-engine` source. This is the entire point of the
// gate: verify that the bundler (Strategy B
// `noExternal: ['@delfini/drift-engine', 'zod']`) produced a bundle whose
// `buildPrompt` is byte-for-byte equivalent to the drift-engine source. Any
// bundler regression that perturbs the prompt fails this gate before it
// reaches a published tarball.
//
// Why the engine probe and not `dist/index.js`: `src/index.ts` is the
// package's PUBLIC surface and must not re-export the private engine (doing so
// leaks `@delfini/drift-engine` into the published `dist/index.d.ts`). The
// `src/__engine-probe__.ts` entry exists solely to give this test a bundled
// `buildPrompt` to call. See that file's header (P3.5.1 review finding).
//
// Paired with gate A (`packages/drift-engine/__tests__/prompt-snapshot.test.ts`)
// and gate B (`apps/action/__tests__/pipeline.test.ts`).
//
// Run order: `pnpm --filter @delfini/cli build` must precede this test. The
// pre-flight check in `beforeAll` throws a targeted error if the bundle is
// missing — local devs need a clear "build first" message, not an opaque
// dynamic-import failure.

const BUNDLED_PROBE = fileURLToPath(new URL('../dist/__engine-probe__.js', import.meta.url))
const CANONICAL_INPUT_PATH = fileURLToPath(
  new URL('../../drift-engine/__tests__/fixtures/canonical-input.json', import.meta.url),
)
const CANONICAL_PROMPT_PATH = fileURLToPath(
  new URL('../../drift-engine/__tests__/fixtures/canonical-prompt.snapshot.md', import.meta.url),
)
const CANONICAL_TEMPLATE_PATH = fileURLToPath(
  new URL('../../drift-engine/src/prompt.md', import.meta.url),
)
const BUNDLED_CHUNK_GLOB_DIR = fileURLToPath(new URL('../dist/', import.meta.url))

const FAILURE_BANNER = [
  'NFR44 gate C — bundled-CLI parity — bundler regression detected.',
  'The bundled `buildPrompt` output diverged from the committed snapshot.',
  'Either a tsup config change perturbed the prompt, or `prompt.md` /',
  '`prompt-builder.ts` changed without updating both the gate-A snapshot and',
  'rebuilding the CLI bundle.',
].join('\n')

describe('NFR44 release-gate C — bundled-CLI parity', () => {
  let bundledBuildPrompt: (input: AnalysisInput, template: string) => string

  beforeAll(async () => {
    if (!existsSync(BUNDLED_PROBE)) {
      throw new Error(
        `Bundled dist not found at ${BUNDLED_PROBE}. ` +
          'Run `pnpm --filter @delfini/cli build` first.',
      )
    }
    const mod = (await import(BUNDLED_PROBE)) as {
      buildPrompt: (input: AnalysisInput, template: string) => string
    }
    bundledBuildPrompt = mod.buildPrompt
  })

  it('buildPrompt(canonical_input) from bundled dist matches the snapshot byte-for-byte', () => {
    const input = JSON.parse(readFileSync(CANONICAL_INPUT_PATH, 'utf8')) as AnalysisInput
    const template = readFileSync(CANONICAL_TEMPLATE_PATH, 'utf8')
    const expected = readFileSync(CANONICAL_PROMPT_PATH, 'utf8')

    const actual = bundledBuildPrompt(input, template)

    if (actual !== expected) {
      throw new Error(`${FAILURE_BANNER}\n\nexpected ${expected.length} bytes, got ${actual.length} bytes.`)
    }
    expect(actual).toBe(expected)
  })

  it('drift-engine symbols inlined into bundle; @delfini/drift-engine module path absent', () => {
    // AC8 sanity-check — guards against subtle bundler misconfig where the
    // import statement disappears but the inlined source doesn't actually
    // make it into the chunk (e.g. tree-shaken away by accident).
    // tsup splits shared code into a chunk-XXXXX.js — read every .js / .cjs /
    // .mjs under dist/ and search the combined corpus. (.mjs is included
    // defensively: tsup's ESM extension is `.js` under `"type":"module"`
    // today, but a future config/output-naming change must not silently
    // exempt a chunk from the no-bare-import assertion.)
    const corpus = collectBundleCorpus(BUNDLED_CHUNK_GLOB_DIR)

    expect(corpus).toContain('buildPrompt')
    expect(corpus).toContain('validateAndReconcile')
    expect(corpus).toContain('estimatePromptTokens')
    expect(corpus).toContain('analysisSchema')

    // Module path itself must NOT appear as an import target. Plain literal
    // mentions of `@delfini/cli` in user-facing message strings (e.g. the
    // doc-scope version-mismatch message, `--version` description) are
    // expected and intentional — the assertion targets the import shape.
    expect(corpus).not.toMatch(/from\s+['"]@delfini\/drift-engine['"]/)
    expect(corpus).not.toMatch(/require\(['"]@delfini\/drift-engine['"]\)/)
  })
})

function collectBundleCorpus(distDir: string): string {
  // Read every .js / .cjs / .mjs file in dist/ and concatenate. The corpus is
  // small (~600KB total across ESM + CJS + chunks); reading it whole keeps the
  // assertion simple and avoids per-file iteration ceremony.
  const entries = readdirSync(distDir)
  let corpus = ''
  for (const name of entries) {
    if (!name.endsWith('.js') && !name.endsWith('.cjs') && !name.endsWith('.mjs')) continue
    corpus += readFileSync(join(distDir, name), 'utf8')
    corpus += '\n'
  }
  return corpus
}
