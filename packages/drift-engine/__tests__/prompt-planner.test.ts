import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../src/prompt-builder'
import { estimatePromptTokens } from '../src/prompt-budget'
import { planPrompts } from '../src/prompt-planner'
import { parseDiffHunks, renderHunksAsDiff } from '../src/diff-hunks'
import type { AnalysisInput, PRMetadata } from '../src/types'

const PROMPT_TEMPLATE = readFileSync(
  fileURLToPath(new URL('../src/prompt.md', import.meta.url)),
  'utf8',
)

const prMetadata: PRMetadata = {
  owner: 'acme',
  repo: 'widget',
  prNumber: 1,
  headSha: 'abc1234',
  baseSha: 'def5678',
  title: 'Test PR',
}

function loadFixture(rel: string): AnalysisInput {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'),
  ) as AnalysisInput
}

const THRESHOLD = 5
const HUGE_BUDGET = 150_000

// --- diff-hunks parser/renderer ---------------------------------------------

describe('diff-hunks', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    '@@ -10,1 +10,1 @@',
    '-foo',
    '+bar',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '',
  ].join('\n')

  it('splits into file-tagged hunks', () => {
    const hunks = parseDiffHunks(diff)
    expect(hunks).toHaveLength(3)
    expect(hunks[0].filePath).toBe('src/a.ts')
    expect(hunks[1].filePath).toBe('src/a.ts')
    expect(hunks[2].filePath).toBe('src/b.ts')
    expect(hunks[0].header).toContain('@@ -1,2 +1,2 @@')
    expect(hunks[0].body).toContain('+new')
  })

  it('re-emits a subset as a valid diff (file header once, hunks grouped)', () => {
    const hunks = parseDiffHunks(diff)
    // Select both a.ts hunks + the b.ts hunk → round-trips to the whole diff.
    expect(renderHunksAsDiff(hunks)).toBe(diff)
    // Select only the second a.ts hunk → one file header, one hunk.
    const sub = renderHunksAsDiff([hunks[1]])
    expect(sub).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(sub).toContain('@@ -10,1 +10,1 @@')
    expect(sub).not.toContain('@@ -1,2 +1,2 @@')
    expect(sub).not.toContain('src/b.ts')
  })

  it('is deterministic and lossless for empty input', () => {
    expect(parseDiffHunks('')).toEqual([])
    expect(renderHunksAsDiff([])).toBe('')
  })
})

// --- Fast path = parity with buildPrompt ------------------------------------

describe('planPrompts fast path (NFR44 parity)', () => {
  const input: AnalysisInput = {
    diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    docs: [{ path: 'docs/x.md', content: '# X\nThe a.ts module.', frontMatterLineCount: 0 }],
    prMetadata,
  }

  it('returns ONE chunk byte-identical to buildPrompt when the prompt fits', () => {
    const result = planPrompts(input, PROMPT_TEMPLATE, {
      promptTokenBudget: HUGE_BUDGET,
      relevanceThreshold: THRESHOLD,
    })
    expect(result.split).toBe(false)
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0].prompt).toBe(buildPrompt(input, PROMPT_TEMPLATE))
    expect(result.chunks[0].overBudget).toBe(false)
    expect(result.oversizedSections).toEqual([])
    expect(result.droppedHunkFilePaths).toEqual([])
  })

  it('over budget with no usable threshold → single over-budget chunk, not split', () => {
    const tokens = estimatePromptTokens(buildPrompt(input, PROMPT_TEMPLATE))
    const result = planPrompts(input, PROMPT_TEMPLATE, {
      promptTokenBudget: tokens - 1,
      relevanceThreshold: 0,
    })
    expect(result.split).toBe(false)
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0].overBudget).toBe(true)
  })
})

// --- Cross-file co-location contract (the load-bearing guarantee) -----------

describe('planPrompts cross-file fixture', () => {
  const input = loadFixture(
    './fixtures/cross-file/case-01-session-ttl/analysis-input.json',
  )
  const wholeTokens = estimatePromptTokens(buildPrompt(input, PROMPT_TEMPLATE))

  it('holds the contract across budgets: cross-file finding co-located OR its anchor reported oversized; non-flagged chunks respect budget', () => {
    for (const frac of [0.7, 0.5, 0.3, 0.15]) {
      const budget = Math.max(200, Math.floor(wholeTokens * frac))
      const result = planPrompts(input, PROMPT_TEMPLATE, {
        promptTokenBudget: budget,
        relevanceThreshold: THRESHOLD,
      })
      expect(result.split).toBe(true)

      const both = result.chunks.find(
        (c) =>
          c.hunkFilePaths.includes('src/auth/issuer.ts') &&
          c.hunkFilePaths.includes('src/auth/validator.ts'),
      )
      const anchorOversized = result.oversizedSections.some(
        (s) => s.heading === '## Session Tokens',
      )
      // Either the two contributing files are in ONE chunk (preserved), or the
      // anchor section was too big to keep whole and is reported (the honest
      // impossibility case) — never silently lost.
      expect(Boolean(both) || anchorOversized).toBe(true)

      // Every chunk that is NOT flagged over-budget must respect the budget.
      for (const chunk of result.chunks) {
        if (!chunk.overBudget) {
          expect(chunk.estimatedTokens).toBeLessThanOrEqual(budget)
        }
      }
      // Every chunk renders a usable prompt.
      for (const chunk of result.chunks) {
        expect(chunk.prompt).toContain('<document path=')
      }
    }
  })

  it('is deterministic', () => {
    const opts = { promptTokenBudget: Math.floor(wholeTokens * 0.4), relevanceThreshold: THRESHOLD }
    const a = planPrompts(input, PROMPT_TEMPLATE, opts)
    const b = planPrompts(input, PROMPT_TEMPLATE, opts)
    expect(a).toEqual(b)
  })
})

// --- Controlled cross-file co-location (guaranteed-preservation happy path) --
//
// A small `## Auth` section that the two cross-file hunks route to, plus a big
// `## Bulk` section that many unrelated hunks route to. At a budget that fits
// Auth-plus-its-2-hunks but forces Bulk to split, the cross-file finding's two
// files MUST land in one chunk and that anchor MUST stay whole — the core
// guarantee, isolated from the realistic fixture's path-token over-attraction.

describe('planPrompts controlled cross-file co-location', () => {
  function bulkDiff(n: number): string {
    let out = ''
    for (let i = 0; i < n; i++) {
      out +=
        `diff --git a/src/bulk/bulk-${i}.ts b/src/bulk/bulk-${i}.ts\n` +
        `--- a/src/bulk/bulk-${i}.ts\n+++ b/src/bulk/bulk-${i}.ts\n` +
        `@@ -1,2 +1,2 @@\n` +
        `-export const bulkThing = makeBulkThing(${i})\n` +
        `+export const bulkThing = makeBulkThing(${i} + 1)\n`
    }
    return out
  }
  const crossFileDiff =
    'diff --git a/src/auth/issuer.ts b/src/auth/issuer.ts\n' +
    '--- a/src/auth/issuer.ts\n+++ b/src/auth/issuer.ts\n' +
    '@@ -1,2 +1,2 @@\n-  const ttl = 3600 // issueSessionToken\n+  const ttl = 7200 // issueSessionToken\n' +
    'diff --git a/src/auth/validator.ts b/src/auth/validator.ts\n' +
    '--- a/src/auth/validator.ts\n+++ b/src/auth/validator.ts\n' +
    '@@ -1,2 +1,2 @@\n-  return age <= 3600 // validateSessionToken\n+  return age <= 3600 // validateSessionToken unchanged\n'

  const input: AnalysisInput = {
    diff: crossFileDiff + bulkDiff(40),
    docs: [
      {
        path: 'docs/auth.md',
        content:
          '# Auth\n\n## Auth\n\n`issueSessionToken` in `src/auth/issuer.ts` and ' +
          '`validateSessionToken` in `src/auth/validator.ts` must agree on the TTL.\n\n' +
          '## Bulk\n\nThe `bulkThing` / `makeBulkThing` registry under `src/bulk/` ' +
          'is populated by every `src/bulk/bulk-*.ts` module.',
        frontMatterLineCount: 0,
      },
    ],
    prMetadata,
  }
  // Every chunk pays the full template + framing cost — the per-chunk FLOOR.
  // The budget must sit above the floor (else even an empty chunk overflows),
  // with enough room for the small Auth section + its 2 hunks but not the 40
  // bulk hunks. Derive it from the measured floor so it is robust to template
  // edits (rather than a fragile fraction of the whole-prompt size).
  const floor = estimatePromptTokens(
    buildPrompt({ diff: '', docs: [], prMetadata }, PROMPT_TEMPLATE),
  )

  it('keeps issuer.ts + validator.ts in one chunk while the big section splits', () => {
    const result = planPrompts(input, PROMPT_TEMPLATE, {
      promptTokenBudget: floor + 300,
      relevanceThreshold: THRESHOLD,
    })
    expect(result.split).toBe(true)
    // The cross-file anchor is small → never oversized.
    expect(result.oversizedSections.some((s) => s.heading === '## Auth')).toBe(false)
    // Its two files are co-located in one chunk, prompt carries both changes.
    const both = result.chunks.find(
      (c) =>
        c.hunkFilePaths.includes('src/auth/issuer.ts') &&
        c.hunkFilePaths.includes('src/auth/validator.ts'),
    )
    expect(both).toBeDefined()
    expect(both!.prompt).toContain('src/auth/issuer.ts')
    expect(both!.prompt).toContain('src/auth/validator.ts')
    expect(both!.overBudget).toBe(false)
  })
})

// --- Concentrated single-section over-budget wall ---------------------------

describe('planPrompts concentrated section (Level 2 over-budget wall)', () => {
  // One small section that many hunks route to, plus a tiny budget so the
  // section + its hunks cannot fit one prompt → Level 2 sub-split + loud signal.
  function manyHunkDiff(n: number): string {
    let out = ''
    for (let i = 0; i < n; i++) {
      out +=
        `diff --git a/src/core/widget-${i}.ts b/src/core/widget-${i}.ts\n` +
        `--- a/src/core/widget-${i}.ts\n+++ b/src/core/widget-${i}.ts\n` +
        `@@ -1,3 +1,3 @@\n` +
        `-export const coreWidget = makeCoreWidget(${i})\n` +
        `+export const coreWidget = makeCoreWidget(${i} + 1)\n` +
        ` // coreWidget powers the CoreWidget subsystem\n`
    }
    return out
  }

  const input: AnalysisInput = {
    diff: manyHunkDiff(30),
    docs: [
      {
        path: 'docs/core.md',
        content:
          '# Core\n\n## CoreWidget\n\nThe `coreWidget` / `makeCoreWidget` / `CoreWidget` subsystem ' +
          'lives in `src/core/`. Every `src/core/widget-*.ts` module registers a coreWidget.',
        frontMatterLineCount: 0,
      },
    ],
    prMetadata,
  }

  it('sub-splits the concentrated section and reports it loudly (never drops it)', () => {
    const result = planPrompts(input, PROMPT_TEMPLATE, {
      promptTokenBudget: 600,
      relevanceThreshold: THRESHOLD,
    })
    expect(result.split).toBe(true)
    // The one section was too big → sub-split across multiple chunks, reported.
    const oversized = result.oversizedSections.find((s) => s.heading === '## CoreWidget')
    expect(oversized).toBeDefined()
    expect(oversized!.splitAcross).toBeGreaterThan(1)
    // Many chunks, and the section's hunks are spread but NONE dropped: every
    // widget file appears in some chunk.
    const filesSeen = new Set(result.chunks.flatMap((c) => c.hunkFilePaths))
    for (let i = 0; i < 30; i++) {
      expect(filesSeen.has(`src/core/widget-${i}.ts`)).toBe(true)
    }
  })
})
