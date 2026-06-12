import { describe, it, expect } from 'vitest'
import { AdditionSchema, AnalysisResultSchema, ContradictionSchema } from '../src/schema'

const validContradiction = {
  targetDocPath: 'docs/architecture.md',
  targetSection: '3.2 Payment Integration',
  targetLineStart: 114,
  targetLineEnd: 114,
  whatChanged: 'PR replaces batch payment calls with sequential single-item process() calls.',
  whatContradicts:
    'Section 3.2 of docs/architecture.md states that all payment operations MUST use batch mode.',
  proposedReplacement:
    'The payment service processes transactions individually via the /v2/process endpoint.',
  severity: 'High' as const,
  confidence: 5,
  quotedDocText:
    'The payment service processes transactions in batch via the /v2/batch endpoint.',
}

const validAddition = {
  targetDocPath: 'docs/architecture.md',
  anchorSection: 'Technology Stack',
  insertionMode: 'after' as const,
  proposedContent:
    '- Sentry ^8.0.0 — error tracking and performance monitoring; captures unhandled exceptions and emits release tags on deploy.',
  severity: 'Medium' as const,
  confidence: 4,
  whatChanged:
    'The PR introduces Sentry SDK initialisation in src/instrumentation.ts and adds `@sentry/node` to package.json.',
  rationaleForAddition:
    'The Technology Stack section lists every other observability dependency; Sentry is a new foundational dependency that belongs in the same list so the doc stays a faithful inventory of the stack.',
}

describe('AnalysisResultSchema', () => {
  it('round-trips the high-severity example from the prompt', () => {
    const input = {
      contradictions: [validContradiction],
      additions: [],
      rawConfidence: 1.0,
    }
    const parsed = AnalysisResultSchema.parse(input)
    expect(parsed.contradictions).toEqual([validContradiction])
    expect(parsed.additions).toEqual([])
    expect(parsed.rawConfidence).toBe(1.0)
  })

  it('accepts an empty contradictions array', () => {
    const parsed = AnalysisResultSchema.parse({
      contradictions: [],
      additions: [],
      rawConfidence: 1.0,
    })
    expect(parsed.contradictions).toEqual([])
    expect(parsed.additions).toEqual([])
  })

  it('rejects an invalid severity value', () => {
    const bad = { ...validContradiction, severity: 'Critical' }
    expect(() => ContradictionSchema.parse(bad)).toThrow()
  })

  it('rejects confidence outside 1–5', () => {
    expect(() =>
      ContradictionSchema.parse({ ...validContradiction, confidence: 6 }),
    ).toThrow()
    expect(() =>
      ContradictionSchema.parse({ ...validContradiction, confidence: 0 }),
    ).toThrow()
  })

  it('rejects non-integer confidence', () => {
    expect(() =>
      ContradictionSchema.parse({ ...validContradiction, confidence: 3.5 }),
    ).toThrow()
  })

  it('rejects rawConfidence outside 0.0–1.0', () => {
    expect(() =>
      AnalysisResultSchema.parse({
        contradictions: [],
        additions: [],
        rawConfidence: 1.5,
      }),
    ).toThrow()
    expect(() =>
      AnalysisResultSchema.parse({
        contradictions: [],
        additions: [],
        rawConfidence: -0.1,
      }),
    ).toThrow()
  })

  describe('Story 4.26 — additions field', () => {
    it('accepts an additions array alongside contradictions', () => {
      const parsed = AnalysisResultSchema.parse({
        contradictions: [validContradiction],
        additions: [validAddition],
        rawConfidence: 0.9,
      })
      expect(parsed.additions).toEqual([validAddition])
    })

    it('rejects AnalysisResultSchema when additions field is missing entirely', () => {
      expect(() =>
        AnalysisResultSchema.parse({
          contradictions: [],
          rawConfidence: 1.0,
        }),
      ).toThrow()
    })

    it('rejects an addition with insertionMode outside before|after', () => {
      expect(() =>
        AdditionSchema.parse({ ...validAddition, insertionMode: 'inside' }),
      ).toThrow()
    })

    it('rejects an addition with empty proposedContent', () => {
      expect(() =>
        AdditionSchema.parse({ ...validAddition, proposedContent: '' }),
      ).toThrow()
    })

    it('rejects an addition with empty anchorSection', () => {
      expect(() =>
        AdditionSchema.parse({ ...validAddition, anchorSection: '' }),
      ).toThrow()
    })
  })

  describe('Story 3.9b — quotedDocText', () => {
    it('rejects a contradiction missing quotedDocText', () => {
      const { quotedDocText: _omit, ...withoutQuote } = validContradiction
      expect(() => ContradictionSchema.parse(withoutQuote)).toThrow()
    })

    it('rejects an empty quotedDocText', () => {
      expect(() =>
        ContradictionSchema.parse({ ...validContradiction, quotedDocText: '' }),
      ).toThrow()
    })

    it('accepts a non-empty quotedDocText', () => {
      const parsed = ContradictionSchema.parse({
        ...validContradiction,
        quotedDocText: 'a',
      })
      expect(parsed.quotedDocText).toBe('a')
    })
  })
})
