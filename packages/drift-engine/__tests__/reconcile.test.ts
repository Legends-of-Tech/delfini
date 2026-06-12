import { describe, expect, it, vi } from 'vitest'
import {
  dedupeOverlappingContradictions,
  filterActionableContradictions,
  locateAnchorHeading,
  locateQuote,
  reconcileAdditiveAnchors,
  reconcileLineNumbers,
} from '../src/reconcile.js'
import type { Addition, Contradiction, DocFile } from '../src/types.js'

function contradiction(overrides: Partial<Contradiction> = {}): Contradiction {
  return {
    targetDocPath: 'docs/arch.md',
    targetSection: 'Conventions',
    targetLineStart: 99,
    targetLineEnd: 99,
    whatChanged: 'PR replaces named exports with default.',
    whatContradicts: 'Section says only named exports allowed.',
    proposedReplacement: 'Default exports allowed in module Y only.',
    severity: 'Medium',
    confidence: 4,
    quotedDocText: 'Named exports only.',
    ...overrides,
  }
}

function doc(content: string, frontMatterLineCount = 0): DocFile {
  return { path: 'docs/arch.md', content, frontMatterLineCount }
}

describe('locateQuote', () => {
  it('locates a single-line quote at the start of the body', () => {
    const result = locateQuote('Named exports only.', 'Named exports only.\nNext line.', 0)
    expect(result).toEqual({ start: 1, end: 1 })
  })

  it('locates a single-line quote on a non-first line', () => {
    const result = locateQuote('Body.', '# Heading\n\nBody.\nOther line.', 0)
    expect(result).toEqual({ start: 3, end: 3 })
  })

  it('locates a multi-line quote spanning N lines', () => {
    const result = locateQuote(
      'first\nsecond\nthird',
      '# Heading\nfirst\nsecond\nthird\nrest',
      0,
    )
    expect(result).toEqual({ start: 2, end: 4 })
  })

  it('returns null when the quote is not found', () => {
    expect(locateQuote('not in doc', '# A\n\nB.', 0)).toBeNull()
  })

  it('returns null for an empty quote', () => {
    expect(locateQuote('', '# Body', 0)).toBeNull()
  })

  it('offsets the line range by frontMatterLineCount (absolute coordinates)', () => {
    // 3-line front-matter (--- + 1 yaml + ---) = 3; "Body." is body line 3,
    // absolute line 3 + 3 = 6.
    const result = locateQuote('Body.', '# A\n\nBody.', 3)
    expect(result).toEqual({ start: 6, end: 6 })
  })

  it('grounds CRLF body content against an LF-normalised quote', () => {
    const result = locateQuote('Named exports only.', '# A\r\n\r\nNamed exports only.\r\n', 0)
    expect(result).toEqual({ start: 3, end: 3 })
  })

  it('first-match-wins on a duplicate quote', () => {
    const body = 'X.\nNamed exports only.\nY.\nNamed exports only.\nZ.'
    const result = locateQuote('Named exports only.', body, 0)
    expect(result).toEqual({ start: 2, end: 2 })
  })

  it('tolerates per-line trailing-whitespace difference between quote and body', () => {
    // Body has trailing spaces; the quote does not.
    const result = locateQuote('Named exports only.', '# A\n\nNamed exports only.   \n', 0)
    expect(result).toEqual({ start: 3, end: 3 })
  })
})

// Story 4.25 — additive anchor grounding.
describe('locateAnchorHeading', () => {
  it('locates a level-2 markdown heading by visible text', () => {
    expect(
      locateAnchorHeading(
        'Technology Stack & Versions',
        '# Top\n\n## Technology Stack & Versions\n\nbody',
        0,
      ),
    ).toBe(3)
  })

  it('locates a heading at any depth (#, ###, ####)', () => {
    expect(
      locateAnchorHeading('Section', '#### Section\n\nbody', 0),
    ).toBe(1)
  })

  it('returns null when the heading text is absent', () => {
    expect(
      locateAnchorHeading('Nowhere', '## Somewhere\n## Else', 0),
    ).toBeNull()
  })

  it('offsets by frontMatterLineCount', () => {
    expect(
      locateAnchorHeading('Foo', '## Foo\nbody', 3),
    ).toBe(4)
  })

  it('returns null for an empty anchor', () => {
    expect(locateAnchorHeading('', '# A\n## B', 0)).toBeNull()
  })

  // Code-review regression (2026-05-15): without the heading-prefix guard,
  // `replace` returned the unchanged line on a non-heading match and the
  // function silently anchored to prose whose text equalled the section name
  // (e.g. a TOC list rendering the bare section name on its own line).
  it('does not match a non-heading line whose text equals the anchor', () => {
    expect(
      locateAnchorHeading(
        'Technology Stack & Versions',
        '# Top\n\nTechnology Stack & Versions\n\n## Technology Stack & Versions\n\nbody',
        0,
      ),
    ).toBe(5)
  })

  it('returns null when only a prose line matches and no heading exists', () => {
    expect(
      locateAnchorHeading(
        'Technology Stack & Versions',
        '# Top\n\nTechnology Stack & Versions\n\nbody',
        0,
      ),
    ).toBeNull()
  })
})

describe('reconcileAdditiveAnchors', () => {
  const additive = (overrides: Partial<Addition> = {}): Addition => ({
    targetDocPath: 'docs/arch.md',
    anchorSection: 'Section A',
    anchorLine: 1, // overwritten by the reconciler
    insertionMode: 'after',
    proposedContent: 'New content.',
    severity: 'Medium',
    confidence: 4,
    whatChanged: 'X',
    rationaleForAddition: 'Y',
    ...overrides,
  })

  it('overwrites anchorLine when the heading is located', () => {
    const docs = [doc('# Title\n\n## Section A\n\nbody')]
    const out = reconcileAdditiveAnchors([additive()], docs)
    expect(out).toHaveLength(1)
    expect(out[0]!.anchorLine).toBe(3)
  })

  it('drops an additive finding whose heading is missing, with a warning', () => {
    const onWarn = vi.fn()
    const docs = [doc('# Title\n\n## Some Other Section')]
    const out = reconcileAdditiveAnchors(
      [additive({ anchorSection: 'Nowhere' })],
      docs,
      onWarn,
    )
    expect(out).toEqual([])
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining('anchor section heading not found'),
    )
  })

  it('drops an additive finding for an unknown doc path, with a warning', () => {
    const onWarn = vi.fn()
    const docs = [doc('## Section A')]
    const out = reconcileAdditiveAnchors(
      [additive({ targetDocPath: 'docs/missing.md' })],
      docs,
      onWarn,
    )
    expect(out).toEqual([])
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining('unknown doc path'),
    )
  })
})

describe('reconcileLineNumbers', () => {
  it('overwrites targetLineStart / targetLineEnd when the quote is located', () => {
    const c = contradiction({
      targetLineStart: 99,
      targetLineEnd: 99,
      quotedDocText: 'Named exports only.',
    })
    const docs = [doc('# Heading\n\nNamed exports only.\nrest')]

    const out = reconcileLineNumbers([c], docs)

    expect(out).toHaveLength(1)
    expect(out[0]!.targetLineStart).toBe(3)
    expect(out[0]!.targetLineEnd).toBe(3)
  })

  it('drops a finding whose quote is not in any doc, with a warning', () => {
    const onWarn = vi.fn()
    const c = contradiction({ quotedDocText: 'fabricated text' })
    const docs = [doc('# Heading\n\nReal content.')]

    const out = reconcileLineNumbers([c], docs, onWarn)

    expect(out).toEqual([])
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('quotedDocText not found'))
  })

  it('drops a finding pointing at a doc not in the analysed set, with a warning', () => {
    const onWarn = vi.fn()
    const c = contradiction({
      targetDocPath: 'docs/missing.md',
      quotedDocText: 'anything',
    })
    const docs = [doc('# A')]

    const out = reconcileLineNumbers([c], docs, onWarn)

    expect(out).toEqual([])
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unknown doc path'))
  })

  it('first-match-wins on a quote that occurs more than once', () => {
    const c = contradiction({ quotedDocText: 'repeat' })
    const docs = [doc('repeat\nrepeat\nrepeat')]

    const out = reconcileLineNumbers([c], docs)

    expect(out).toHaveLength(1)
    expect(out[0]!.targetLineStart).toBe(1)
    expect(out[0]!.targetLineEnd).toBe(1)
  })

  it('reconciled line numbers are absolute (offset by frontMatterLineCount)', () => {
    const c = contradiction({ quotedDocText: 'Body.' })
    // Doc body has front-matter offset 5; "Body." is body line 1 → absolute line 6.
    const docs = [doc('Body.', 5)]

    const out = reconcileLineNumbers([c], docs)

    expect(out[0]!.targetLineStart).toBe(6)
    expect(out[0]!.targetLineEnd).toBe(6)
  })

  it('passes through non-line fields unchanged on the kept findings', () => {
    const c = contradiction({
      targetSection: 'preserved-section',
      whatChanged: 'preserved-changed',
      whatContradicts: 'preserved-contradicts',
      proposedReplacement: 'preserved-replacement',
      severity: 'High',
      confidence: 5,
      quotedDocText: 'Body.',
    })
    const docs = [doc('Body.')]

    const out = reconcileLineNumbers([c], docs)

    expect(out[0]).toMatchObject({
      targetSection: 'preserved-section',
      whatChanged: 'preserved-changed',
      whatContradicts: 'preserved-contradicts',
      proposedReplacement: 'preserved-replacement',
      severity: 'High',
      confidence: 5,
      quotedDocText: 'Body.',
    })
  })

  it('partitions a mixed batch — keeps grounded, drops ungrounded', () => {
    const onWarn = vi.fn()
    const grounded = contradiction({
      targetSection: 'a',
      quotedDocText: 'real text',
    })
    const ungrounded = contradiction({
      targetSection: 'b',
      quotedDocText: 'never appears',
    })
    const docs = [doc('# Doc\n\nreal text\nelse')]

    const out = reconcileLineNumbers([grounded, ungrounded], docs, onWarn)

    expect(out).toHaveLength(1)
    expect(out[0]!.targetSection).toBe('a')
    expect(onWarn).toHaveBeenCalledTimes(1)
  })

  it('returns [] without warnings on empty input', () => {
    const onWarn = vi.fn()
    expect(reconcileLineNumbers([], [], onWarn)).toEqual([])
    expect(onWarn).not.toHaveBeenCalled()
  })
})

describe('filterActionableContradictions', () => {
  it('keeps a finding with a real, distinct proposedReplacement', () => {
    const c = contradiction({
      proposedReplacement: 'New text.',
      quotedDocText: 'Old text.',
    })
    const out = filterActionableContradictions([c])
    expect(out.kept).toEqual([c])
    expect(out.narrativeOnly).toEqual([])
  })

  it('routes a finding with null proposedReplacement to narrativeOnly (no warning)', () => {
    const onWarn = vi.fn()
    const c = contradiction({ proposedReplacement: null })
    const out = filterActionableContradictions([c], onWarn)
    expect(out.kept).toEqual([])
    expect(out.narrativeOnly).toEqual([c])
    // narrative-only is surfaced via the return shape, NOT via onWarn —
    // the warning channel is reserved for true silent drops.
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('routes a finding with an empty-string proposedReplacement to narrativeOnly (no warning)', () => {
    const onWarn = vi.fn()
    const c = contradiction({ proposedReplacement: '' })
    const out = filterActionableContradictions([c], onWarn)
    expect(out.kept).toEqual([])
    expect(out.narrativeOnly).toEqual([c])
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('routes a finding with a whitespace-only proposedReplacement to narrativeOnly (no warning)', () => {
    const onWarn = vi.fn()
    const c = contradiction({ proposedReplacement: '   \n\t  ' })
    const out = filterActionableContradictions([c], onWarn)
    expect(out.kept).toEqual([])
    expect(out.narrativeOnly).toEqual([c])
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('drops (does NOT route to narrativeOnly) a finding whose proposedReplacement is byte-equal to quotedDocText (no-op), with a warning', () => {
    const onWarn = vi.fn()
    const c = contradiction({
      proposedReplacement: '- Drizzle ORM ^0.50.0',
      quotedDocText: '- Drizzle ORM ^0.50.0',
    })
    const out = filterActionableContradictions([c], onWarn)
    expect(out.kept).toEqual([])
    expect(out.narrativeOnly).toEqual([])
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining('byte-equal to quotedDocText'),
    )
  })

  it('drops (does NOT route to narrativeOnly) a finding whose proposedReplacement equals quotedDocText after CRLF/whitespace normalisation', () => {
    const onWarn = vi.fn()
    const c = contradiction({
      proposedReplacement: '- Drizzle ORM ^0.50.0   \r\n',
      quotedDocText: '- Drizzle ORM ^0.50.0\n',
    })
    const out = filterActionableContradictions([c], onWarn)
    expect(out.kept).toEqual([])
    expect(out.narrativeOnly).toEqual([])
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining('byte-equal to quotedDocText'),
    )
  })

  it('partitions a mixed batch — keeps actionable in `kept`, routes empty to `narrativeOnly`, silently drops no-op', () => {
    const onWarn = vi.fn()
    const actionable = contradiction({
      targetSection: 'a',
      proposedReplacement: 'New text.',
      quotedDocText: 'Old text.',
    })
    const empty = contradiction({
      targetSection: 'b',
      proposedReplacement: '',
      quotedDocText: 'Old text.',
    })
    const noop = contradiction({
      targetSection: 'c',
      proposedReplacement: 'Same.',
      quotedDocText: 'Same.',
    })
    const out = filterActionableContradictions([actionable, empty, noop], onWarn)
    expect(out.kept).toHaveLength(1)
    expect(out.kept[0]!.targetSection).toBe('a')
    expect(out.narrativeOnly).toHaveLength(1)
    expect(out.narrativeOnly[0]!.targetSection).toBe('b')
    // Only the no-op drop warns; the empty-replacement case is routed via
    // the return shape, not the warning channel.
    expect(onWarn).toHaveBeenCalledTimes(1)
  })

  it('returns empty `kept` and empty `narrativeOnly` without warnings on empty input', () => {
    const onWarn = vi.fn()
    const out = filterActionableContradictions([], onWarn)
    expect(out.kept).toEqual([])
    expect(out.narrativeOnly).toEqual([])
    expect(onWarn).not.toHaveBeenCalled()
  })
})

describe('dedupeOverlappingContradictions', () => {
  it('keeps non-overlapping findings on the same doc unchanged', () => {
    const a = contradiction({ targetLineStart: 10, targetLineEnd: 12 })
    const b = contradiction({ targetLineStart: 20, targetLineEnd: 22 })
    const out = dedupeOverlappingContradictions([a, b])
    expect(out).toHaveLength(2)
  })

  it('drops a finding whose range overlaps a higher-confidence finding', () => {
    const onWarn = vi.fn()
    const high = contradiction({
      targetLineStart: 35,
      targetLineEnd: 37,
      confidence: 5,
      targetSection: 'high-conf',
    })
    const low = contradiction({
      targetLineStart: 35,
      targetLineEnd: 37,
      confidence: 3,
      targetSection: 'low-conf',
    })
    const out = dedupeOverlappingContradictions([high, low], onWarn)
    expect(out).toHaveLength(1)
    expect(out[0]!.targetSection).toBe('high-conf')
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining('overlapping finding'),
    )
  })

  it('drops a partially-overlapping range (not just identical)', () => {
    const a = contradiction({
      targetLineStart: 30,
      targetLineEnd: 40,
      confidence: 5,
    })
    const b = contradiction({
      targetLineStart: 38,
      targetLineEnd: 45,
      confidence: 3,
    })
    const out = dedupeOverlappingContradictions([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]!.targetLineStart).toBe(30)
  })

  it('treats overlap as PER-DOC (same range on different docs is fine)', () => {
    const a = contradiction({
      targetDocPath: 'docs/a.md',
      targetLineStart: 35,
      targetLineEnd: 37,
    })
    const b = contradiction({
      targetDocPath: 'docs/b.md',
      targetLineStart: 35,
      targetLineEnd: 37,
    })
    const out = dedupeOverlappingContradictions([a, b])
    expect(out).toHaveLength(2)
  })

  it('tie-breaks equal-confidence findings by first-seen', () => {
    const first = contradiction({
      targetLineStart: 35,
      targetLineEnd: 37,
      confidence: 4,
      targetSection: 'first',
    })
    const second = contradiction({
      targetLineStart: 35,
      targetLineEnd: 37,
      confidence: 4,
      targetSection: 'second',
    })
    const out = dedupeOverlappingContradictions([first, second])
    expect(out).toHaveLength(1)
    expect(out[0]!.targetSection).toBe('first')
  })

  it('returns [] without warnings on empty input', () => {
    const onWarn = vi.fn()
    expect(dedupeOverlappingContradictions([], onWarn)).toEqual([])
    expect(onWarn).not.toHaveBeenCalled()
  })
})
