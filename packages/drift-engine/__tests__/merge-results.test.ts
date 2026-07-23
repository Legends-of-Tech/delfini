import { describe, it, expect } from 'vitest'
import { mergeAnalysisResults } from '../src/reconcile'
import type { Addition, AnalysisResult, Contradiction } from '../src/types'

function contradiction(over: Partial<Contradiction> = {}): Contradiction {
  return {
    targetDocPath: 'docs/a.md',
    targetSection: '## S',
    targetLineStart: 10,
    targetLineEnd: 12,
    whatChanged: 'changed',
    whatContradicts: 'contradicts',
    proposedReplacement: 'new text',
    severity: 'High',
    confidence: 3,
    quotedDocText: 'old text',
    ...over,
  }
}

function addition(over: Partial<Addition> = {}): Addition {
  return {
    targetDocPath: 'docs/a.md',
    anchorSection: '## S',
    anchorLine: 5,
    insertionMode: 'after',
    proposedContent: 'added line',
    severity: 'Low',
    confidence: 2,
    whatChanged: 'changed',
    rationaleForAddition: 'because',
    ...over,
  }
}

function result(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return { contradictions: [], additions: [], rawConfidence: 1, ...over }
}

describe('mergeAnalysisResults', () => {
  it('empty input → empty result with zero confidence', () => {
    expect(mergeAnalysisResults([])).toEqual({
      contradictions: [],
      additions: [],
      rawConfidence: 0,
    })
  })

  it('keeps distinct findings across chunks and unions them', () => {
    const a = result({ contradictions: [contradiction({ targetDocPath: 'docs/a.md', targetLineStart: 10, targetLineEnd: 12 })] })
    const b = result({ contradictions: [contradiction({ targetDocPath: 'docs/b.md', targetLineStart: 1, targetLineEnd: 2 })] })
    const merged = mergeAnalysisResults([a, b])
    expect(merged.contradictions).toHaveLength(2)
    expect(merged.contradictions.map((c) => c.targetDocPath).sort()).toEqual(['docs/a.md', 'docs/b.md'])
  })

  it('dedups the SAME doc-line contradiction seen in two chunks, keeping higher confidence', () => {
    const lowConf = contradiction({ confidence: 2, whatContradicts: 'low' })
    const highConf = contradiction({ confidence: 5, whatContradicts: 'high' })
    const warnings: string[] = []
    const merged = mergeAnalysisResults(
      [result({ contradictions: [lowConf] }), result({ contradictions: [highConf] })],
      (m) => warnings.push(m),
    )
    expect(merged.contradictions).toHaveLength(1)
    expect(merged.contradictions[0].confidence).toBe(5)
    expect(merged.contradictions[0].whatContradicts).toBe('high')
    expect(warnings.some((w) => w.includes('overlapping'))).toBe(true)
  })

  it('exact-dedups identical additions but keeps additions with different anchors/content', () => {
    const dup1 = addition({ anchorLine: 5, proposedContent: 'X' })
    const dup2 = addition({ anchorLine: 5, proposedContent: 'X' })
    const distinct = addition({ anchorLine: 9, proposedContent: 'Y' })
    const warnings: string[] = []
    const merged = mergeAnalysisResults(
      [result({ additions: [dup1, distinct] }), result({ additions: [dup2] })],
      (m) => warnings.push(m),
    )
    expect(merged.additions).toHaveLength(2)
    expect(warnings.some((w) => w.includes('duplicate additive'))).toBe(true)
  })

  it('merges and exact-dedups narrative-only contradictions; omits the key when empty', () => {
    const n = contradiction({ proposedReplacement: null, whatContradicts: 'manual' })
    const withNarrative = mergeAnalysisResults([
      result({ narrativeOnlyContradictions: [n] }),
      result({ narrativeOnlyContradictions: [{ ...n }] }),
    ])
    expect(withNarrative.narrativeOnlyContradictions).toHaveLength(1)

    const withoutNarrative = mergeAnalysisResults([result(), result()])
    expect('narrativeOnlyContradictions' in withoutNarrative).toBe(false)
  })

  it('rawConfidence is the max across chunks', () => {
    const merged = mergeAnalysisResults([
      result({ rawConfidence: 2 }),
      result({ rawConfidence: 9 }),
      result({ rawConfidence: 4 }),
    ])
    expect(merged.rawConfidence).toBe(9)
  })

  it('is deterministic', () => {
    const inputs = [
      result({ contradictions: [contradiction({ targetDocPath: 'docs/z.md' })], additions: [addition()] }),
      result({ contradictions: [contradiction({ targetDocPath: 'docs/a.md', targetLineStart: 1, targetLineEnd: 1 })] }),
    ]
    expect(mergeAnalysisResults(inputs)).toEqual(mergeAnalysisResults(inputs))
  })
})
