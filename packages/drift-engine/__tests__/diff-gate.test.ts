import { describe, it, expect } from 'vitest'
import { gateDiffByRelevance } from '../src/diff-gate'
import { parseDiffHunks } from '../src/diff-hunks'
import type { DocFile } from '../src/types'

// Canonical thresholds (mirror the CLI's DEFAULT_RELEVANCE_THRESHOLD and the
// gate's consumer defaults): section universe at 5, per-hunk keep bar at 5,
// strong tier at 5×4=20.
const OPTIONS = { sectionThreshold: 5, keepThreshold: 5 }

const doc: DocFile = {
  path: 'docs/arch.md',
  content: [
    '# Architecture',
    'Overview text.',
    '## Payments',
    'The `processPayment` flow in src/payments/processor.ts batches transactions.',
    '## Sessions',
    'Session tokens expire after sessionTtlSeconds.',
  ].join('\n'),
  frontMatterLineCount: 0,
}

// STRONG link to "## Payments": exact file-path overlap (+10) + several
// identifier overlaps (processPayment, payments, processor, batch, src) → ≥20.
const strongHunk = [
  'diff --git a/src/payments/processor.ts b/src/payments/processor.ts',
  'index 111..222 100644',
  '--- a/src/payments/processor.ts',
  '+++ b/src/payments/processor.ts',
  '@@ -4,3 +4,3 @@',
  ' const client = makeClient()',
  '-await processPayment.batch(txs)',
  '+await processPayment.single(txs)',
  ' return ok',
  '',
].join('\n')

// WEAK link to "## Sessions": identifier overlap only (sessionTtlSeconds +
// the generic `session` path token) → ~6, inside [5, 20). Padded with three
// context lines on each side so the trim has something to cut.
const weakHunk = [
  'diff --git a/src/auth/session.ts b/src/auth/session.ts',
  'index 333..444 100644',
  '--- a/src/auth/session.ts',
  '+++ b/src/auth/session.ts',
  '@@ -10,7 +10,7 @@ function ctx()',
  ' c1',
  ' c2',
  ' c3',
  '-const sessionTtlSeconds = 3600',
  '+const sessionTtlSeconds = 7200',
  ' c4',
  ' c5',
  ' c6',
  '',
].join('\n')

// UNLINKED: shares no meaningful lexical signal with any section (max ~3 via
// the generic `src` path token) → below the keep bar, dropped.
const unlinkedHunk = [
  'diff --git a/src/util/logger.ts b/src/util/logger.ts',
  'index 555..666 100644',
  '--- a/src/util/logger.ts',
  '+++ b/src/util/logger.ts',
  '@@ -1,2 +1,2 @@',
  '-formatLog(entry)',
  '+formatLogLine(entry)',
  ' emit()',
  '',
].join('\n')

describe('gateDiffByRelevance — keep/drop/trim decisions', () => {
  const diff = strongHunk + weakHunk + unlinkedHunk

  it('keeps strong hunks verbatim, trims weak hunks, drops unlinked hunks', () => {
    const result = gateDiffByRelevance(diff, [doc], OPTIONS)

    expect(result.active).toBe(true)
    expect(result.keptByReason['linked-strong']).toBe(1)
    expect(result.keptByReason['linked-weak']).toBe(1)
    expect(result.droppedHunks).toHaveLength(1)
    expect(result.droppedHunks[0]).toMatchObject({
      filePath: 'src/util/logger.ts',
      hunkHeader: '@@ -1,2 +1,2 @@',
    })
    expect(result.droppedHunks[0].maxScore).toBeLessThan(OPTIONS.keepThreshold)

    // Strong hunk: untouched, full context.
    expect(result.keptDiff).toContain('@@ -4,3 +4,3 @@')
    expect(result.keptDiff).toContain(' const client = makeClient()')

    // Weak hunk: lead/trail context trimmed to radius 1 with a recomputed
    // header — start advances by the 2 trimmed leading lines, both counts
    // shrink by the 4 trimmed lines, post-@@ context text preserved.
    expect(result.keptDiff).toContain('@@ -12,3 +12,3 @@ function ctx()')
    expect(result.keptDiff).toContain(' c3')
    expect(result.keptDiff).toContain(' c4')
    expect(result.keptDiff).not.toContain(' c1')
    expect(result.keptDiff).not.toContain(' c6')
    expect(result.keptDiff).toContain('-const sessionTtlSeconds = 3600')
    expect(result.trimmedHunkCount).toBe(1)
    expect(result.contextLinesRemoved).toBe(4)

    // Dropped file: absent entirely — header and body.
    expect(result.keptDiff).not.toContain('src/util/logger.ts')
  })

  it('emits a keptDiff that round-trips through parseDiffHunks', () => {
    const result = gateDiffByRelevance(diff, [doc], OPTIONS)
    const reparsed = parseDiffHunks(result.keptDiff)
    expect(reparsed).toHaveLength(2)
    expect(reparsed.map((h) => h.filePath)).toEqual([
      'src/payments/processor.ts',
      'src/auth/session.ts',
    ])
    // The rewritten weak-hunk header parses as the hunk's header line.
    expect(reparsed[1].header).toBe('@@ -12,3 +12,3 @@ function ctx()\n')
  })

  it('is deterministic — identical input, identical output', () => {
    const a = gateDiffByRelevance(diff, [doc], OPTIONS)
    const b = gateDiffByRelevance(diff, [doc], OPTIONS)
    expect(b).toEqual(a)
  })

  it('strongMultiplier 1 promotes weak hunks to strong (no trim)', () => {
    const result = gateDiffByRelevance(diff, [doc], { ...OPTIONS, strongMultiplier: 1 })
    expect(result.keptByReason['linked-strong']).toBe(2)
    expect(result.keptByReason['linked-weak']).toBe(0)
    expect(result.trimmedHunkCount).toBe(0)
    expect(result.keptDiff).toContain(' c1')
  })

  it('contextRadius 0 trims every leading/trailing context line', () => {
    const result = gateDiffByRelevance(diff, [doc], { ...OPTIONS, contextRadius: 0 })
    expect(result.keptDiff).toContain('@@ -13,1 +13,1 @@ function ctx()')
    expect(result.keptDiff).not.toContain(' c3')
    expect(result.keptDiff).not.toContain(' c4')
    expect(result.contextLinesRemoved).toBe(6)
  })
})

describe('gateDiffByRelevance — structural keep-list', () => {
  it('keeps in-scope doc edits unconditionally (doc-in-scope)', () => {
    const docEditHunk = [
      'diff --git a/docs/arch.md b/docs/arch.md',
      'index 777..888 100644',
      '--- a/docs/arch.md',
      '+++ b/docs/arch.md',
      '@@ -6,1 +6,1 @@',
      '-Session tokens expire after sessionTtlSeconds.',
      '+Session tokens never expire.',
      '',
    ].join('\n')
    const result = gateDiffByRelevance(docEditHunk + unlinkedHunk, [doc], OPTIONS)
    expect(result.active).toBe(true)
    expect(result.keptByReason['doc-in-scope']).toBe(1)
    expect(result.keptDiff).toContain('docs/arch.md')
  })

  it('keeps brand-new files (new file mode) even when lexically unlinked', () => {
    const newFileHunk = [
      'diff --git a/src/notifications/email.ts b/src/notifications/email.ts',
      'new file mode 100644',
      'index 000..999',
      '--- /dev/null',
      '+++ b/src/notifications/email.ts',
      '@@ -0,0 +1,2 @@',
      '+export function sendWelcomeEmail(userId: string) {',
      '+}',
      '',
    ].join('\n')
    // strongHunk keeps the gate from standing down all-dropped.
    const result = gateDiffByRelevance(newFileHunk + strongHunk, [doc], OPTIONS)
    expect(result.keptByReason['new-file']).toBe(1)
    expect(result.keptDiff).toContain('src/notifications/email.ts')
  })

  it('keeps dependency manifests even when lexically unlinked', () => {
    const manifestHunk = [
      'diff --git a/package.json b/package.json',
      'index aaa..bbb 100644',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -8,2 +8,3 @@',
      '   "zod": "^3.0.0",',
      '+  "@sentry/node": "^7.0.0",',
      '   "picomatch": "^4.0.0"',
      '',
    ].join('\n')
    const result = gateDiffByRelevance(manifestHunk + strongHunk, [doc], OPTIONS)
    expect(result.keptByReason['dependency-manifest']).toBe(1)
    expect(result.keptDiff).toContain('package.json')
    // Structural keeps retain full context — no trim.
    expect(result.keptDiff).toContain('   "zod": "^3.0.0",')
  })
})

describe('gateDiffByRelevance — stand-down (inactive) paths', () => {
  it('keepThreshold 0 → inactive no-threshold, diff verbatim (the escape hatch)', () => {
    const result = gateDiffByRelevance(strongHunk, [doc], {
      sectionThreshold: 5,
      keepThreshold: 0,
    })
    expect(result.active).toBe(false)
    expect(result.inactiveReason).toBe('no-threshold')
    expect(result.keptDiff).toBe(strongHunk)
  })

  it('sectionThreshold 0 → inactive no-threshold (no routing signal)', () => {
    const result = gateDiffByRelevance(strongHunk, [doc], {
      sectionThreshold: 0,
      keepThreshold: 5,
    })
    expect(result.active).toBe(false)
    expect(result.inactiveReason).toBe('no-threshold')
  })

  it('empty docs → inactive no-docs', () => {
    const result = gateDiffByRelevance(strongHunk, [], OPTIONS)
    expect(result.active).toBe(false)
    expect(result.inactiveReason).toBe('no-docs')
    expect(result.keptDiff).toBe(strongHunk)
  })

  it('no parsed hunks (rename-only header) → inactive no-hunks', () => {
    const renameOnly = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '',
    ].join('\n')
    const result = gateDiffByRelevance(renameOnly, [doc], OPTIONS)
    expect(result.active).toBe(false)
    expect(result.inactiveReason).toBe('no-hunks')
    expect(result.keptDiff).toBe(renameOnly)
  })

  it('no retained section → inactive no-sections', () => {
    const irrelevantDoc: DocFile = {
      path: 'docs/unrelated.md',
      content: '# Unrelated\nNothing about the change.',
      frontMatterLineCount: 0,
    }
    const result = gateDiffByRelevance(unlinkedHunk, [irrelevantDoc], OPTIONS)
    expect(result.active).toBe(false)
    expect(result.inactiveReason).toBe('no-sections')
    expect(result.keptDiff).toBe(unlinkedHunk)
  })

  it('all hunks below the bar → stands down all-dropped, never an empty diff', () => {
    // For a single-hunk diff, a section's retention score and the hunk's keep
    // score are computed from identical inputs — so at equal thresholds
    // "retained section but dropped hunk" is unreachable. The precision knob
    // (keepThreshold ABOVE sectionThreshold) is exactly where all-dropped
    // becomes real: the Sessions section is retained at ~6 ≥ 5, but the weak
    // hunk's 6 falls short of the 10 keep bar.
    const result = gateDiffByRelevance(weakHunk, [doc], {
      sectionThreshold: 5,
      keepThreshold: 10,
    })
    expect(result.active).toBe(false)
    expect(result.inactiveReason).toBe('all-dropped')
    expect(result.keptDiff).toBe(weakHunk)
    // The decision it declined to apply is still reported.
    expect(result.droppedHunks).toHaveLength(1)
    expect(result.droppedHunks[0].filePath).toBe('src/auth/session.ts')
  })
})

describe('gateDiffByRelevance — trim edge cases', () => {
  it('a trailing "\\ No newline" marker pins the tail (leading trim still applies)', () => {
    // Weak-linked via sessionTtlSeconds; three leading context lines are
    // trimmable, but the tail is pinned by the marker on the final context line.
    const pinnedHunk = [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      'index 333..444 100644',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -10,5 +10,5 @@',
      ' c1',
      ' c2',
      ' c3',
      '-const sessionTtlSeconds = 3600',
      '+const sessionTtlSeconds = 7200',
      ' c4',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const result = gateDiffByRelevance(pinnedHunk + strongHunk, [doc], OPTIONS)
    expect(result.active).toBe(true)
    // Leading trim: c1/c2 dropped, header start advances by 2, counts -2.
    expect(result.keptDiff).toContain('@@ -12,3 +12,3 @@')
    expect(result.keptDiff).not.toContain(' c1')
    // Tail pinned: c4 + marker survive.
    expect(result.keptDiff).toContain(' c4')
    expect(result.keptDiff).toContain('\\ No newline at end of file')
    expect(result.contextLinesRemoved).toBe(2)
  })

  it('weak hunk already at radius → kept unmodified, not counted as trimmed', () => {
    const tightHunk = [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      'index 333..444 100644',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -10,3 +10,3 @@',
      ' c1',
      '-const sessionTtlSeconds = 3600',
      '+const sessionTtlSeconds = 7200',
      ' c2',
      '',
    ].join('\n')
    const result = gateDiffByRelevance(tightHunk + strongHunk, [doc], OPTIONS)
    expect(result.trimmedHunkCount).toBe(0)
    expect(result.contextLinesRemoved).toBe(0)
    expect(result.keptDiff).toContain('@@ -10,3 +10,3 @@')
  })
})
