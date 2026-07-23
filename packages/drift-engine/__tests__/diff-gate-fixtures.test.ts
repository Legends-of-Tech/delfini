// Golden-file recall fixtures for the diff-side relevance gate
// (docs/ideas/token-diet-symmetric-retrieval.md §4):
//
//   1. `lexically-invisible/case-01-paraphrase` — the gate's ACCEPTED recall
//      hole, pinned. A real contradiction whose hunk shares zero lexical
//      signal with its section is dropped at default thresholds. If a scoring
//      improvement ever closes the hole this test fails loudly — update it to
//      assert the keep and the fixture becomes a regression guard.
//   2. `cross-file/case-01-session-ttl` — survival guarantee. The hunks that
//      jointly carry the cross-file finding (issuer.ts + validator.ts) score
//      far above the keep bar and MUST survive gating, so the gate never eats
//      the multi-prompt planner's co-location contract from upstream.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { gateDiffByRelevance } from '../src/diff-gate'
import { parseDiffHunks } from '../src/diff-hunks'
import type { AnalysisInput } from '../src/types'

function loadJson<T>(rel: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'),
  ) as T
}

const DEFAULTS = { sectionThreshold: 5, keepThreshold: 5 }

describe('lexically-invisible fixture (the documented recall hole)', () => {
  const input = loadJson<AnalysisInput>(
    './fixtures/lexically-invisible/case-01-paraphrase/analysis-input.json',
  )
  const expected = loadJson<{
    gateAtDefaults: { keptFilePaths: string[]; droppedFilePaths: string[] }
  }>('./fixtures/lexically-invisible/case-01-paraphrase/expected.json')

  it('drops the invisible contradiction at default thresholds (accepted, labelled loss)', () => {
    const result = gateDiffByRelevance(input.diff, input.docs, DEFAULTS)
    expect(result.active).toBe(true)
    expect(result.droppedHunks.map((h) => h.filePath)).toEqual(
      expected.gateAtDefaults.droppedFilePaths,
    )
    for (const kept of expected.gateAtDefaults.keptFilePaths) {
      expect(result.keptDiff).toContain(kept)
    }
    for (const dropped of expected.gateAtDefaults.droppedFilePaths) {
      expect(result.keptDiff).not.toContain(dropped)
    }
  })

  it('keepThreshold 0 is the escape hatch — the invisible hunk survives', () => {
    const result = gateDiffByRelevance(input.diff, input.docs, {
      sectionThreshold: 5,
      keepThreshold: 0,
    })
    expect(result.active).toBe(false)
    expect(result.keptDiff).toBe(input.diff)
  })
})

describe('cross-file fixture survival (gate must not eat co-located findings)', () => {
  const input = loadJson<AnalysisInput>(
    './fixtures/cross-file/case-01-session-ttl/analysis-input.json',
  )
  const expected = loadJson<{
    crossFileFinding: { contributingFiles: string[] }
  }>('./fixtures/cross-file/case-01-session-ttl/expected.json')

  it('keeps every contributing file of the labelled cross-file finding at defaults', () => {
    const result = gateDiffByRelevance(input.diff, input.docs, DEFAULTS)
    expect(result.active).toBe(true)

    const droppedPaths = new Set(result.droppedHunks.map((h) => h.filePath))
    const keptPaths = new Set(parseDiffHunks(result.keptDiff).map((h) => h.filePath))
    for (const file of expected.crossFileFinding.contributingFiles) {
      expect(droppedPaths.has(file)).toBe(false)
      expect(keptPaths.has(file)).toBe(true)
    }
  })
})
