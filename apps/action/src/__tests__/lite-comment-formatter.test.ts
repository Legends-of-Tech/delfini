import { describe, it, expect } from 'vitest'
import { formatLiteComment } from '../lite-comment-formatter.js'
import type { Addition, Contradiction, DocFile, Severity } from '@delfini/drift-engine'

// Local fixture factories — deliberately NOT imported from comment-formatter.test.ts
// (those helpers are not exported, and per-mode fixtures stay isolated).

function makeContradiction(overrides: Partial<Contradiction> = {}): Contradiction {
  return {
    targetDocPath: 'docs/architecture.md',
    targetSection: '3.2 Batch API',
    targetLineStart: 114,
    targetLineEnd: 120,
    whatChanged:
      'Code now exposes a single-item endpoint instead of the documented batch endpoint.',
    whatContradicts:
      'Section 3.2 states that all payment operations MUST use batch mode to stay within rate limits.',
    proposedReplacement:
      'The payment service processes transactions individually via the /v2/process endpoint.',
    severity: 'High',
    confidence: 5,
    quotedDocText: 'verbatim doc quote',
    ...overrides,
  }
}

function makeAddition(overrides: Partial<Addition> = {}): Addition {
  return {
    targetDocPath: 'docs/architecture.md',
    anchorSection: '4. Observability',
    anchorLine: 88,
    insertionMode: 'after',
    proposedContent:
      'All API handlers emit a structured log line on the `request.completed` event.',
    severity: 'Medium',
    confidence: 4,
    whatChanged: 'The PR adds structured request-completion logging across every API handler.',
    rationaleForAddition: 'The observability section does not yet mention request-level logging.',
    ...overrides,
  }
}

function makeDoc(path: string): DocFile {
  return { path, content: '...', frontMatterLineCount: 0 }
}

describe('formatLiteComment — findings (drift)', () => {
  it('renders a single concrete-replacement drift card', () => {
    const out = formatLiteComment({
      kind: 'findings',
      result: { contradictions: [makeContradiction()], additions: [], rawConfidence: 0.9 },
      docScope: 'docs/',
    })

    expect(out).toMatchInlineSnapshot(`
      "## Delfini — Drift Detected

      **1 finding** found between this PR and your source-of-truth documents in \`docs/\`.

      ---

      ### 1. \`docs/architecture.md\` — 3.2 Batch API

      **Severity:** High · **Lines:** 114–120

      **What changed:** Code now exposes a single-item endpoint instead of the documented batch endpoint.

      **What the docs say:** Section 3.2 states that all payment operations MUST use batch mode to stay within rate limits.

      **Proposed change:**

      \`\`\`diff
      - verbatim doc quote
      + The payment service processes transactions individually via the /v2/process endpoint.
      \`\`\`

      ---

      > Re-run this check by pushing a new commit to this branch."
    `)
  })

  it('renders a narrative-only (null-replacement) drift card', () => {
    const out = formatLiteComment({
      kind: 'findings',
      result: {
        contradictions: [makeContradiction({ proposedReplacement: null })],
        additions: [],
        rawConfidence: 0.9,
      },
      docScope: 'docs/',
    })

    expect(out).toMatchInlineSnapshot(`
      "## Delfini — Drift Detected

      **1 finding** found between this PR and your source-of-truth documents in \`docs/\`.

      ---

      ### 1. \`docs/architecture.md\` — 3.2 Batch API

      **Severity:** High · **Lines:** 114–120

      **What changed:** Code now exposes a single-item endpoint instead of the documented batch endpoint.

      **What the docs say:** Section 3.2 states that all payment operations MUST use batch mode to stay within rate limits.

      _No concrete replacement available — review and update this section manually._

      ---

      > Re-run this check by pushing a new commit to this branch."
    `)
  })
})

describe('formatLiteComment — findings (additive)', () => {
  it('renders a single additive card', () => {
    const out = formatLiteComment({
      kind: 'findings',
      result: { contradictions: [], additions: [makeAddition()], rawConfidence: 0.9 },
      docScope: 'docs/',
    })

    expect(out).toMatchInlineSnapshot(`
      "## Delfini — Drift Detected

      **1 finding** found between this PR and your source-of-truth documents in \`docs/\`.

      ---

      ### 1. \`docs/architecture.md\` — new content for "4. Observability"

      **Severity:** Medium · **Insert after line 88**

      **What changed:** The PR adds structured request-completion logging across every API handler.

      **Why add this:** The observability section does not yet mention request-level logging.

      **Proposed addition (insert after line 88):**

      \`\`\`diff
      + All API handlers emit a structured log line on the \`request.completed\` event.
      \`\`\`

      ---

      > Re-run this check by pushing a new commit to this branch."
    `)
  })
})

describe('formatLiteComment — findings (mixed batch)', () => {
  it('renders 2 contradictions + 1 addition with continuous ordinals', () => {
    const out = formatLiteComment({
      kind: 'findings',
      result: {
        contradictions: [
          makeContradiction({ targetDocPath: 'docs/a.md' }),
          makeContradiction({ targetDocPath: 'docs/b.md', proposedReplacement: null }),
        ],
        additions: [makeAddition({ targetDocPath: 'docs/c.md' })],
        rawConfidence: 0.7,
      },
      docScope: 'docs/',
    })

    expect(out).toMatchInlineSnapshot(`
      "## Delfini — Drift Detected

      **3 findings** found between this PR and your source-of-truth documents in \`docs/\`.

      ---

      ### 1. \`docs/a.md\` — 3.2 Batch API

      **Severity:** High · **Lines:** 114–120

      **What changed:** Code now exposes a single-item endpoint instead of the documented batch endpoint.

      **What the docs say:** Section 3.2 states that all payment operations MUST use batch mode to stay within rate limits.

      **Proposed change:**

      \`\`\`diff
      - verbatim doc quote
      + The payment service processes transactions individually via the /v2/process endpoint.
      \`\`\`

      ---

      ### 2. \`docs/b.md\` — 3.2 Batch API

      **Severity:** High · **Lines:** 114–120

      **What changed:** Code now exposes a single-item endpoint instead of the documented batch endpoint.

      **What the docs say:** Section 3.2 states that all payment operations MUST use batch mode to stay within rate limits.

      _No concrete replacement available — review and update this section manually._

      ---

      ### 3. \`docs/c.md\` — new content for "4. Observability"

      **Severity:** Medium · **Insert after line 88**

      **What changed:** The PR adds structured request-completion logging across every API handler.

      **Why add this:** The observability section does not yet mention request-level logging.

      **Proposed addition (insert after line 88):**

      \`\`\`diff
      + All API handlers emit a structured log line on the \`request.completed\` event.
      \`\`\`

      ---

      > Re-run this check by pushing a new commit to this branch."
    `)
  })
})

describe('formatLiteComment — pass', () => {
  it('renders the PASS body with several docs', () => {
    const out = formatLiteComment({
      kind: 'pass',
      docs: [makeDoc('docs/architecture.md'), makeDoc('docs/intro.md'), makeDoc('docs/api.md')],
      docScope: 'docs/',
    })

    expect(out).toMatchInlineSnapshot(`
      "## Delfini — PASS

      No drift detected between this PR and your source-of-truth documents in \`docs/\`.

      3 documents checked."
    `)
  })
})

describe('formatLiteComment — invariants', () => {
  it('never emits a ```suggestion language tag on any body shape', () => {
    const drift = formatLiteComment({
      kind: 'findings',
      result: { contradictions: [makeContradiction()], additions: [], rawConfidence: 0.9 },
      docScope: 'docs/',
    })
    const narrative = formatLiteComment({
      kind: 'findings',
      result: {
        contradictions: [makeContradiction({ proposedReplacement: null })],
        additions: [],
        rawConfidence: 0.9,
      },
      docScope: 'docs/',
    })
    const additive = formatLiteComment({
      kind: 'findings',
      result: { contradictions: [], additions: [makeAddition()], rawConfidence: 0.9 },
      docScope: 'docs/',
    })
    const pass = formatLiteComment({
      kind: 'pass',
      docs: [makeDoc('docs/a.md')],
      docScope: 'docs/',
    })

    for (const body of [drift, narrative, additive, pass]) {
      expect(body).not.toContain('```suggestion')
    }
  })

  it('renders a single-line finding as **Line:** N, not N–N', () => {
    const out = formatLiteComment({
      kind: 'findings',
      result: {
        contradictions: [makeContradiction({ targetLineStart: 87, targetLineEnd: 87 })],
        additions: [],
        rawConfidence: 0.9,
      },
      docScope: 'docs/',
    })

    expect(out).toContain('**Line:** 87')
    expect(out).not.toContain('87–87')
  })

  it.each<Severity>(['High', 'Medium', 'Low'])('renders severity %s literally', (severity) => {
    const out = formatLiteComment({
      kind: 'findings',
      result: { contradictions: [makeContradiction({ severity })], additions: [], rawConfidence: 0.9 },
      docScope: 'docs/',
    })

    expect(out).toContain(`**Severity:** ${severity} ·`)
  })

  it('is deterministic — identical input yields a byte-identical body', () => {
    const input = {
      kind: 'findings' as const,
      result: {
        contradictions: [makeContradiction()],
        additions: [makeAddition()],
        rawConfidence: 0.9,
      },
      docScope: 'docs/',
    }

    expect(formatLiteComment(input)).toBe(formatLiteComment(input))
  })

  it('renders contradictions only when additions is empty', () => {
    const out = formatLiteComment({
      kind: 'findings',
      result: { contradictions: [makeContradiction()], additions: [], rawConfidence: 0.9 },
      docScope: 'docs/',
    })

    expect(out).toContain('### 1.')
    expect(out).toContain('**1 finding** found')
    expect(out).not.toContain('### 2.')
  })
})
