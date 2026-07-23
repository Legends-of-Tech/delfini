import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as core from '@actions/core'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  analysisSchema,
  buildPrompt,
  estimatePromptTokens,
  gateDiffByRelevance,
  mergeAnalysisResults,
  planPrompts,
  validateAndReconcile,
} from '@delfini/drift-engine'
import type { AnalysisInput, AnalysisResult } from '@delfini/drift-engine'
import type { AnalysisOrchestrator } from '../../ports/orchestrator.js'
import { createChatModel } from './model.js'

// Structural view of `model.withStructuredOutput(...)` — a runnable that takes
// the prompt string and resolves the (unvalidated) tool-call object. Both the
// real LangChain Runnable and the test fake satisfy this shape.
interface StructuredModel {
  invoke(prompt: string): Promise<unknown>
}

// Per-prompt token budget + routing threshold for the multi-prompt fallback
// (docs/ideas/multi-prompt-diff-analysis.md). When the assembled prompt exceeds
// the budget the orchestrator splits the analysis across several budget-sized
// prompts via `planPrompts` and merges the per-chunk results — the SAME
// drift-engine primitives the Skill's `local-prepare` / `local-finalize` use,
// so a finding the Skill surfaces locally is the finding the Action surfaces on
// the PR (parity by construction). The values DELIBERATELY mirror the CLI's
// `PROMPT_TOKEN_BUDGET` (150k) and `DEFAULT_RELEVANCE_THRESHOLD` (5) so both
// surfaces split at the same point; action-core cannot import from
// `@delfini/cli`, so they are duplicated here and must move in lockstep. The
// 1M-context model could swallow more in one call, but matching the Skill's
// split point is the parity choice. Override via the constructor for tests /
// operators who want a different split point.
export const ANALYSIS_PROMPT_TOKEN_BUDGET = 150_000
export const ANALYSIS_RELEVANCE_THRESHOLD = 5

// Per-hunk keep bar for the diff-side relevance gate
// (docs/ideas/token-diet-symmetric-retrieval.md). DELIBERATELY mirrors the
// CLI's cross-flag default (`--diff-keep-threshold` follows
// `--relevance-threshold`, i.e. 5) so both surfaces make identical keep/drop
// decisions on identical input — same lockstep duplication note as the two
// constants above. Set `diffKeepThreshold: 0` via the constructor to disable
// gating for a run.
export const ANALYSIS_DIFF_KEEP_THRESHOLD = 5

// Resolve the canonical prompt template. drift-engine is pure-logic (no
// I/O); action-core loads the template here and passes it into
// `buildPrompt(input, template)`.
//
// Story P3.9.2a AC3 — dual-mode resolution (Dev Notes candidate 2; candidate
// 1, `createRequire(import.meta.url).resolve('@delfini/drift-engine/prompt.md')`,
// was tried first and FAILED ncc asset tracing — the bundle shipped no
// asset). The build copies drift-engine's prompt.md (resolved through its
// package export — never a repo-relative path) into dist/ NEXT TO this
// module (see scripts/copy-prompt.mjs), and the reference below is the one
// shape both consumption modes handle:
//   (a) plain node_modules resolution of the published tarball — the copied
//       file ships inside dist/ adjacent to orchestrator.js; and
//   (b) ncc/webpack bundling by the action artifacts — webpack 5 natively
//       understands `new URL(<static literal>, import.meta.url)`, emits the
//       file as a dist asset, and rewrites the URL expression.
// Do NOT wrap in fileURLToPath — that masks the asset-reference shape
// webpack detects. The AC3 dist asset check + pack-install smoke gate both
// modes.
const PROMPT_URL = new URL('./prompt.md', import.meta.url)
let cachedTemplate: string | undefined

function resolvePromptUrl(): URL {
  if (existsSync(PROMPT_URL)) return PROMPT_URL
  // Dev-context fallback: when this module runs from src/ (vitest transforms
  // the TS source; no build-step copy sits next to it), resolve the template
  // through drift-engine's package export. Deliberately NOT a
  // `new URL(<literal>, import.meta.url)` shape — bundlers must not trace it
  // (the path does not exist in a published-package consumer's tree, and the
  // primary dist-adjacent copy always wins outside the dev context).
  const require = createRequire(import.meta.url)
  return pathToFileURL(require.resolve('@delfini/drift-engine/prompt.md'))
}

// Exported (as `loadPromptTemplate` from the barrel) so the AC3 pack-install
// smoke can prove the published package resolves and reads the template.
export function loadTemplate(): string {
  if (cachedTemplate === undefined) {
    cachedTemplate = readFileSync(resolvePromptUrl(), 'utf8')
  }
  return cachedTemplate
}

export class SingleCallOrchestrator implements AnalysisOrchestrator {
  private readonly model: BaseChatModel
  private readonly budget: number
  private readonly threshold: number
  private readonly diffKeepThreshold: number

  constructor(
    model: BaseChatModel = createChatModel(),
    options: {
      promptTokenBudget?: number
      relevanceThreshold?: number
      diffKeepThreshold?: number
    } = {},
  ) {
    this.model = model
    this.budget = options.promptTokenBudget ?? ANALYSIS_PROMPT_TOKEN_BUDGET
    this.threshold = options.relevanceThreshold ?? ANALYSIS_RELEVANCE_THRESHOLD
    this.diffKeepThreshold = options.diffKeepThreshold ?? ANALYSIS_DIFF_KEEP_THRESHOLD
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const structured = this.model.withStructuredOutput(analysisSchema, {
      name: 'AnalysisResult',
    }) as StructuredModel
    const warn = (message: string): void => core.warning(message)

    // Diff-side relevance gate FIRST (mirrors the CLI's `local-prepare` step
    // 4b — docs/ideas/token-diet-symmetric-retrieval.md): drop hunks linked to
    // no retained doc section, trim context on weakly-linked ones. The gate is
    // pure and the thresholds are lockstep constants, so both surfaces make
    // the identical decision on identical input (parity by construction). It
    // stands down on its own degenerate cases (returns the diff verbatim), so
    // `effective` is never an empty-diff input. Reconciliation below always
    // uses the FULL `input.docs` — grounding is gate-independent.
    const gate = gateDiffByRelevance(input.diff, input.docs, {
      sectionThreshold: this.threshold,
      keepThreshold: this.diffKeepThreshold,
    })
    const effective: AnalysisInput = gate.active
      ? { ...input, diff: gate.keptDiff }
      : input
    if (gate.active && gate.droppedHunks.length > 0) {
      const droppedFiles = new Set(gate.droppedHunks.map((h) => h.filePath)).size
      core.warning(
        `Delfini diff gate: dropped ${gate.droppedHunks.length} hunk(s) in ${droppedFiles} ` +
          `file(s) not relevant to any in-scope doc section (kept ${
            Object.values(gate.keptByReason).reduce((a, b) => a + b, 0)
          } hunk(s)).`,
      )
    }

    // Fast path — the whole prompt fits one call. Identical to the pre-multi-
    // prompt behaviour (buildPrompt with no retrieval options → one LLM call →
    // reconcile), so existing single-call runs are unchanged.
    const wholePrompt = buildPrompt(effective, loadTemplate())
    if (estimatePromptTokens(wholePrompt) <= this.budget) {
      const result = await this.invokeWithRetry(structured, wholePrompt)
      return validateAndReconcile(result, input.docs, warn)
    }

    // Over budget — split the analysis across budget-sized prompts (the same
    // `planPrompts` the Skill's `local-prepare` uses) and merge the per-chunk
    // reconciled results (the same `mergeAnalysisResults` the Skill's
    // `local-finalize` uses). Parity by construction: both surfaces route the
    // diff and dedup findings identically.
    const plan = planPrompts(effective, loadTemplate(), {
      promptTokenBudget: this.budget,
      relevanceThreshold: this.threshold,
    })

    // Degenerate: the planner could not split (no routing signal, or nothing
    // fits) — send the whole prompt anyway. The 1M-context model may still
    // accept it; failing loud beats silently analysing nothing.
    if (!plan.split) {
      const result = await this.invokeWithRetry(structured, wholePrompt)
      return validateAndReconcile(result, input.docs, warn)
    }

    if (plan.oversizedSections.length > 0) {
      core.warning(
        `Delfini split this PR into ${plan.chunks.length} analysis prompts; ` +
          `${plan.oversizedSections.length} doc section(s) attracted more diff than one prompt holds — ` +
          `cross-file drift spanning those splits may be missed.`,
      )
    }

    // Reconcile each chunk against the FULL doc set (line numbers are absolute,
    // so grounding is chunk-independent), then merge + dedup across chunks.
    const results: AnalysisResult[] = []
    for (const chunk of plan.chunks) {
      const raw = await this.invokeWithRetry(structured, chunk.prompt)
      results.push(validateAndReconcile(raw, input.docs, warn))
    }
    return mergeAnalysisResults(results, warn)
  }

  // One LLM call with a single retry. On a second failure, an empty `{}`
  // tool-call (Anthropic degradation) is rethrown with a CLEAN message so the
  // pipeline's outer catch surfaces an informative neutral check via NFR42 —
  // silent PASS would be wrong for a drift detector. Any other error
  // propagates verbatim (real schema regressions stay visible).
  private async invokeWithRetry(structured: StructuredModel, prompt: string): Promise<unknown> {
    try {
      return await structured.invoke(prompt)
    } catch {
      try {
        return await structured.invoke(prompt)
      } catch (err) {
        if (isEmptyStructuredOutput(err)) {
          throw new Error(
            'LLM returned an empty structured-output response (called the ' +
              'tool with `{}` arguments) — likely Anthropic API degradation. ' +
              'Re-run the Action once API capacity recovers.',
          )
        }
        throw err
      }
    }
  }
}

// Detect the specific LangChain structured-output failure where the LLM
// called the tool with an empty argument object. Matches the exact error
// shape `Failed to parse. Text: "{}"` so unrelated parse failures (real
// schema regressions, partial responses, malformed JSON) still propagate.
function isEmptyStructuredOutput(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.message.includes('Failed to parse') && err.message.includes('Text: "{}"')
}
