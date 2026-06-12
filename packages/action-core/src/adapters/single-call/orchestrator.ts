import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as core from '@actions/core'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  analysisSchema,
  buildPrompt,
  validateAndReconcile,
} from '@delfini/drift-engine'
import type { AnalysisInput, AnalysisResult } from '@delfini/drift-engine'
import type { AnalysisOrchestrator } from '../../ports/orchestrator.js'
import { createChatModel } from './model.js'

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

  constructor(model: BaseChatModel = createChatModel()) {
    this.model = model
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const prompt = buildPrompt(input, loadTemplate())
    const structured = this.model.withStructuredOutput(analysisSchema, {
      name: 'AnalysisResult',
    })

    let result: unknown
    try {
      result = await structured.invoke(prompt)
    } catch {
      try {
        result = await structured.invoke(prompt)
      } catch (err) {
        // When the LLM call exhausts both attempts, surface a CLEAN message
        // instead of letting LangChain's raw Zod blob bubble all the way to
        // the PR comment. The pipeline's outer `catch` still emits a neutral
        // `action_required` check via NFR42 — silent PASS would be wrong for
        // a drift detector (a degraded LLM that calls the tool with `{}` is
        // indistinguishable from a clean PR from the outside, and the user
        // has no way to know analysis didn't actually run).
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

    // Single composed reconciliation pipeline (line-number grounding,
    // actionability filter, overlap dedup, additive-anchor grounding) imported
    // from `@delfini/drift-engine`. `core.warning` surfaces drops in the
    // Actions log so silent-drop rate stays observable.
    return validateAndReconcile(result, input.docs, (message) => core.warning(message))
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
