import * as core from '@actions/core'

import {
  DELFINI_PR_COMMENT_MARKER,
  buildAnalysisInput,
  classifyPr,
  createCheckStatus,
  createOrchestrator,
  getPrContext,
  isForbiddenError,
  listChangedFiles,
  postOrUpdatePrComment,
  readDocsAtHeadViaGitTrees,
} from '@delfini/action-core'
import type { PipelineDeps, PipelineInputs, PrContext, SmartSkipResult } from '@delfini/action-core'
import { isFileInDocScope } from '@delfini/drift-engine'
import { formatLiteComment } from './lite-comment-formatter.js'

// Lite pipeline (FR135) — standalone local analysis with NO Delfini platform:
// no FR88g doc-scope fetch, no FR88d intake POST, no four-stream routing, no
// `pending_review_exists` predicate. Doc scope comes solely from
// `inputs.docScope` (the `doc_scope` action input). The GitHub check state
// derives directly from the analysis verdict and the rich PR comment is the
// only finding surface.
//
// Import-graph invariant (Story P3.9.2a) — absence-by-construction: the
// FR88g/FR88d modules (`config-client.ts` / `stream-routing.ts` /
// `intake-client.ts`) physically do not exist in this artifact's tree — they
// live in the Full artifact. This module consumes only the shared core
// (`@delfini/action-core`); the release-time bundle scan (AC7) tripwires any
// Full-only runtime marker that ever reaches the built Lite dist.

const LITE_CHECK = {
  passTitle: 'Delfini — PASS',
  smartSkipTitle: 'Delfini — PASS (Smart-skipped)',
  driftTitle: 'Delfini — Drift detected',
  errorTitle: 'Delfini — Unable to Complete Analysis',
} as const

export async function runLitePipeline(
  inputs: PipelineInputs,
  deps: PipelineDeps,
): Promise<void> {
  const { octokit } = deps

  // Step 1 — PR context guard. An unsupported event (not a PR) is not an
  // error: warn and return with no check written, mirroring runPipeline.
  let ctx: PrContext
  try {
    ctx = getPrContext()
  } catch (error) {
    core.warning(
      `Lite pipeline skipped: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  // Step 2 — resolve the orchestrator (a caller may inject a fake for tests).
  const orchestrator = deps.orchestrator ?? createOrchestrator()

  // Steps 3-8 — analysis. Any throw here routes to a neutral check + error
  // comment (AC7). There is deliberately no top-level catch-all: a throw from
  // the catch handler's own emit bubbles to main.ts's `setFailed` wrapper.
  try {
    const rawChangedFiles = await listChangedFiles(octokit, ctx)

    // Step 3a — ignore_code_scope. Drop changed files the dev marked as
    // out-of-bounds for drift (same picomatch@4 predicate the CLI config and
    // the engine use → parity by construction). Filtering the FILE ARRAY once,
    // here, makes an ignored file uniformly "as if unchanged": it feeds both
    // smart-skip and the analysis diff. (The CLI achieves the same drop on its
    // diff string via `filterDiff({ ignorePaths })`; the decision predicate is
    // identical, only the mechanism differs by diff shape.)
    const ignoreCodeScope = inputs.ignoreCodeScope ?? []
    const changedFiles =
      ignoreCodeScope.length > 0
        ? rawChangedFiles.filter((file) => !isFileInDocScope(file.filename, ignoreCodeScope))
        : rawChangedFiles
    const ignoredCount = rawChangedFiles.length - changedFiles.length
    if (ignoredCount > 0) {
      core.info(`Lite: ignored ${ignoredCount} changed file(s) via ignore_code_scope.`)
    }

    const changedPaths = changedFiles.map((file) => file.filename)

    // Step 4 — smart-skip. Both FR57 legs apply; scope is `inputs.docScope`,
    // never FR88g. A skip is unconditionally a clean PASS in Lite mode. Runs on
    // the post-ignore file set so a PR touching only ignored code smart-skips.
    const skip = classifyPr(changedPaths, { docScope: inputs.docScope })
    if (skip.shouldSkip) {
      core.info(`Lite: smart-skipped — ${skip.reason}`)
      await emitLiteResult(octokit, ctx, {
        conclusion: 'success',
        checkTitle: LITE_CHECK.smartSkipTitle,
        checkSummary: 'No business-logic changes detected.',
        commentBody: renderSmartSkipBody(skip),
      })
      return
    }

    // Step 5 — read docs at the PR head ref from the `docs_path` scope.
    // Story P2.6: one recursive git-trees call + shared isFileInDocScope
    // matcher + matched-blob fetch. Story 3.12 retired the per-directory
    // getContent walk (`readDocsFromPath`) for BOTH modes — Full mode reads
    // via the same git-trees path through github-client.ts:readDocs.
    const { included: docs } = await readDocsAtHeadViaGitTrees(
      octokit,
      ctx.owner,
      ctx.repo,
      inputs.docScope,
      ctx.headSha,
    )

    // Steps 6 + 7 — build the analysis input and run the orchestrator.
    const analysisInput = buildAnalysisInput(ctx, changedFiles, docs, {
      enableDiffPreFilter: inputs.enableDiffPreFilter,
    })
    core.info(
      `Lite: analysing PR #${ctx.pullNumber} — ${changedFiles.length} changed file(s), ${docs.length} doc(s).`,
    )
    const result = await orchestrator.analyze(analysisInput)

    // Step 8 — verdict. Drift OR additive findings flip to yellow; the
    // orchestrator emits no clarifications, so the verdict is PASS or drift.
    const additions = result.additions ?? []
    const findingCount = result.contradictions.length + additions.length

    // Story P2.6: serialise the multi-entry scope for display in the rich
    // PR comment. `formatLiteComment`'s `docScope` is `string` for display
    // only (template literal `\`${docScope}\``); joining preserves the
    // formatter's signature and snapshot tests (P2.3 AC9 surface invariant).
    const docScopeDisplay = inputs.docScope.join(', ')

    if (findingCount > 0) {
      core.info(`Lite: drift detected — ${findingCount} finding(s).`)
      await emitLiteResult(octokit, ctx, {
        // `in_progress` is the static-yellow sentinel (createCommitStatus
        // state: 'pending') — NOT `action_required`, which renders red.
        conclusion: 'in_progress',
        checkTitle: LITE_CHECK.driftTitle,
        checkSummary: `${findingCount} ${findingCount === 1 ? 'finding' : 'findings'} — see the Delfini PR comment.`,
        commentBody: formatLiteComment({
          kind: 'findings',
          result,
          docScope: docScopeDisplay,
        }),
      })
      return
    }

    core.info('Lite: PASS — no drift detected.')
    await emitLiteResult(octokit, ctx, {
      conclusion: 'success',
      checkTitle: LITE_CHECK.passTitle,
      checkSummary: `No drift detected across ${docs.length} document${docs.length === 1 ? '' : 's'}.`,
      commentBody: formatLiteComment({ kind: 'pass', docs, docScope: docScopeDisplay }),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    core.warning(`Lite pipeline error: ${reason}`)
    await emitLiteResult(octokit, ctx, {
      conclusion: 'neutral',
      checkTitle: LITE_CHECK.errorTitle,
      checkSummary: reason,
      commentBody: renderErrorBody(reason),
    })
  }
}

interface LiteEmit {
  conclusion: 'success' | 'in_progress' | 'neutral'
  checkTitle: string
  checkSummary: string
  commentBody: string
}

// Posts the idempotent rich PR comment, then writes the GitHub check. Both
// writes tolerate HTTP 403/404 (fork PRs lack `checks: write` /
// `pull-requests: write`) — warn and continue rather than crashing the run.
// Other errors bubble. There is no NFR42 failure-open: Lite mode has no
// platform to fail-open against.
async function emitLiteResult(
  octokit: PipelineDeps['octokit'],
  ctx: PrContext,
  emit: LiteEmit,
): Promise<void> {
  // The hidden marker is appended by the pipeline, not the formatter — one
  // Delfini comment per PR, updated in place across re-runs.
  const bodyWithMarker = `${emit.commentBody}\n\n${DELFINI_PR_COMMENT_MARKER}`

  try {
    await postOrUpdatePrComment(octokit, ctx, bodyWithMarker, {
      marker: DELFINI_PR_COMMENT_MARKER,
    })
  } catch (error) {
    if (isForbiddenError(error)) {
      core.warning(
        'Cannot post Delfini PR comment — workflow needs permissions: pull-requests: write. Skipping comment; check status will still be attempted.',
      )
    } else {
      throw error
    }
  }

  try {
    await createCheckStatus(octokit, ctx, emit.conclusion, emit.checkTitle, emit.checkSummary)
  } catch (error) {
    if (isForbiddenError(error)) {
      core.warning(
        'Check status could not be created (missing checks:write permission — likely a fork PR). PR comment was attempted above.',
      )
      return
    }
    throw error
  }
}

// Inline plain-text smart-skip body — NOT a rich per-finding card. The
// LiteCommentInput union has only `findings` and `pass` arms; smart-skip and
// hard-error bodies are rendered here. Push-only: no `/delfini` re-run hint.
function renderSmartSkipBody(skip: SmartSkipResult): string {
  return [
    '## Delfini — PASS (Smart-skipped)',
    '',
    'No business-logic changes detected — skipped doc-drift analysis.',
    '',
    `Changed files: ${skip.reason}`,
  ].join('\n')
}

// Inline plain-text hard-error body. Never silent: Lite mode either analyses
// successfully or posts a neutral check with a clear message.
function renderErrorBody(reason: string): string {
  return [
    '## Delfini — Unable to Complete Analysis',
    '',
    `Delfini could not analyse this PR: ${reason}.`,
    '',
    'This check is neutral — it does not block or approve this PR.',
  ].join('\n')
}
