import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { buildPrompt, buildPromptWithDrops } from '../src/prompt-builder'
import { estimatePromptTokens } from '../src/prompt-budget'
import type { AnalysisInput } from '../src/types'

// drift-engine is pure-logic — buildPrompt takes the prompt template as a
// parameter. Tests read the bundled prompt.md from the package itself.
const PROMPT_TEMPLATE = readFileSync(
  fileURLToPath(new URL('../src/prompt.md', import.meta.url)),
  'utf8',
)

const basePrMetadata = {
  owner: 'acme',
  repo: 'widget',
  prNumber: 42,
  headSha: 'abc123',
  baseSha: 'def456',
  title: 'Refactor payments',
}

const sampleDiff = `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
@@ -1 +1 @@
-x
+y
`

describe('buildPrompt', () => {
  it('renders a single document, diff, and all PR metadata fields', () => {
    const input: AnalysisInput = {
      diff: sampleDiff,
      docs: [
        {
          path: 'docs/architecture.md',
          content: '# Arch\nBatch required.',
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE)

    expect(out).toContain('<document path="docs/architecture.md">')
    // Story 3.9b — doc lines are prefix-numbered; the body line "Batch required."
    // is line 2 of the doc (after `# Arch` on line 1).
    expect(out).toContain('1: # Arch')
    expect(out).toContain('2: Batch required.')
    expect(out).toContain(sampleDiff)
    expect(out).toContain('<title>Refactor payments</title>')
    expect(out).toContain('<repo>acme/widget</repo>')
    expect(out).toContain('<pr_number>42</pr_number>')
    expect(out).toContain('<head_sha>abc123</head_sha>')
    expect(out).toContain('<base_sha>def456</base_sha>')
    expect(out).toContain('<changed_file_count>2</changed_file_count>')
    expect(out).not.toContain('{{diff}}')
    expect(out).not.toContain('{{#each docs}}')
    expect(out).not.toContain('{{/each}}')
    expect(out).not.toContain('{{prMetadata.title}}')
    expect(out).not.toContain('{{this.path}}')
  })

  it('loops over multiple documents', () => {
    const input: AnalysisInput = {
      diff: '',
      docs: [
        { path: 'docs/a.md', content: 'Alpha content', frontMatterLineCount: 0 },
        { path: 'docs/b.md', content: 'Bravo content', frontMatterLineCount: 0 },
      ],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE)

    expect(out).toContain('<document path="docs/a.md">')
    expect(out).toContain('Alpha content')
    expect(out).toContain('<document path="docs/b.md">')
    expect(out).toContain('Bravo content')
    expect(out).toContain('<changed_file_count>0</changed_file_count>')
    expect(out.indexOf('docs/a.md')).toBeLessThan(out.indexOf('docs/b.md'))
  })

  it('Story 3.9b — prefixes doc lines with absolute (front-matter-offset) line numbers', () => {
    // Doc with 5 lines of stripped front-matter; the first body line is line 6
    // of the original file.
    const input: AnalysisInput = {
      diff: '',
      docs: [
        { path: 'docs/a.md', content: 'first\nsecond\nthird', frontMatterLineCount: 5 },
        { path: 'docs/b.md', content: 'only', frontMatterLineCount: 0 },
      ],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE)

    // a.md: front-matter offset 5 → body line 1 prints as `6: ...`.
    expect(out).toContain('6: first')
    expect(out).toContain('7: second')
    expect(out).toContain('8: third')
    // b.md: independent offset 0 → first body line prints as `1: ...`.
    expect(out).toContain('1: only')
  })

  it('handles empty docs list', () => {
    const input: AnalysisInput = {
      diff: 'no diff',
      docs: [],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE)

    expect(out).toContain('<documents>')
    expect(out).toContain('</documents>')
    expect(out).not.toContain('{{#each docs}}')
    const documentsStart = out.indexOf('<documents>')
    const documentsEnd = out.indexOf('</documents>', documentsStart)
    const documentsBlock = out.slice(documentsStart, documentsEnd)
    expect(documentsBlock).not.toContain('<document path=')
  })
})

describe('additive findings — always-on canonical prompt', () => {
  const minimalInput: AnalysisInput = {
    diff: '',
    docs: [{ path: 'docs/a.md', content: 'x', frontMatterLineCount: 0 }],
    prMetadata: basePrMetadata,
  }

  it('prompt always contains the Two-kinds Operating Principle, additive schema arm, and additive worked example', () => {
    const out = buildPrompt(minimalInput, PROMPT_TEMPLATE)
    expect(out).toContain('Two kinds of doc-and-code misalignment')
    expect(out).toContain('"additions": [')
    expect(out).toContain('<example name="additive-finding-new-dependency">')
    expect(out).toContain('Both `contradictions` and `additions` MUST always be present')
    // No flag-gating delimiter markers should ever reach the LLM.
    expect(out).not.toContain('<!-- delfini:additive-')
    expect(out).not.toContain('<!-- delfini:drift-only-')
  })
})

describe('buildPrompt — relevance gating', () => {
  it('is observably no-op when options is omitted', () => {
    const input: AnalysisInput = {
      diff: 'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n',
      docs: [
        { path: 'relevant.md', content: 'src/x.ts is here', frontMatterLineCount: 0 },
        { path: 'irrelevant.md', content: '# Unrelated', frontMatterLineCount: 0 },
      ],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE)
    expect(out).toContain('<document path="relevant.md">')
    expect(out).toContain('<document path="irrelevant.md">')
  })

  it('drops below-threshold docs when relevanceThreshold > 0', () => {
    const input: AnalysisInput = {
      diff: 'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n',
      docs: [
        { path: 'relevant.md', content: 'src/x.ts is here', frontMatterLineCount: 0 },
        { path: 'irrelevant.md', content: '# Unrelated', frontMatterLineCount: 0 },
      ],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE, { relevanceThreshold: 5 })
    expect(out).toContain('<document path="relevant.md">')
    expect(out).not.toContain('<document path="irrelevant.md">')
  })

  it('keeps all docs when relevanceThreshold is 0', () => {
    const input: AnalysisInput = {
      diff: '',
      docs: [
        { path: 'a.md', content: 'A', frontMatterLineCount: 0 },
        { path: 'b.md', content: 'B', frontMatterLineCount: 0 },
      ],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE, { relevanceThreshold: 0 })
    expect(out).toContain('<document path="a.md">')
    expect(out).toContain('<document path="b.md">')
  })
})

describe('buildPrompt — section-granularity retrieval (FR150)', () => {
  // Diff touches src/payments.ts; only the Payments section of the doc overlaps.
  const paymentsDiff = `diff --git a/src/payments.ts b/src/payments.ts\n@@ -1 +1 @@\n-old\n+chargeCard(order)\n`

  // Doc with 3 stripped front-matter lines, so body line 1 is original-file
  // line 4. Sections: Intro (lines 4-5), Payments (lines 6-7), Logging (8-9).
  const multiSectionInput: AnalysisInput = {
    diff: paymentsDiff,
    docs: [
      {
        path: 'docs/architecture.md',
        content: [
          '# Intro',
          'intro body',
          '## Payments',
          'See src/payments.ts for chargeCard.',
          '## Logging',
          'logging body',
        ].join('\n'),
        frontMatterLineCount: 3,
      },
    ],
    prMetadata: basePrMetadata,
  }

  it('renders a retained mid-file section with ABSOLUTE original-file line numbers', () => {
    const out = buildPrompt(multiSectionInput, PROMPT_TEMPLATE, { relevanceThreshold: 10 })
    // Payments section starts at body index 2 → absolute line 6 (frontMatter 3 + 2 + 1).
    expect(out).toContain('6: ## Payments')
    expect(out).toContain('7: See src/payments.ts for chargeCard.')
    // NOT renumbered from 1, and NOT shifted up by the dropped Intro section.
    expect(out).not.toContain('1: ## Payments')
    expect(out).not.toContain('4: ## Payments')
  })

  it('drops the irrelevant sibling sections from the rendered doc', () => {
    const out = buildPrompt(multiSectionInput, PROMPT_TEMPLATE, { relevanceThreshold: 10 })
    expect(out).not.toContain('# Intro')
    expect(out).not.toContain('intro body')
    expect(out).not.toContain('## Logging')
    expect(out).not.toContain('logging body')
    // The doc block itself is still present (it had a surviving section).
    expect(out).toContain('<document path="docs/architecture.md">')
  })

  it('retention guard (recall): the ground-truth drift section always survives retrieval', () => {
    // Sweep a range of thresholds — the section carrying the contradiction
    // (Payments, score 19) must never be dropped while it scores at/above.
    for (const threshold of [1, 5, 10, 19]) {
      const out = buildPrompt(multiSectionInput, PROMPT_TEMPLATE, {
        relevanceThreshold: threshold,
      })
      expect(out).toContain('See src/payments.ts for chargeCard.')
    }
  })

  it('omits a doc entirely when no section survives the threshold', () => {
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [
        {
          path: 'docs/unrelated.md',
          content: '# Deployment\nNothing about the change here.',
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE, { relevanceThreshold: 10 })
    expect(out).not.toContain('<document path="docs/unrelated.md">')
  })

  it('retains a whole multi-section doc when its path appears in the diff header', () => {
    const input: AnalysisInput = {
      diff: `diff --git a/docs/architecture.md b/docs/architecture.md\n@@ -1 +1 @@\n-x\n+y\n`,
      docs: multiSectionInput.docs,
      prMetadata: basePrMetadata,
    }
    const out = buildPrompt(input, PROMPT_TEMPLATE, { relevanceThreshold: 10 })
    // docPathInDiff(20) applies to every section → all kept.
    expect(out).toContain('# Intro')
    expect(out).toContain('## Payments')
    expect(out).toContain('## Logging')
  })
})

describe('buildPromptWithDrops — ranked-fill prompt budget (FR152)', () => {
  // Diff touches src/payments.ts; only the Payments section overlaps.
  const paymentsDiff = `diff --git a/src/payments.ts b/src/payments.ts\n@@ -1 +1 @@\n-old\n+chargeCard(order)\n`

  const multiSectionDoc = (path: string) => ({
    path,
    content: [
      '# Intro',
      'intro body',
      '## Payments',
      'See src/payments.ts for chargeCard.',
      '## Logging',
      'logging body',
    ].join('\n'),
    frontMatterLineCount: 0,
  })

  it('default options → byte-identical to `buildPrompt`, empty droppedSections', () => {
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [multiSectionDoc('docs/architecture.md')],
      prMetadata: basePrMetadata,
    }
    const plain = buildPrompt(input, PROMPT_TEMPLATE)
    const dropsy = buildPromptWithDrops(input, PROMPT_TEMPLATE)
    expect(dropsy.prompt).toBe(plain)
    expect(dropsy.droppedSections).toEqual([])
  })

  it('threshold-only (no budget) → byte-identical to threshold-only `buildPrompt`, empty droppedSections', () => {
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [multiSectionDoc('docs/architecture.md')],
      prMetadata: basePrMetadata,
    }
    const plain = buildPrompt(input, PROMPT_TEMPLATE, { relevanceThreshold: 5 })
    const dropsy = buildPromptWithDrops(input, PROMPT_TEMPLATE, { relevanceThreshold: 5 })
    expect(dropsy.prompt).toBe(plain)
    expect(dropsy.droppedSections).toEqual([])
  })

  it('budget-only without threshold → IGNORED, output byte-identical to default', () => {
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [multiSectionDoc('docs/architecture.md')],
      prMetadata: basePrMetadata,
    }
    const plain = buildPrompt(input, PROMPT_TEMPLATE)
    // promptTokenBudget alone (without a positive relevanceThreshold) is a no-op.
    const dropsy = buildPromptWithDrops(input, PROMPT_TEMPLATE, { promptTokenBudget: 1 })
    expect(dropsy.prompt).toBe(plain)
    expect(dropsy.droppedSections).toEqual([])
  })

  it('non-positive / non-finite budget under positive threshold → no ranked-fill (no drops)', () => {
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [multiSectionDoc('docs/architecture.md')],
      prMetadata: basePrMetadata,
    }
    for (const budget of [0, -1, Number.NaN]) {
      const result = buildPromptWithDrops(input, PROMPT_TEMPLATE, {
        relevanceThreshold: 5,
        promptTokenBudget: budget,
      })
      expect(result.droppedSections).toEqual([])
      // Should match the threshold-only path.
      const plain = buildPrompt(input, PROMPT_TEMPLATE, { relevanceThreshold: 5 })
      expect(result.prompt).toBe(plain)
    }
  })

  it('budget too small to fit the highest-scoring section → all retained sections dropped, doc omitted', () => {
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [multiSectionDoc('docs/architecture.md')],
      prMetadata: basePrMetadata,
    }
    // Compute the non-doc baseline cost, then pick a budget that fits the
    // baseline but leaves no room for any retained section.
    const baselineInput: AnalysisInput = { ...input, docs: [] }
    const baseline = estimatePromptTokens(buildPrompt(baselineInput, PROMPT_TEMPLATE))
    // baseline + 1 token of headroom — every section's render cost (≥ a few
    // tokens) exceeds the residual section budget.
    const result = buildPromptWithDrops(input, PROMPT_TEMPLATE, {
      relevanceThreshold: 5,
      promptTokenBudget: baseline + 1,
    })
    expect(result.droppedSections.length).toBeGreaterThan(0)
    // Every dropped section carries its docPath (cross-doc visibility).
    for (const drop of result.droppedSections) {
      expect(drop.docPath).toBe('docs/architecture.md')
    }
    // Doc has no surviving section → its block is omitted from the prompt.
    expect(result.prompt).not.toContain('<document path="docs/architecture.md">')
  })

  it('cross-doc ranking: a high-scoring section from doc B preempts a low-scoring section from doc A', () => {
    // doc-a has a high-scoring section about Auth (matches diff identifier),
    // doc-b has a low-scoring intro. Budget fits only ONE candidate.
    const diff = `diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+authenticate(user)\n`
    const input: AnalysisInput = {
      diff,
      docs: [
        // doc-a comes first in input but has only a low-scoring intro.
        {
          path: 'docs/intro.md',
          content: '# Intro\nunrelated body',
          frontMatterLineCount: 0,
        },
        // doc-b is listed second but contains the high-scoring Auth section.
        {
          path: 'docs/security.md',
          content: '# Security\n## Auth\nSee src/auth.ts for authenticate.',
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: basePrMetadata,
    }
    const result = buildPromptWithDrops(input, PROMPT_TEMPLATE, {
      relevanceThreshold: 5,
      promptTokenBudget: 50_000, // large enough to fit the winner, but irrelevant docs already drop pre-fill
    })
    // The high-scoring doc-b/Auth section appears; low-scoring intro doc-a is omitted.
    expect(result.prompt).toContain('<document path="docs/security.md">')
    expect(result.prompt).toContain('See src/auth.ts for authenticate.')
    expect(result.prompt).not.toContain('<document path="docs/intro.md">')
  })

  it('with retained sections AND a tight budget that fits exactly one section → drops the lower-scoring one', () => {
    // Two docs each with one section matching different files in the diff.
    // Make one strongly-matching (very high score), one weakly-matching.
    const diff = [
      `diff --git a/src/auth.ts b/src/auth.ts`,
      `@@ -1 +1 @@`,
      `-old`,
      `+authenticate(user)`,
      `diff --git a/src/util.ts b/src/util.ts`,
      `@@ -1 +1 @@`,
      `-old`,
      `+helper(x)`,
    ].join('\n')
    const input: AnalysisInput = {
      diff,
      docs: [
        {
          path: 'docs/strong.md',
          // Mentions auth.ts (+10 file overlap) + authenticate identifier from diff (+3) → score 13.
          content: '## Strong\nSee src/auth.ts for authenticate(user) handling.',
          frontMatterLineCount: 0,
        },
        {
          path: 'docs/weak.md',
          // Mentions util.ts (+10 file overlap) only — score 10.
          content: '## Weak\nSee src/util.ts.',
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: basePrMetadata,
    }
    // Compute the non-doc baseline cost, then pick a budget where the
    // residual section budget fits Strong (~28 tokens) but NOT Strong+Weak
    // (~45 tokens). Strong rendered cost ≈ ceil(~70/3.5)+8 ≈ 28; Weak ≈
    // ceil(~30/3.5)+8 ≈ 17.
    const baselineInput: AnalysisInput = { ...input, docs: [] }
    const baseline = estimatePromptTokens(buildPrompt(baselineInput, PROMPT_TEMPLATE))
    const result = buildPromptWithDrops(input, PROMPT_TEMPLATE, {
      relevanceThreshold: 5,
      promptTokenBudget: baseline + 35,
    })
    expect(result.prompt).toContain('<document path="docs/strong.md">')
    expect(result.prompt).not.toContain('<document path="docs/weak.md">')
    expect(result.droppedSections.length).toBeGreaterThanOrEqual(1)
    expect(result.droppedSections.some((d) => d.docPath === 'docs/weak.md')).toBe(true)
  })

  it('sections that fit under threshold but unrelated to diff are not in candidates → no spurious drops', () => {
    // A doc with two retained sections (both meet the threshold). Generous
    // budget fits both → no drops.
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [
        {
          path: 'docs/architecture.md',
          // Both sections score >= 5 because both mention payments-related identifiers.
          content: [
            '## Payments overview',
            'src/payments.ts handles chargeCard.',
            '## Payments detail',
            'chargeCard(order) is the entry point in src/payments.ts.',
          ].join('\n'),
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: basePrMetadata,
    }
    const result = buildPromptWithDrops(input, PROMPT_TEMPLATE, {
      relevanceThreshold: 5,
      promptTokenBudget: 100_000,
    })
    expect(result.droppedSections).toEqual([])
    expect(result.prompt).toContain('## Payments overview')
    expect(result.prompt).toContain('## Payments detail')
  })

  it('preserves absolute line numbers on surviving sections after ranked-fill (FR150 invariant)', () => {
    const input: AnalysisInput = {
      diff: paymentsDiff,
      docs: [
        {
          path: 'docs/architecture.md',
          content: [
            '# Intro', // body line 1
            'intro body', // 2
            '## Payments', // 3
            'See src/payments.ts for chargeCard.', // 4
          ].join('\n'),
          frontMatterLineCount: 3, // absolute = body + 3
        },
      ],
      prMetadata: basePrMetadata,
    }
    const result = buildPromptWithDrops(input, PROMPT_TEMPLATE, {
      relevanceThreshold: 10,
      promptTokenBudget: 100_000,
    })
    // Payments section: body lines 3-4, frontMatter 3 → absolute 6 and 7.
    expect(result.prompt).toContain('6: ## Payments')
    expect(result.prompt).toContain('7: See src/payments.ts for chargeCard.')
  })

  it('within a doc, surviving sections render in original file order (NOT ranked order)', () => {
    // Doc with two retained sections that both match the diff. We construct
    // it so the LATER section in the file scores HIGHER than the earlier one.
    // After ranked-fill (which globally ranks by score) the rendered doc must
    // still emit the earlier section first because the prompt reads top-down.
    const diff = `diff --git a/src/payments.ts b/src/payments.ts\n@@ -1 +1 @@\n-old\n+chargeCard(order)\n`
    const input: AnalysisInput = {
      diff,
      docs: [
        {
          path: 'docs/architecture.md',
          content: [
            '## Earlier section', // body lines 1-2 — fileOverlap(10) = 10
            'See src/payments.ts.',
            '## Later section', // body lines 3-4 — fileOverlap(10) + identifier(3) = 13
            'See src/payments.ts for chargeCard handling.',
          ].join('\n'),
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: basePrMetadata,
    }
    const result = buildPromptWithDrops(input, PROMPT_TEMPLATE, {
      relevanceThreshold: 5,
      promptTokenBudget: 100_000,
    })
    const earlierIdx = result.prompt.indexOf('## Earlier section')
    const laterIdx = result.prompt.indexOf('## Later section')
    // Both should be present (generous budget) and earlier comes first in the
    // rendered doc body even though Later has a higher score.
    expect(earlierIdx).toBeGreaterThan(-1)
    expect(laterIdx).toBeGreaterThan(-1)
    expect(earlierIdx).toBeLessThan(laterIdx)
  })
})

describe('prompt-file structure', () => {
  it('design-notes file points back at the runtime prompt as canonical', () => {
    const designNotes = readFileSync(
      fileURLToPath(
        new URL('../../../docs/delfini-prompts/delfini-compare-diffs.md', import.meta.url),
      ),
      'utf8',
    )

    expect(designNotes).toContain('packages/drift-engine/src/prompt.md')
  })
})

describe('residual-drift fixture parity (P3.7.4 / FR153)', () => {
  // The committed residual-drift corpus is the durable contract that an
  // already-applied (post-PR-head) doc is not re-flagged while an unfixed
  // sibling still drifts. drift-engine has no I/O, so the test reads the
  // fixture JSON itself and asserts the pure rendering contract: the post-PR
  // head bytes of both docs flow through buildPrompt into the assembled prompt.
  // The behavioural "LLM doesn't re-flag" assertion is the release-time NFR40
  // eval (Story P3.7.5) — out of scope for this per-commit unit suite.

  interface ResidualLabels {
    residualDocPaths: string[]
    alreadyAppliedDocPaths: string[]
  }

  const caseDir = './fixtures/residual-drift/case-01-already-applied'

  const fixtureInput: AnalysisInput = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`${caseDir}/analysis-input.json`, import.meta.url)),
      'utf8',
    ),
  )

  const fixtureLabels: ResidualLabels = JSON.parse(
    readFileSync(fileURLToPath(new URL(`${caseDir}/expected.json`, import.meta.url)), 'utf8'),
  )

  it('fixture parses as a well-formed AnalysisInput shape', () => {
    expect(typeof fixtureInput.diff).toBe('string')
    expect(fixtureInput.diff.length).toBeGreaterThan(0)
    expect(Array.isArray(fixtureInput.docs)).toBe(true)
    expect(fixtureInput.docs.length).toBeGreaterThan(0)
    for (const doc of fixtureInput.docs) {
      expect(typeof doc.path).toBe('string')
      expect(typeof doc.content).toBe('string')
      expect(typeof doc.frontMatterLineCount).toBe('number')
    }
    const m = fixtureInput.prMetadata
    expect(typeof m.owner).toBe('string')
    expect(typeof m.repo).toBe('string')
    expect(typeof m.prNumber).toBe('number')
    expect(typeof m.headSha).toBe('string')
    expect(typeof m.baseSha).toBe('string')
    expect(typeof m.title).toBe('string')
  })

  it('labels enumerate exactly the doc paths in docs[] (no drift between corpus and labels)', () => {
    const docPaths = fixtureInput.docs.map((d) => d.path).sort()
    const labelled = [
      ...fixtureLabels.residualDocPaths,
      ...fixtureLabels.alreadyAppliedDocPaths,
    ].sort()
    expect(labelled).toEqual(docPaths)
  })

  it('label intent matches the doc bodies — applied doc is fixed, residual doc still drifts', () => {
    // Ties each label to the doc body it claims, so a future edit that swaps
    // the two bodies but leaves the labels untouched fails loudly (the
    // set-parity test above would not catch that). The applied doc reflects
    // the corrected post-PR head ("60 seconds"); the residual doc still carries
    // the un-updated claim ("30 seconds").
    const byPath = new Map(fixtureInput.docs.map((d) => [d.path, d.content]))
    for (const p of fixtureLabels.alreadyAppliedDocPaths) {
      expect(byPath.get(p)).toContain('60 seconds')
      expect(byPath.get(p)).not.toContain('30 seconds')
    }
    for (const p of fixtureLabels.residualDocPaths) {
      expect(byPath.get(p)).toContain('30 seconds')
      expect(byPath.get(p)).not.toContain('60 seconds')
    }
  })

  it('buildPrompt renders the post-PR-head bytes of both the already-applied and the residual doc', () => {
    const out = buildPrompt(fixtureInput, PROMPT_TEMPLATE)

    // Already-applied doc: rendered under its own <document> block, body
    // reflects the post-PR head ("60 seconds") — the corrected text the
    // developer already wrote on the branch, never the pre-PR "30 seconds".
    expect(out).toContain('<document path="docs/aligned.md">')
    expect(out).toContain('The session timeout is 60 seconds.')

    // Residual doc: still drifts ("30 seconds") in its post-PR-head content.
    expect(out).toContain('<document path="docs/unfixed.md">')
    expect(out).toContain('4: The session timeout is 30 seconds.')
  })
})
