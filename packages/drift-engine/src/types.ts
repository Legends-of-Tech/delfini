// Pure-logic types for the drift-detection algorithm. No I/O, no wire shapes,
// no platform-specific schema fields. The wire-shape types used by the Action
// to talk to the hosted platform (Intake*, Config*, ReviewStatus, etc.) live
// in `apps/action/src/ports/intake-types.ts` — those carry snake_case field
// names load-bearing for the FR88d/FR88g contract and have no business here.

export type Severity = 'High' | 'Medium' | 'Low'

export interface DocFile {
  path: string
  content: string
  // Story 3.9b — count of lines stripped from the original file as YAML
  // front-matter. The prompt-builder offsets its `N: ` line-number prefix by
  // this count so the LLM sees absolute (original-file) line numbers; the
  // reconciler does the same when computing the final targetLineStart /
  // targetLineEnd from a located quote.
  frontMatterLineCount: number
}

export interface PRMetadata {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string
  title: string
}

export interface AnalysisInput {
  diff: string
  docs: DocFile[]
  prMetadata: PRMetadata
}

export interface Contradiction {
  targetDocPath: string
  targetSection: string
  targetLineStart: number
  targetLineEnd: number
  whatChanged: string
  whatContradicts: string
  proposedReplacement: string | null
  severity: Severity
  // 1–5 integer; not surfaced in output, kept for future quality-gate use.
  confidence: number
  // Story 3.9b — verbatim doc-side excerpt the LLM cites as contradicted.
  // After reconciliation, `targetLineStart` / `targetLineEnd` are derived
  // from `indexOf(quotedDocText)` over the doc body — the LLM's emitted line
  // numbers become advisory; the code is the source of truth. Findings whose
  // quote can't be located in the doc are dropped before this shape leaves
  // `validateAndReconcile` (no-fabrication principle).
  quotedDocText: string
}

// Story 4.25 — additive finding shape. The LLM cites an anchor SECTION
// HEADING; the reconciler locates that heading's line number in the doc body
// and stores it in `anchorLine`. Findings whose anchor heading can't be
// located in the doc are dropped (same no-fabrication semantics as
// Contradiction's quotedDocText grounding).
export interface Addition {
  targetDocPath: string
  anchorSection: string
  // Absolute line number of the anchor heading in the doc body (post-
  // reconciliation; the LLM does not emit this — it emits the heading text
  // and the reconciler derives the line).
  anchorLine: number
  insertionMode: 'before' | 'after'
  proposedContent: string
  severity: Severity
  confidence: number
  whatChanged: string
  rationaleForAddition: string
}

// Story 4.26 — `additions` is REQUIRED (mirrors the Zod schema's required
// shape). Consumers must emit `additions: []` when no additive findings
// apply, not `undefined`.
//
// `narrativeOnlyContradictions` is OPTIONAL (post-v6.5 Skill UX fix). Carries
// drift findings the LLM correctly identified BUT for which `proposedReplacement`
// is null/empty — i.e. the doc rule is correct and the code is the violation;
// the resolution is to fix code, not docs, so no actionable doc patch exists.
// `filterActionableContradictions` separates these from the apply-eligible
// `contradictions` array; the field exists so the Skill's CLI report can
// surface them under "Manual review required" instead of silently dropping
// them. The Action's hosted-review consumers ignore the field by default
// (preserves Stream 4a auto-resolve semantics — see reconcile.ts L85-101).
export interface AnalysisResult {
  contradictions: Contradiction[]
  additions: Addition[]
  rawConfidence: number
  narrativeOnlyContradictions?: Contradiction[]
}

// PLAN: docs/superpowers/plans/2026-05-28-doc-relevance-gating.md
// Opt-in prompt-builder options for doc-relevance gating.
//
// Default behaviour (`options` omitted or `relevanceThreshold` is undefined /
// 0) is observably no-op — NFR44 prompt-snapshot gate enforces byte-equality
// for the no-options call path.
export interface BuildPromptOptions {
  /**
   * When set to a positive integer, docs whose relevance score is below
   * this threshold are dropped from the prompt before rendering. Score is
   * computed by `selectRelevantDocs` (file-path overlap + identifier
   * overlap + heading overlap + doc-path-in-diff). When undefined or 0,
   * every doc in `input.docs` is included verbatim.
   */
  relevanceThreshold?: number
  /**
   * Story P3.7.3 / FR152 — ranked-fill prompt budget. When set to a positive
   * finite integer AND `relevanceThreshold` is also positive, retained doc
   * sections are ranked most-relevant-first and included only while the
   * running token total stays at-or-below this budget. Sections that don't
   * fit are surfaced as `droppedSections` from `buildPromptWithDrops`.
   *
   * Default (undefined / <= 0 / non-finite) → no budget cap; every retained
   * section is rendered (P3.7.1 retrieval-on path is unchanged). When
   * `relevanceThreshold` is undefined / <= 0 / non-finite this option is
   * IGNORED — there are no scored candidates to rank.
   *
   * Budget unit: estimated tokens via `estimatePromptTokens` (Math.ceil(len/3.5)).
   */
  promptTokenBudget?: number
}

// PRD v6.5 / architecture.md — clarification finding shape. Forward-looking
// stub: `validateAndReconcile` does not yet emit `ClarifyingQuestion` values
// (orchestrator-side clarification synthesis is future work — the
// clarification leg is unreachable in v1 of the analysis algorithm). The
// type is exported so the Skill protocol and downstream consumers can begin
// importing it without a breaking API change when synthesis lands.
export interface ClarifyingQuestion {
  whatChanged: string
  naturalHomeDoc: string
  naturalHomeSection: string
  question: string
  proposedReplacement: string | null
}
