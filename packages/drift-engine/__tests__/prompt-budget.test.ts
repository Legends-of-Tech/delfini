import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/prompt-builder'
import type { AnalysisInput } from '../src/types'

// Prompt-size measurement gate.
//
// The pre-#104 baseline of 21,138 bytes is the historic reference point. The
// ceiling was raised under Story 4.26 to accommodate the additive worked
// example (Sentry / Technology Stack scenario) + the schema arm + the
// Two-kinds Operating Principle + the additive-overlap extension to the
// disjoint-line-ranges directive. The previous flag-gated "disabled" mode
// was removed in P3.1.1 — additive findings are now always on; the ENABLED
// ceiling is therefore the only ceiling.
//
// If a future edit re-bloats the prompt past ENABLED_BUDGET_BYTES, this test
// fails loudly rather than silently regressing the load-shedding risk surface.
// To raise the ceiling, leave a comment block explaining why.

const ENABLED_BUDGET_BYTES = 28_000

const PROMPT_TEMPLATE = readFileSync(
  fileURLToPath(new URL('../src/prompt.md', import.meta.url)),
  'utf8',
)

function buildSizedPrompt(): string {
  const input: AnalysisInput = {
    diff: '',
    docs: [{ path: 'docs/x.md', content: 'x', frontMatterLineCount: 0 }],
    prMetadata: {
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      headSha: 'h',
      baseSha: 'b',
      title: 't',
    },
  }
  return buildPrompt(input, PROMPT_TEMPLATE)
}

describe('prompt-budget measurement gate', () => {
  it('prompt fits within the documented ceiling', () => {
    const built = buildSizedPrompt()
    if (built.length > ENABLED_BUDGET_BYTES) {
      throw new Error(
        `Prompt budget regression: prompt is ${built.length} bytes, exceeds the ceiling of ${ENABLED_BUDGET_BYTES} bytes. See the comment block at the top of this test file before raising the ceiling.`,
      )
    }
    expect(built.length).toBeLessThanOrEqual(ENABLED_BUDGET_BYTES)
  })
})
