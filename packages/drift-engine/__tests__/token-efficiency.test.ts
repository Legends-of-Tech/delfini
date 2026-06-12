// Story P3.7.5 / NFR49 — token-efficiency measurement + parity-gate policy.
//
// Three describe blocks, each LLM-free + deterministic + sub-second:
//   1. token-reduction gate — `tokensOn / tokensOff <= MAX_PROMPT_TOKEN_RATIO_*`
//      against named-constant thresholds locked from measured baselines.
//   2. retention gate — the labelled ground-truth section MUST survive
//      `selectRelevantSections` + `rankedFillSections` (the LLM-free recall
//      guard; behavioural recall is the release-time NFR40 eval set).
//   3. NFR49(b) keep-all fast-path regression — every default / threshold:0 /
//      threshold:-1 / threshold:NaN / budget:0 invocation of `buildPrompt`
//      MUST emit byte-identical output. Catches a regression that would
//      silently activate retrieval on the default path.
//
// No LLM call, no network, no `process.env`, no clock. Fixture data is
// deterministic by construction; the gate runs under
// `pnpm --filter @delfini/drift-engine test` in well under a second.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildPrompt, estimatePromptTokens, filterDiff } from '../src/index'
import {
  rankedFillSections,
  scoreDocRelevance,
  selectRelevantSections,
  type RankedFillCandidate,
} from '../src/relevance'
import type { AnalysisInput, DocFile } from '../src/types'

// --- Named-constant thresholds (AC2) ----------------------------------------
//
// Measured-then-locked: the dev ran `node --import tsx
// packages/drift-engine/scripts/measure-tokens.ts`, read the actual
// `tokensOn / tokensOff` ratio per fixture, and locked the constant at
// the measured value plus a comfortable margin so an innocuous fixture
// edit does not flip the gate red. `node --import tsx
// packages/drift-engine/scripts/measure-tokens.ts` reproduces these
// numbers on demand.

// baseline: 0.5719 measured 2026-06-05 on case-01-doc-heavy at
// threshold=5, budget=150_000; locked at 0.70 to give ~13 percentage
// points of headroom for innocuous fixture edits.
export const MAX_PROMPT_TOKEN_RATIO_DOC_HEAVY = 0.7

// baseline: 0.7482 measured 2026-06-05 on case-02-noisy-diff at
// threshold=5, budget=150_000; locked at 0.85 to give ~10 percentage
// points of headroom. The headline reduction driver here is
// `filterDiff` dropping the lockfile / generated / whitespace hunks;
// the single in-scope doc is small so retrieval contributes less.
export const MAX_PROMPT_TOKEN_RATIO_NOISY_DIFF = 0.85

// Standard test-time retrieval parameters. `RELEVANCE_THRESHOLD = 5`
// matches the canonical value documented across P3.7.1 / P3.7.3 stories
// and the CLI's `--relevance-threshold` user-flag convention.
// `PROMPT_TOKEN_BUDGET = 150_000` mirrors the named constant in
// `packages/cli/src/commands/local-prepare.ts:64` (drift-engine cannot
// import from `packages/cli`; a future change to that constant must
// update this one in lockstep — it is duplicated by construction).
const RELEVANCE_THRESHOLD = 5
const PROMPT_TOKEN_BUDGET = 150_000

// --- Fixture loading --------------------------------------------------------

interface ExpectedLabel {
  groundTruthDocPath: string
  groundTruthSection: { startLineIndex: number; headingText: string }
}

function loadFixture(corpus: string, slug: string): AnalysisInput {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`./fixtures/${corpus}/${slug}/analysis-input.json`, import.meta.url),
      ),
      'utf8',
    ),
  ) as AnalysisInput
}

function loadExpected(corpus: string, slug: string): ExpectedLabel {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`./fixtures/${corpus}/${slug}/expected.json`, import.meta.url),
      ),
      'utf8',
    ),
  ) as ExpectedLabel
}

const promptTemplate = readFileSync(
  fileURLToPath(new URL('../src/prompt.md', import.meta.url)),
  'utf8',
)

// --- Retention-gate helper: score + measure mirror the production path ------
//
// `renderWithRankedFill` in `prompt-builder.ts` computes a per-section score
// via `scoreDocRelevance` on a synthetic single-section doc whose
// `frontMatterLineCount` is offset by the section's `startLineIndex`. We
// replicate that here so the ranking key is identical to production. The
// `measure` closure can be looser — with `PROMPT_TOKEN_BUDGET = 150_000` the
// budget never binds on these fixtures, so ranked-fill is effectively a
// pass-through. A simple `estimatePromptTokens(rendered)` measure suffices
// for the retention assertion (the gate is "does the ground-truth survive",
// not "does production measure each candidate byte-exactly").

function scoreSection(
  doc: DocFile,
  section: { lines: string[]; startLineIndex: number },
  diff: string,
): number {
  const singleSectionDoc: DocFile = {
    path: doc.path,
    content: section.lines.join('\n'),
    frontMatterLineCount: doc.frontMatterLineCount + section.startLineIndex,
  }
  return scoreDocRelevance(singleSectionDoc, diff).score
}

function measureCandidate(candidate: RankedFillCandidate): number {
  return estimatePromptTokens(candidate.section.lines.join('\n'))
}

// --- 1. Token-reduction gate (AC2 / NFR49(a)) -------------------------------

describe('token-reduction gate (P3.7.5 / NFR49(a))', () => {
  it('case-01-doc-heavy: retrieval-on tokens land below MAX_PROMPT_TOKEN_RATIO_DOC_HEAVY', () => {
    const input = loadFixture('token-efficiency', 'case-01-doc-heavy')
    const tokensOff = estimatePromptTokens(buildPrompt(input, promptTemplate))
    const tokensOn = estimatePromptTokens(
      buildPrompt(input, promptTemplate, {
        relevanceThreshold: RELEVANCE_THRESHOLD,
        promptTokenBudget: PROMPT_TOKEN_BUDGET,
      }),
    )
    const ratio = tokensOn / tokensOff
    // eslint-disable-next-line no-console
    console.log(
      `[token-reduction] case-01-doc-heavy off=${tokensOff} on=${tokensOn} ratio=${ratio.toFixed(4)} threshold=${MAX_PROMPT_TOKEN_RATIO_DOC_HEAVY}`,
    )
    expect(ratio).toBeLessThanOrEqual(MAX_PROMPT_TOKEN_RATIO_DOC_HEAVY)
  })

  it('case-02-noisy-diff: filterDiff + retrieval-on tokens land below MAX_PROMPT_TOKEN_RATIO_NOISY_DIFF', () => {
    const input = loadFixture('token-efficiency', 'case-02-noisy-diff')
    const tokensOff = estimatePromptTokens(buildPrompt(input, promptTemplate))
    // Mirror the consumer-gate location: `filterDiff` runs at input-assembly,
    // BEFORE `buildPrompt`. The replaced `diff` is then fed into retrieval.
    const filtered = filterDiff(input.diff)
    const tokensOn = estimatePromptTokens(
      buildPrompt(
        { ...input, diff: filtered.keptDiff },
        promptTemplate,
        {
          relevanceThreshold: RELEVANCE_THRESHOLD,
          promptTokenBudget: PROMPT_TOKEN_BUDGET,
        },
      ),
    )
    const ratio = tokensOn / tokensOff
    // eslint-disable-next-line no-console
    console.log(
      `[token-reduction] case-02-noisy-diff off=${tokensOff} on=${tokensOn} ratio=${ratio.toFixed(4)} threshold=${MAX_PROMPT_TOKEN_RATIO_NOISY_DIFF}`,
    )
    expect(ratio).toBeLessThanOrEqual(MAX_PROMPT_TOKEN_RATIO_NOISY_DIFF)
    // Sanity: filter actually dropped something on case-02 (otherwise the
    // expected ratio rationale collapses). Three path-level drops expected:
    // pnpm-lock.yaml (lockfile), routeTree.gen.ts (generated), and the
    // all-hunks-dropped whitespace.ts (promoted to path-level drop).
    expect(filtered.droppedPaths.length).toBeGreaterThanOrEqual(3)
  })
})

// --- 2. Retention gate / LLM-free recall guard (AC3 / NFR49(a)) -------------

describe('retention gate (P3.7.5 / NFR49(a))', () => {
  const cases = [
    { corpus: 'token-efficiency', slug: 'case-01-doc-heavy', filterFirst: false },
    { corpus: 'token-efficiency', slug: 'case-02-noisy-diff', filterFirst: true },
    { corpus: 'residual-drift', slug: 'case-01-already-applied', filterFirst: false },
  ] as const

  for (const { corpus, slug, filterFirst } of cases) {
    it(`${corpus}/${slug}: ground-truth section survives selectRelevantSections + rankedFillSections`, () => {
      const input = loadFixture(corpus, slug)
      const expected = loadExpected(corpus, slug)
      const diff = filterFirst ? filterDiff(input.diff).keptDiff : input.diff

      // Step 1: per-doc retrieval at the canonical threshold. Build the
      // cross-doc flat candidate list ranked-fill consumes.
      const candidates: RankedFillCandidate[] = []
      for (const doc of input.docs) {
        const { kept } = selectRelevantSections(doc, diff, RELEVANCE_THRESHOLD)
        for (const section of kept) {
          candidates.push({
            doc,
            section,
            score: scoreSection(doc, section, diff),
          })
        }
      }

      // Step 2: ranked-fill within the canonical budget.
      const result = rankedFillSections(
        candidates,
        PROMPT_TOKEN_BUDGET,
        measureCandidate,
      )

      const isGroundTruth = (c: RankedFillCandidate) =>
        c.doc.path === expected.groundTruthDocPath &&
        c.section.startLineIndex === expected.groundTruthSection.startLineIndex

      expect(result.included.some(isGroundTruth)).toBe(true)
      expect(result.dropped.some(isGroundTruth)).toBe(false)
    })
  }

  // The loop above runs ranked-fill at the production budget (150_000), which
  // never binds on these small fixtures — so it guards `selectRelevantSections`
  // recall but leaves `rankedFillSections`'s drop path un-exercised. This case
  // sets the budget to the ground-truth candidate's OWN measured cost so the
  // drop path is genuinely taken: the dominant-scoring ground-truth (score ≫
  // any sibling) is ranked first and fits exactly (inclusive bound), forcing
  // every lower-scoring candidate to overflow into `dropped`. Budget tracks the
  // ground-truth's own size rather than an absolute literal, so the case stays
  // robust to fixture-size edits.
  it('case-01-doc-heavy: ground-truth survives ranked-fill under a BINDING budget (drop path exercised)', () => {
    const input = loadFixture('token-efficiency', 'case-01-doc-heavy')
    const expected = loadExpected('token-efficiency', 'case-01-doc-heavy')

    const candidates: RankedFillCandidate[] = []
    for (const doc of input.docs) {
      const { kept } = selectRelevantSections(doc, input.diff, RELEVANCE_THRESHOLD)
      for (const section of kept) {
        candidates.push({ doc, section, score: scoreSection(doc, section, input.diff) })
      }
    }

    const isGroundTruth = (c: RankedFillCandidate) =>
      c.doc.path === expected.groundTruthDocPath &&
      c.section.startLineIndex === expected.groundTruthSection.startLineIndex

    const groundTruth = candidates.find(isGroundTruth)
    expect(groundTruth).toBeDefined()
    // Sanity: the ground-truth must out-score every sibling so it is ranked
    // first — otherwise a binding budget could legitimately drop it.
    const maxSiblingScore = Math.max(
      ...candidates.filter((c) => !isGroundTruth(c)).map((c) => c.score),
    )
    expect((groundTruth as RankedFillCandidate).score).toBeGreaterThan(maxSiblingScore)

    const bindingBudget = measureCandidate(groundTruth as RankedFillCandidate)
    const result = rankedFillSections(candidates, bindingBudget, measureCandidate)

    // Drop path genuinely exercised: at least one lower-scoring candidate
    // overflowed the budget...
    expect(result.dropped.length).toBeGreaterThanOrEqual(1)
    // ...yet the dominant ground-truth section survives.
    expect(result.included.some(isGroundTruth)).toBe(true)
    expect(result.dropped.some(isGroundTruth)).toBe(false)
  })
})

// --- 3. NFR49(b) keep-all fast-path regression (AC5) ------------------------
//
// The default-off path MUST emit byte-identical `buildPrompt` output for
// every fixture in the new token-efficiency corpus. This is the contract
// that keeps the three NFR44 release gates green with no re-snapshot.
//
// If a future PR silently activates retrieval on the default path (e.g.
// flips a `<= 0` guard to `< 0`), this test fails loud across every
// fixture — catching it before the snapshot gate would have a chance to
// react.

describe('NFR49(b) keep-all fast-path regression (P3.7.5)', () => {
  const fixtures = [
    { corpus: 'token-efficiency', slug: 'case-01-doc-heavy' },
    { corpus: 'token-efficiency', slug: 'case-02-noisy-diff' },
  ] as const

  for (const { corpus, slug } of fixtures) {
    it(`${corpus}/${slug}: default / threshold:0 / threshold:-1 / threshold:NaN / budget:0 all match the no-options baseline byte-for-byte`, () => {
      const input = loadFixture(corpus, slug)
      const baseline = buildPrompt(input, promptTemplate)

      expect(buildPrompt(input, promptTemplate, { relevanceThreshold: 0 })).toBe(
        baseline,
      )
      expect(buildPrompt(input, promptTemplate, { relevanceThreshold: -1 })).toBe(
        baseline,
      )
      expect(
        buildPrompt(input, promptTemplate, { relevanceThreshold: Number.NaN }),
      ).toBe(baseline)
      // budget without positive threshold → retrieval gate is off, budget
      // is ignored, output unchanged.
      expect(buildPrompt(input, promptTemplate, { promptTokenBudget: 0 })).toBe(
        baseline,
      )
      expect(
        buildPrompt(input, promptTemplate, {
          promptTokenBudget: PROMPT_TOKEN_BUDGET,
          relevanceThreshold: 0,
        }),
      ).toBe(baseline)
      // NOTE: the `{ relevanceThreshold > 0 }` (budget-off) combination is
      // deliberately NOT asserted here. With a positive threshold, retrieval
      // is ACTIVE — the output lands on the per-doc gated render, which
      // legitimately differs from the whole-doc baseline, so an equality
      // check would be wrong. That threshold-on / budget-off render path is
      // exercised by the section-retrieval tests in `prompt-builder.test.ts`
      // (P3.7.1); this block only pins the keep-all fast-paths that MUST stay
      // byte-identical to the no-options baseline.
    })
  }
})
