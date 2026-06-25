import { describe, it, expect, vi } from 'vitest'
import { SingleCallOrchestrator } from '../src/adapters/single-call/orchestrator'
import type { AnalysisInput, AnalysisResult } from '@delfini/drift-engine'
import type { Addition, Contradiction } from '@delfini/drift-engine'

// =====================================================================
// Story P3.9.2a (AC5.3) — this test moved into @delfini/action-core with the
// single-call adapter. action-core must not import any Full-only module
// (stream-routing / ports/intake-types live in the Full artifact), so the
// FR88a wire-mapping helper + wire types the AC7 test previously imported
// from `stream-routing.ts` are INLINED below as test-local copies. The real
// `buildIntakeInput` keeps its own coverage in the Full artifact's suites;
// this local copy only preserves the AC7 orchestrator->wire flow assertion.
// =====================================================================

interface LocalIntakeDriftFinding {
  kind: 'drift'
  target_doc_path: string
  section_anchor: string
  target_line_start: number
  target_line_end: number
  proposed_replacement: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  evidence: string[]
  quoted_doc_text: string
  what_changed: string
  what_contradicts: string
}

interface LocalIntakeAdditiveFinding {
  kind: 'additive'
  target_doc_path: string
  anchor_section: string
  anchor_line: number
  insertion_mode: 'before' | 'after'
  proposed_content: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  evidence: string[]
  what_changed: string
  rationale_for_addition: string
}

type LocalIntakeFinding = LocalIntakeDriftFinding | LocalIntakeAdditiveFinding

function toWireSeverity(severity: string): 'low' | 'medium' | 'high' {
  return severity.toLowerCase() as 'low' | 'medium' | 'high'
}

function toWireConfidence(confidence: number): number {
  return confidence / 5
}

// Test-local mirror of the Full artifact's buildIntakeInput mapping (drift +
// additive arms) — enough to assert the orchestrator's reconciled output
// lands on the FR88a wire shape with the right kind discriminators.
function buildLocalIntakeFindings(
  contradictions: Contradiction[],
  additions: Addition[],
): LocalIntakeFinding[] {
  const drift: LocalIntakeFinding[] = contradictions.map((c) => ({
    kind: 'drift',
    target_doc_path: c.targetDocPath,
    section_anchor: c.targetSection,
    target_line_start: c.targetLineStart,
    target_line_end: c.targetLineEnd,
    proposed_replacement: c.proposedReplacement ?? '',
    severity: toWireSeverity(c.severity),
    confidence: toWireConfidence(c.confidence),
    evidence: [],
    quoted_doc_text: c.quotedDocText,
    what_changed: c.whatChanged,
    what_contradicts: c.whatContradicts,
  }))
  const additive: LocalIntakeFinding[] = additions.map((a) => ({
    kind: 'additive',
    target_doc_path: a.targetDocPath,
    anchor_section: a.anchorSection,
    anchor_line: a.anchorLine,
    insertion_mode: a.insertionMode,
    proposed_content: a.proposedContent,
    severity: toWireSeverity(a.severity),
    confidence: toWireConfidence(a.confidence),
    evidence: [],
    what_changed: a.whatChanged,
    rationale_for_addition: a.rationaleForAddition,
  }))
  return [...drift, ...additive]
}

const sampleInput: AnalysisInput = {
  diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n',
  docs: [{ path: 'docs/arch.md', content: 'Hello', frontMatterLineCount: 0 }],
  prMetadata: {
    owner: 'acme',
    repo: 'widget',
    prNumber: 1,
    headSha: 'h',
    baseSha: 'b',
    title: 't',
  },
}

const cannedResult: AnalysisResult = {
  contradictions: [
    {
      targetDocPath: 'docs/arch.md',
      targetSection: '§1',
      targetLineStart: 1,
      targetLineEnd: 1,
      whatChanged: 'PR replaces a documented helper.',
      whatContradicts: '§1 of docs/arch.md describes the documented helper.',
      proposedReplacement: 'Updated §1 wording.',
      severity: 'Medium',
      confidence: 3,
      // Story 3.9b — must appear verbatim in `sampleInput.docs[0].content` so
      // the orchestrator's `reconcileLineNumbers` pass keeps the contradiction.
      quotedDocText: 'Hello',
    },
  ],
  additions: [],
  rawConfidence: 0.6,
}

// Story 4.25 — the orchestrator now also surfaces a normalised `additions`
// array (empty when the LLM emits no additive findings or omits the field
// entirely). Compare against this expected shape rather than `cannedResult`
// directly so the assertion mirrors the post-reconciliation contract.
const expectedHappyPathResult: AnalysisResult = {
  ...cannedResult,
  additions: [],
}

function makeFakeModel(structured: { invoke: ReturnType<typeof vi.fn> }) {
  return {
    withStructuredOutput: vi.fn(() => structured),
  } as unknown as import('@langchain/core/language_models/chat_models').BaseChatModel
}

describe('SingleCallOrchestrator', () => {
  it('returns the structured result on happy path', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(cannedResult)
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model)

    const result = await orchestrator.analyze(sampleInput)

    expect(result).toEqual(expectedHappyPathResult)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('retries once on first-call failure and returns the second result', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('schema parse failed'))
      .mockResolvedValueOnce(cannedResult)
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model)

    const result = await orchestrator.analyze(sampleInput)

    expect(result).toEqual(expectedHappyPathResult)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('throws when both attempts fail (retry exhausted)', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model)

    await expect(orchestrator.analyze(sampleInput)).rejects.toThrow('second failure')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  // When the LLM call exhausts both attempts with an empty `{}` tool call
  // (Anthropic degradation pattern), rethrow with a CLEAN message so the
  // pipeline's outer catch surfaces an informative neutral check via NFR42.
  // Silent PASS would be wrong for a drift detector — a degraded LLM is
  // indistinguishable from a clean PR otherwise.
  it('throws a clean message when LLM returns an empty structured-output response', async () => {
    const emptyResponseError = new Error(
      'Failed to parse. Text: "{}". Error: [{"code":"invalid_type","expected":"array","received":"undefined","path":["contradictions"],"message":"Required"}]',
    )
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(emptyResponseError)
      .mockRejectedValueOnce(emptyResponseError)
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model)

    await expect(orchestrator.analyze(sampleInput)).rejects.toThrow(
      /empty structured-output response.*Anthropic API degradation.*Re-run the Action/s,
    )
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  // Story 4.26 AC7 — end-to-end test: a canned LLM response containing one
  // drift + one additive finding flows through the orchestrator's
  // reconciliation pass and `buildIntakeInput` and lands on the FR88d wire
  // payload with the expected `kind: 'drift'` + `kind: 'additive'` entries.
  // The LLM is mocked at the `withStructuredOutput → invoke` boundary (same
  // pattern as the existing happy-path test); no LangChain internals mocked.
  it('AC7 — flows drift+additive through orchestrator → buildIntakeInput with kind discriminators', async () => {
    const docContent = '# Technology Stack\n- React 18\n## API\n- batch endpoint\n'
    const ac7Input: AnalysisInput = {
      diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-batch\n+sequential\n',
      docs: [
        {
          path: 'docs/architecture.md',
          content: docContent,
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: {
        owner: 'acme',
        repo: 'widget',
        prNumber: 7,
        headSha: 'head',
        baseSha: 'base',
        title: 'Switch to sequential + add Sentry',
      },
    }

    const ac7LlmResult: AnalysisResult = {
      contradictions: [
        {
          targetDocPath: 'docs/architecture.md',
          targetSection: 'API',
          targetLineStart: 4,
          targetLineEnd: 4,
          whatChanged: 'PR replaces batch with sequential calls.',
          whatContradicts: 'API section says batch endpoint.',
          proposedReplacement: '- sequential endpoint',
          severity: 'High',
          confidence: 5,
          quotedDocText: '- batch endpoint',
        },
      ],
      additions: [
        {
          // anchorLine is overwritten by reconcileAdditiveAnchors using the
          // anchorSection heading; the LLM emits the heading text only.
          targetDocPath: 'docs/architecture.md',
          anchorSection: 'Technology Stack',
          anchorLine: 0,
          insertionMode: 'after',
          proposedContent: '- Sentry ^8.0.0 — error tracking and performance monitoring.',
          severity: 'Medium',
          confidence: 4,
          whatChanged: 'PR adds Sentry initialisation.',
          rationaleForAddition:
            'Technology Stack enumerates every runtime dependency; Sentry is one now.',
        },
      ],
      rawConfidence: 0.9,
    }

    const invoke = vi.fn().mockResolvedValueOnce(ac7LlmResult)
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model)

    const reconciled = await orchestrator.analyze(ac7Input)

    expect(reconciled.contradictions).toHaveLength(1)
    expect(reconciled.additions).toHaveLength(1)
    expect(reconciled.additions?.[0]?.anchorLine).toBe(1)

    const findings = buildLocalIntakeFindings(
      reconciled.contradictions,
      reconciled.additions ?? [],
    )

    const driftFindings = findings.filter(
      (f): f is LocalIntakeDriftFinding => f.kind === 'drift',
    )
    const additiveFindings = findings.filter(
      (f): f is LocalIntakeAdditiveFinding => f.kind === 'additive',
    )

    expect(driftFindings).toHaveLength(1)
    expect(additiveFindings).toHaveLength(1)
    expect(additiveFindings[0]?.target_doc_path).toBe('docs/architecture.md')
    expect(additiveFindings[0]?.anchor_section).toBe('Technology Stack')
    expect(additiveFindings[0]?.insertion_mode).toBe('after')
    expect(additiveFindings[0]?.proposed_content).toContain('Sentry')
    expect(additiveFindings[0]?.anchor_line).toBe(1)
  })

  it('rethrows non-empty parse failures verbatim (real schema regressions still surface)', async () => {
    const realSchemaError = new Error(
      'Failed to parse. Text: "{\\"contradictions\\":\\"not an array\\"}". Error: ...',
    )
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(realSchemaError)
      .mockRejectedValueOnce(realSchemaError)
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model)

    await expect(orchestrator.analyze(sampleInput)).rejects.toThrow('Failed to parse')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  // --- Multi-prompt fallback (over-budget diff) -----------------------------

  const QUOTE = 'The moduleHandler in src/modules dispatches 100 events per tick.'

  // A diff big enough that the whole prompt exceeds a 9k budget but each routed
  // chunk fits — the 30 hunks all reference the ## Modules section's identifiers.
  function overBudgetInput(): AnalysisInput {
    let diff = ''
    for (let i = 0; i < 30; i++) {
      diff +=
        `diff --git a/src/modules/mod-${i}.ts b/src/modules/mod-${i}.ts\n` +
        `--- a/src/modules/mod-${i}.ts\n+++ b/src/modules/mod-${i}.ts\n` +
        `@@ -1,2 +1,2 @@\n` +
        `-export const moduleHandler = registerModuleHandler(${i})\n` +
        `+export const moduleHandler = registerModuleHandler(${i} + 1)\n` +
        ` // moduleHandler under src/modules\n`
    }
    return {
      diff,
      docs: [
        {
          path: 'docs/guide.md',
          content: `# Reference\n\n## Modules\n\n${QUOTE}\nEvery src/modules file registers a moduleHandler.`,
          frontMatterLineCount: 0,
        },
      ],
      prMetadata: { owner: 'acme', repo: 'widget', prNumber: 9, headSha: 'h', baseSha: 'b', title: 't' },
    }
  }

  it('over budget → splits via planPrompts, dispatches each chunk, merges + dedups', async () => {
    const canned: AnalysisResult = {
      contradictions: [
        {
          targetDocPath: 'docs/guide.md',
          targetSection: '## Modules',
          targetLineStart: 5,
          targetLineEnd: 5,
          whatChanged: 'moduleHandler tick budget changed',
          whatContradicts: 'doc states a stale value',
          proposedReplacement: 'The moduleHandler in src/modules dispatches 200 events per tick.',
          severity: 'High',
          confidence: 4,
          quotedDocText: QUOTE,
        },
      ],
      additions: [],
      rawConfidence: 0.7,
    }
    // Every chunk returns the SAME finding (the shared section was rendered into
    // each chunk) — merge must collapse it to one.
    const invoke = vi.fn().mockResolvedValue(canned)
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model, { promptTokenBudget: 9000 })

    const result = await orchestrator.analyze(overBudgetInput())

    // Split happened → more than one LLM call…
    expect(invoke.mock.calls.length).toBeGreaterThanOrEqual(2)
    // …but the duplicate finding is deduped down to one.
    expect(result.contradictions).toHaveLength(1)
    expect(result.contradictions[0].proposedReplacement).toContain('200 events')
  })

  it('over budget but planner cannot split (threshold 0) → one whole-prompt call', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ contradictions: [], additions: [], rawConfidence: 0.1 })
    const model = makeFakeModel({ invoke })
    const orchestrator = new SingleCallOrchestrator(model, {
      promptTokenBudget: 1,
      relevanceThreshold: 0,
    })

    await orchestrator.analyze(overBudgetInput())
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
