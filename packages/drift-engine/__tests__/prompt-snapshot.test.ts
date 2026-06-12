import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { buildPrompt } from '../src/prompt-builder'
import type { AnalysisInput } from '../src/types'

// NFR44 release-gate A — prompt snapshot parity.
//
// Runs `buildPrompt(canonical_input, template)` against a pinned fixture and
// asserts byte-equality with a committed snapshot. Any change to `prompt.md`,
// `prompt-builder.ts`, or any rendering helper that perturbs the output fails
// this gate. Intentional prompt changes update the snapshot in the same PR and
// require explicit reviewer sign-off (see `packages/drift-engine/README.md`).
//
// Paired with NFR44 release-gate B — `apps/action/src/__tests__/pipeline.test.ts`
// — which covers schema / reconcile / orchestrator regressions through the
// LLM-mocked pipeline. Gate A catches prompt-text drift before the LLM ever
// runs; gate B catches everything downstream of the LLM.
//
// Deliberately uses `readFileSync` + literal-string comparison instead of
// Vitest's `toMatchSnapshot` — `toMatchSnapshot` auto-creates / auto-updates
// on first run, defeating the human-review-required semantics this gate
// exists to enforce.

const FAILURE_BANNER = [
  'NFR44 release-gate A — unintended prompt drift detected.',
  'Update the snapshot only if the change is intentional and explicitly signed off in the PR description.',
  '',
  'To intentionally update the snapshot:',
  '  1. Regenerate via a one-shot node script that calls buildPrompt(canonical_input, prompt.md) and writeFileSyncs the output to __tests__/fixtures/canonical-prompt.snapshot.md',
  '  2. Inspect the diff — confirm every byte of drift is intended',
  '  3. Include the regeneration rationale + explicit reviewer sign-off in the PR description',
  '',
  'See packages/drift-engine/README.md for the full snapshot-update workflow.',
].join('\n')

const canonicalInput: AnalysisInput = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/canonical-input.json', import.meta.url)),
    'utf8',
  ),
)

const promptTemplate = readFileSync(
  fileURLToPath(new URL('../src/prompt.md', import.meta.url)),
  'utf8',
)

const expectedSnapshot = readFileSync(
  fileURLToPath(new URL('./fixtures/canonical-prompt.snapshot.md', import.meta.url)),
  'utf8',
)

function firstDivergence(expected: string, actual: string): string {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const maxLen = Math.max(expectedLines.length, actualLines.length)
  for (let i = 0; i < maxLen; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      return [
        `First divergence at line ${i + 1}:`,
        `  expected: ${JSON.stringify(expectedLines[i])}`,
        `  actual:   ${JSON.stringify(actualLines[i])}`,
        `Total expected lines: ${expectedLines.length}; total actual lines: ${actualLines.length}.`,
      ].join('\n')
    }
  }
  return `Strings have identical lines but differ in length (expected ${expected.length} bytes, actual ${actual.length} bytes). Check for trailing whitespace, BOM, or line-ending drift.`
}

describe('NFR44 release-gate A — prompt snapshot parity', () => {
  it('buildPrompt(canonical_input, template) matches the committed snapshot byte-for-byte', () => {
    const actual = buildPrompt(canonicalInput, promptTemplate)
    if (actual !== expectedSnapshot) {
      throw new Error(
        `${FAILURE_BANNER}\n\n${firstDivergence(expectedSnapshot, actual)}`,
      )
    }
  })
})
