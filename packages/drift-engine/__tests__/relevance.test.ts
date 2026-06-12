import { describe, it, expect } from 'vitest'
import {
  scoreDocRelevance,
  selectRelevantDocs,
  splitIntoSections,
  selectRelevantSections,
  rankedFillSections,
  type RankedFillCandidate,
} from '../src/relevance'
import type { DocFile } from '../src/types'

describe('relevance', () => {
  it('exports scoreDocRelevance and selectRelevantDocs', () => {
    expect(typeof scoreDocRelevance).toBe('function')
    expect(typeof selectRelevantDocs).toBe('function')
  })
})

const sampleDoc = (path: string, content = '# Title\n\nBody.'): import('../src/types').DocFile => ({
  path,
  content,
  frontMatterLineCount: 0,
})

describe('scoreDocRelevance — Tier 1 (doc path in diff)', () => {
  it('scores 20 when the doc itself appears in the diff header', () => {
    const diff = `diff --git a/docs/architecture.md b/docs/architecture.md
@@ -1 +1 @@
-old
+new
`
    const result = scoreDocRelevance(sampleDoc('docs/architecture.md'), diff)
    expect(result.breakdown.docPathInDiff).toBe(20)
    expect(result.score).toBeGreaterThanOrEqual(20)
  })

  it('scores 0 when the doc path does not appear in the diff', () => {
    const diff = `diff --git a/src/payments.ts b/src/payments.ts
@@ -1 +1 @@
-old
+new
`
    const result = scoreDocRelevance(sampleDoc('docs/architecture.md'), diff)
    expect(result.breakdown.docPathInDiff).toBe(0)
  })
})

describe('scoreDocRelevance — Tier 2 (code-file path overlap)', () => {
  it('scores +10 per code-file path from diff that appears in doc body', () => {
    const diff = `diff --git a/src/payments.ts b/src/payments.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/auth.ts b/src/auth.ts
@@ -1 +1 @@
-old
+new
`
    const docContent = `# Architecture\n\nSee src/payments.ts for the payment flow. Auth is in src/auth.ts.\n`
    const result = scoreDocRelevance(sampleDoc('docs/architecture.md', docContent), diff)
    expect(result.breakdown.fileOverlap).toBe(20) // 2 files × +10
  })

  it('scores 0 when no diff file paths appear in the doc', () => {
    const diff = `diff --git a/src/payments.ts b/src/payments.ts
@@ -1 +1 @@
-old
+new
`
    const docContent = `# Architecture\n\nThis doc talks about deployment.\n`
    const result = scoreDocRelevance(sampleDoc('docs/architecture.md', docContent), diff)
    expect(result.breakdown.fileOverlap).toBe(0)
  })

  it('counts each file at most once regardless of how often it appears', () => {
    const diff = `diff --git a/src/payments.ts b/src/payments.ts
@@ -1 +1 @@
-old
+new
`
    const docContent = `src/payments.ts here, and src/payments.ts there, and src/payments.ts everywhere.`
    const result = scoreDocRelevance(sampleDoc('docs/x.md', docContent), diff)
    expect(result.breakdown.fileOverlap).toBe(10)
  })

  it('does not match when diff file path is a prefix of a longer path in the doc', () => {
    const diff = `diff --git a/src/pay.ts b/src/pay.ts
@@ -1 +1 @@
-old
+new
`
    // Doc mentions only the SOURCEMAP path, not the actual src/pay.ts file
    const docContent = `Build artifact is at src/pay.ts.map only.`
    const result = scoreDocRelevance(sampleDoc('docs/x.md', docContent), diff)
    expect(result.breakdown.fileOverlap).toBe(0)
  })
})

describe('scoreDocRelevance — Tier 3 (identifier overlap)', () => {
  it('scores +3 per unique identifier from diff that appears in doc body', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
@@ -1 +1 @@
-processPayment(order)
+chargeCard(order)
`
    const docContent = `processPayment is documented here. chargeCard is documented too. order is an argument.`
    const result = scoreDocRelevance(sampleDoc('docs/x.md', docContent), diff)
    // identifiers overlapping: processPayment, chargeCard, order = 3 × +3 = 9
    expect(result.breakdown.identifierOverlap).toBe(9)
  })

  it('caps identifier overlap at +30', () => {
    // 15 identifiers in diff, all in doc → naive 45, cap 30
    const tokens = Array.from({ length: 15 }, (_, i) => `ident${i}`)
    const diff = `diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-${tokens.join(' ')}\n+${tokens.join(' ')}\n`
    const docContent = tokens.join(' ')
    const result = scoreDocRelevance(sampleDoc('docs/x.md', docContent), diff)
    expect(result.breakdown.identifierOverlap).toBe(30)
  })

  it('ignores short tokens (<3 chars) and common keywords', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-if (x) return\n+if (y) return\n`
    const docContent = `if return x y` // all short or keywords — should not count
    const result = scoreDocRelevance(sampleDoc('docs/x.md', docContent), diff)
    expect(result.breakdown.identifierOverlap).toBe(0)
  })
})

describe('scoreDocRelevance — Tier 4 (heading overlap)', () => {
  it('scores +5 per heading whose tokens overlap with diff identifiers', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-paymentService\n+paymentService\n`
    const docContent = [
      '# Architecture',
      '## paymentService',
      '### Other section',
      '',
      'Body.',
    ].join('\n')
    const result = scoreDocRelevance(sampleDoc('docs/x.md', docContent), diff)
    expect(result.breakdown.headingOverlap).toBe(5)
  })

  it('scores 0 when no headings overlap with diff identifiers', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-foo\n+bar\n`
    const docContent = `# Deployment\n## Logging\n`
    const result = scoreDocRelevance(sampleDoc('docs/x.md', docContent), diff)
    expect(result.breakdown.headingOverlap).toBe(0)
  })
})

describe('selectRelevantDocs', () => {
  it('keeps all docs when threshold is 0', () => {
    const diff = ''
    const docs = [sampleDoc('a.md'), sampleDoc('b.md'), sampleDoc('c.md')]
    const result = selectRelevantDocs(docs, diff, 0)
    expect(result.kept).toHaveLength(3)
    expect(result.dropped).toHaveLength(0)
  })

  it('drops docs scoring below the threshold and keeps docs at/above', () => {
    const diff = `diff --git a/src/payments.ts b/src/payments.ts\n@@ -1 +1 @@\n-old\n+new\n`
    const docs = [
      sampleDoc('relevant.md', 'src/payments.ts is documented here'), // +10 fileOverlap
      sampleDoc('irrelevant.md', '# Unrelated\n\nNothing matches.'), // 0
    ]
    const result = selectRelevantDocs(docs, diff, 5)
    expect(result.kept.map((d) => d.path)).toEqual(['relevant.md'])
    expect(result.dropped.map((d) => d.path)).toEqual(['irrelevant.md'])
    expect(result.dropped[0].score).toBe(0)
  })

  it('preserves input order of kept docs', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+a\n`
    const docs = [
      sampleDoc('z.md', 'src/x.ts'), // +10
      sampleDoc('y.md', 'src/x.ts'), // +10
      sampleDoc('x.md', 'src/x.ts'), // +10
    ]
    const result = selectRelevantDocs(docs, diff, 5)
    expect(result.kept.map((d) => d.path)).toEqual(['z.md', 'y.md', 'x.md'])
  })

  it('treats NaN threshold as keep-all (defensive — caller misuse should not silently drop docs)', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+a\n`
    const docs = [
      sampleDoc('a.md', 'Nothing relevant.'),
      sampleDoc('b.md', 'Also nothing.'),
    ]
    const result = selectRelevantDocs(docs, diff, Number.NaN)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })
})

describe('splitIntoSections', () => {
  it('round-trips a multi-section doc byte-for-byte', () => {
    const content = '# Intro\nintro body\n## Payments\npayment body\n## Logging\nlogging body'
    const sections = splitIntoSections(content)
    expect(sections.flatMap((s) => s.lines).join('\n')).toBe(content)
  })

  it('round-trips with a trailing newline (no line-ending drift)', () => {
    const content = '# A\nbody\n'
    const sections = splitIntoSections(content)
    expect(sections.flatMap((s) => s.lines).join('\n')).toBe(content)
  })

  it('round-trips CRLF content exactly (split on \\n keeps the \\r)', () => {
    const content = '# A\r\nbody\r\n## B\r\nmore'
    const sections = splitIntoSections(content)
    expect(sections.flatMap((s) => s.lines).join('\n')).toBe(content)
  })

  it('opens a new section at each ATX heading and records its startLineIndex', () => {
    const content = '# Intro\nintro body\n## Payments\npayment body\n## Logging\nlogging body'
    const sections = splitIntoSections(content)
    expect(sections.map((s) => s.startLineIndex)).toEqual([0, 2, 4])
    expect(sections[1].lines).toEqual(['## Payments', 'payment body'])
  })

  it('keeps pre-first-heading content as a leading section, never dropped', () => {
    const content = 'preamble line\nmore preamble\n# First Heading\nbody'
    const sections = splitIntoSections(content)
    expect(sections[0].startLineIndex).toBe(0)
    expect(sections[0].lines).toEqual(['preamble line', 'more preamble'])
    expect(sections[1].lines[0]).toBe('# First Heading')
  })

  it('treats an all-body (no heading) doc as one leading section', () => {
    const sections = splitIntoSections('src/x.ts is here')
    expect(sections).toHaveLength(1)
    expect(sections[0]).toEqual({ lines: ['src/x.ts is here'], startLineIndex: 0 })
  })

  it('treats empty content as one empty section (never zero sections)', () => {
    const sections = splitIntoSections('')
    expect(sections).toEqual([{ lines: [''], startLineIndex: 0 }])
  })

  it('handles consecutive headings at different levels', () => {
    const content = '# A\n## B\n### C\nbody'
    const sections = splitIntoSections(content)
    expect(sections.map((s) => s.startLineIndex)).toEqual([0, 1, 2])
    expect(sections[2].lines).toEqual(['### C', 'body'])
  })
})

describe('selectRelevantSections', () => {
  const multiSectionDoc = (path = 'docs/architecture.md'): import('../src/types').DocFile => ({
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

  // Diff touches src/payments.ts — only the Payments section overlaps.
  const paymentsDiff = `diff --git a/src/payments.ts b/src/payments.ts\n@@ -1 +1 @@\n-old\n+chargeCard(order)\n`

  it('keeps every section on the threshold <= 0 fast-path (no-op)', () => {
    const result = selectRelevantSections(multiSectionDoc(), paymentsDiff, 0)
    expect(result.kept).toHaveLength(3)
    expect(result.dropped).toHaveLength(0)
  })

  it('keeps every section on a non-finite threshold (defensive keep-all)', () => {
    const result = selectRelevantSections(multiSectionDoc(), paymentsDiff, Number.NaN)
    expect(result.kept).toHaveLength(3)
    expect(result.dropped).toHaveLength(0)
  })

  it('keeps only the relevant section and drops the irrelevant siblings', () => {
    const result = selectRelevantSections(multiSectionDoc(), paymentsDiff, 10)
    expect(result.kept.map((s) => s.startLineIndex)).toEqual([2])
    expect(result.kept[0].lines[0]).toBe('## Payments')
    expect(result.dropped.map((s) => s.startLineIndex)).toEqual([0, 4])
    expect(result.dropped.every((s) => s.score < 10)).toBe(true)
  })

  it('uses inclusive-threshold semantics (score === threshold is kept)', () => {
    // Payments section score = fileOverlap(10) + identifierOverlap(9) = 19.
    const result = selectRelevantSections(multiSectionDoc(), paymentsDiff, 19)
    expect(result.kept.map((s) => s.startLineIndex)).toEqual([2])
  })

  it('retains EVERY section when the doc path itself is in the diff (docPathInDiff is whole-doc)', () => {
    // No section overlaps the diff content, but the doc path appears in a diff
    // header → docPathInDiff(20) applies to every section → all kept whole.
    const doc = multiSectionDoc('docs/guide.md')
    const diff = `diff --git a/docs/guide.md b/docs/guide.md\n@@ -1 +1 @@\n-x\n+y\n`
    const result = selectRelevantSections(doc, diff, 10)
    expect(result.kept).toHaveLength(3)
    expect(result.dropped).toHaveLength(0)
  })
})

// --- Ranked-fill (Story P3.7.3 / FR152) -------------------------------------

describe('rankedFillSections', () => {
  // Helper: build a candidate from a path, score, body, and startLineIndex.
  // The `doc.content` field is unused by `rankedFillSections` itself (the
  // ranking key is the score + docPath + startLineIndex), so we pick a
  // minimal fake doc and let the measure() closure simulate the cost.
  const candidate = (
    docPath: string,
    score: number,
    startLineIndex = 0,
    sectionLines: string[] = ['# H'],
  ): RankedFillCandidate => {
    const doc: DocFile = {
      path: docPath,
      content: sectionLines.join('\n'),
      frontMatterLineCount: 0,
    }
    return { doc, section: { lines: sectionLines, startLineIndex }, score }
  }

  // Default measure for shape tests — each candidate costs 10 tokens.
  const fixedCost = (): number => 10

  it('returns every candidate in `included` when the budget is generous', () => {
    const candidates = [
      candidate('a.md', 30),
      candidate('b.md', 20),
      candidate('c.md', 10),
    ]
    const result = rankedFillSections(candidates, 100, fixedCost)
    expect(result.included.map((c) => c.doc.path)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(result.dropped).toHaveLength(0)
  })

  it('ranks descending by score: a high-score candidate from a late doc preempts an early low-score one', () => {
    // Budget 10 — exactly one candidate fits.
    const candidates = [
      candidate('a.md', 5), // low score, listed first
      candidate('b.md', 50), // high score, listed second
    ]
    const result = rankedFillSections(candidates, 10, fixedCost)
    expect(result.included.map((c) => c.doc.path)).toEqual(['b.md'])
    expect(result.dropped.map((c) => c.doc.path)).toEqual(['a.md'])
  })

  it('tie-breaks deterministically: equal scores sort by docPath ASC then startLineIndex ASC', () => {
    // Budget 20 — exactly two candidates fit. All four have the same score.
    const candidates = [
      candidate('c.md', 10, 0),
      candidate('a.md', 10, 5),
      candidate('a.md', 10, 0),
      candidate('b.md', 10, 0),
    ]
    const result = rankedFillSections(candidates, 20, fixedCost)
    // Ranking: a.md@0, a.md@5, b.md@0, c.md@0 → first two ('a.md' entries) included.
    expect(result.included.map((c) => `${c.doc.path}:${c.section.startLineIndex}`)).toEqual([
      'a.md:5',
      'a.md:0',
    ])
    // Dropped preserves original input order.
    expect(result.dropped.map((c) => c.doc.path)).toEqual(['c.md', 'b.md'])
  })

  it('preserves `dropped` in original input order, not ranked order', () => {
    const candidates = [
      candidate('first.md', 1),
      candidate('second.md', 100), // wins the only slot
      candidate('third.md', 2),
    ]
    const result = rankedFillSections(candidates, 10, fixedCost)
    expect(result.included.map((c) => c.doc.path)).toEqual(['second.md'])
    expect(result.dropped.map((c) => c.doc.path)).toEqual(['first.md', 'third.md'])
  })

  it('does NOT mutate the input array', () => {
    const candidates = [
      candidate('a.md', 1),
      candidate('b.md', 5),
      candidate('c.md', 3),
    ]
    const snapshot = candidates.map((c) => `${c.doc.path}:${c.score}`)
    rankedFillSections(candidates, 100, fixedCost)
    expect(candidates.map((c) => `${c.doc.path}:${c.score}`)).toEqual(snapshot)
  })

  it('continues past a candidate that overflows budget — smaller later candidates can still fit', () => {
    // Budget 10. Ranked order by score DESC: a.md (cost 100), b.md (cost 5), c.md (cost 5).
    // a.md overflows; b.md fits; c.md fits → both later candidates land in `included`.
    const sizes: Record<string, number> = { 'a.md': 100, 'b.md': 5, 'c.md': 5 }
    const candidates = [
      candidate('a.md', 50),
      candidate('b.md', 30),
      candidate('c.md', 10),
    ]
    const result = rankedFillSections(candidates, 10, (cand) => sizes[cand.doc.path])
    expect(result.included.map((c) => c.doc.path)).toEqual(['b.md', 'c.md'])
    expect(result.dropped.map((c) => c.doc.path)).toEqual(['a.md'])
  })

  it('non-positive / non-finite budget → include everything (no-op fast-path)', () => {
    const candidates = [candidate('a.md', 1), candidate('b.md', 2)]
    for (const budget of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      const result = rankedFillSections(candidates, budget, () => 1000)
      expect(result.included).toHaveLength(2)
      expect(result.dropped).toHaveLength(0)
    }
  })

  it('boundary: cumulative cost EQUAL to budget is included (inclusive upper bound)', () => {
    // Budget 10, one candidate costs exactly 10.
    const candidates = [candidate('a.md', 100)]
    const result = rankedFillSections(candidates, 10, () => 10)
    expect(result.included).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it('determinism: identical inputs yield identical outputs across repeated invocations', () => {
    const candidates = [
      candidate('a.md', 5),
      candidate('b.md', 5),
      candidate('c.md', 10),
      candidate('d.md', 7),
    ]
    const runs = Array.from({ length: 5 }, () =>
      rankedFillSections(candidates, 30, fixedCost).included.map((c) => c.doc.path),
    )
    expect(new Set(runs.map((r) => r.join(',')))).toEqual(new Set([runs[0].join(',')]))
  })

  it('empty candidate list → empty result', () => {
    const result = rankedFillSections([], 100, fixedCost)
    expect(result.included).toEqual([])
    expect(result.dropped).toEqual([])
  })
})
