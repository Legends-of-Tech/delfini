// Public API surface for @delfini/drift-engine.
//
// Imported by both apps/action (CI surface) and packages/cli (Skill surface).
// Algorithm parity between the two surfaces holds by construction: a finding
// surfaced locally is the same finding the Action will surface on the
// eventual PR.
//
// Hard rules (enforced via ESLint no-restricted-imports on
// packages/drift-engine/src/**/*.ts):
//   - No fs / child_process / http / https
//   - No @anthropic-ai/sdk / openai / @langchain/*
//   - No process.env reads
//   - Runtime deps: zod + picomatch (both pure CPU — no I/O, no network, no
//     env). picomatch was added under ADR-2026-06-01 as the single glob
//     dialect for the doc-scope algebra below; the no-I/O charter is intact.
// Adding any other runtime dep, or any of the blocked imports above, is a
// regression.
//
// Per AC2 (architecture.md L1055–L1070): the barrel exposes exactly the
// documented surface — no internal helpers (`dedupeOverlappingContradictions`,
// `filterActionableContradictions`, `reconcileLineNumbers`,
// `reconcileAdditiveAnchors`, `ContradictionSchema`, `AdditionSchema`,
// `locateQuote`, `locateAnchorHeading`, `WarnFn`, etc.) leak through.
// Tests reach internal helpers via relative `../src/...` imports because
// they live inside the same workspace package.

export { buildPrompt, buildPromptWithDrops } from './prompt-builder.js'
export { validateAndReconcile } from './reconcile.js'
export { estimatePromptTokens } from './prompt-budget.js'
export { analysisSchema } from './schema.js'

// Doc-scope algebra (ADR-2026-06-01) — shared normalize / validate / classify
// / in-scope predicate. Pure; picomatch@4 is the single glob dialect.
export {
  normalizeDocScope,
  validateDocScopeEntry,
  classifyEntry,
  isFileInDocScope,
} from './doc-scope.js'

// Story P3.7.2 / FR151 — deterministic diff pre-filter. Exported because the
// gate lives at the consumer (CLI `runLocalPrepare` / Action `buildAnalysisInput`)
// not inside `buildPrompt`; see story Dev Notes §"Where the gate lives". The
// default consumer path does not call this — `buildPrompt` output stays
// byte-identical and the NFR44 snapshot gate stays green.
export { filterDiff } from './diff-filter.js'

// Story P3.7.3 / FR152 — ranked-fill prompt budget. The pure cross-doc
// selector + the cross-doc DroppedSection shape extension live in relevance.ts
// (sibling to selectRelevantSections). The drops-aware sibling
// `buildPromptWithDrops` is exported above. These are reachable through the
// public surface because the CLI consumer (`runLocalPrepare`) needs the
// drop record to render the "dropped N section(s) — over prompt budget"
// header and to write `_rankedFillResult` into `.delfini-trace/`.
export { rankedFillSections } from './relevance.js'

export type {
  AnalysisInput,
  AnalysisResult,
  DocFile,
  Contradiction,
  Addition,
  ClarifyingQuestion,
  PRMetadata,
  Severity,
  BuildPromptOptions,
} from './types.js'

export type {
  DropReason,
  DroppedPath,
  DroppedHunk,
  FilterDiffResult,
  FilterDiffOptions,
} from './diff-filter.js'

export type {
  DocSection,
  DroppedSection,
  RankedFillCandidate,
  RankedFillResult,
} from './relevance.js'
