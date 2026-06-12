// @delfini/action-core — single barrel (project rule: named exports only;
// barrel only at packages/*/src/index.ts).
//
// Story P3.9.2a (Lite/Full artifact split, Mechanism A): the shared
// analysis-pipeline core of the Delfini GitHub Action, consumed by the public
// Lite artifact (apps/action) and the Full artifact (apps/action-full;
// re-homed into delfini-web at P3.9.4) — algorithm parity by construction.
//
// V1 stability posture: internal shared core, published for transparency and
// delfini-web consumption — no semver API-stability promise (see README.md).

export { readDocsViaGitTrees, readDocsAtHeadViaGitTrees } from './doc-reader.js'
export type { DocFile, DocsReadResult, ReadDocsOptions, ScopeSource } from './doc-reader.js'

export { parseFrontMatter, stripFrontMatter } from './doc-exclusion.js'
export type { ExcludedDoc, ExclusionReason, FrontMatterResult } from './doc-exclusion.js'

export { buildAnalysisInput } from './analysis-input.js'
export type { BuildAnalysisInputOptions } from './analysis-input.js'

export { classifyPr } from './smart-skip.js'
export type { SmartSkipOptions, SmartSkipResult } from './smart-skip.js'

export { buildUnifiedDiff } from './diff-builder.js'

export {
  DELFINI_PR_COMMENT_MARKER,
  createCheckStatus,
  getFileContent,
  getPrContext,
  isForbiddenError,
  listChangedFiles,
  postOrUpdatePrComment,
  readDocs,
} from './github-client-shared.js'
export type { ChangedFile, PrContext } from './github-client-shared.js'

export { readPipelineInputs } from './pipeline-inputs.js'
export type { Enforcement, PipelineDeps, PipelineInputs } from './pipeline-inputs.js'

export { createOrchestrator } from './adapters/factory.js'
export {
  SingleCallOrchestrator,
  loadTemplate as loadPromptTemplate,
} from './adapters/single-call/orchestrator.js'
export { createChatModel } from './adapters/single-call/model.js'
export type { LLMProvider } from './adapters/single-call/model.js'

export type { AnalysisOrchestrator } from './ports/orchestrator.js'
