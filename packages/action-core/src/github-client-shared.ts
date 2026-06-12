import * as core from '@actions/core'
import * as github from '@actions/github'
import type { GitHub } from '@actions/github/lib/utils'
import { readDocsAtHeadViaGitTrees } from './doc-reader.js'
import type { DocFile, DocsReadResult, ReadDocsOptions } from './doc-reader.js'

// Story P3.9.2a (Lite/Full artifact split) — the SHARED half of the former
// apps/action github-client.ts. The two review-surface writers
// (postOrUpdateReview, postReviewComment) are Full-only and live in the Full
// artifact's github-client-full.ts. Function bodies here moved verbatim.

export type { DocFile, DocsReadResult, ReadDocsOptions }

export interface PrContext {
  owner: string
  repo: string
  pullNumber: number
  headSha: string
  baseSha: string
}

export interface ChangedFile {
  filename: string
  status: string
  patch?: string
}

type Octokit = InstanceType<typeof GitHub>

export function getPrContext(): PrContext {
  const { payload, repo } = github.context

  if (payload.pull_request) {
    return {
      owner: repo.owner,
      repo: repo.repo,
      pullNumber: payload.pull_request.number as number,
      headSha: payload.pull_request.head.sha as string,
      baseSha: payload.pull_request.base.sha as string,
    }
  }

  if (payload.issue?.pull_request && payload.comment) {
    const prUrl = payload.issue.pull_request.url as string
    return {
      owner: repo.owner,
      repo: repo.repo,
      pullNumber: payload.issue.number as number,
      headSha: '',
      baseSha: '',
      ...extractShasFromIssueComment(prUrl),
    }
  }

  throw new Error(
    `Unsupported event: expected pull_request or issue_comment on a PR, got ${github.context.eventName}`,
  )
}

export async function listChangedFiles(
  octokit: Octokit,
  ctx: PrContext,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = []
  let page = 1

  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.pullNumber,
      per_page: 100,
      page,
    })

    if (data.length === 0) {
      break
    }

    for (const file of data) {
      files.push({
        filename: file.filename,
        status: file.status,
        patch: file.patch,
      })
    }

    if (data.length < 100) {
      break
    }

    page++
  }

  return files
}

export async function getFileContent(
  octokit: Octokit,
  ctx: PrContext,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: ctx.owner,
      repo: ctx.repo,
      path,
      ref,
    })

    if (Array.isArray(data) || data.type !== 'file' || !data.content) {
      return null
    }

    return Buffer.from(data.content, 'base64').toString('utf-8')
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status: number }).status === 404
    ) {
      return null
    }
    throw error
  }
}

export async function readDocs(
  octokit: Octokit,
  ctx: PrContext,
  docScope: string[],
  options: ReadDocsOptions = {},
): Promise<DocsReadResult> {
  // v6.1 — walk at the PR head, not the merge-base. After Approve and Commit
  // splices doc updates onto the PR branch, the head ref carries those updates;
  // walking at base would re-detect the same drift forever (and would force
  // FR88f to keep creating new pending findings every re-run because section
  // anchors are LLM-non-deterministic). Reading at head closes that loop:
  // Approve and Commit -> head advances -> next walk sees the updated doc ->
  // PASS verdict -> Stream 4a auto-supersede -> review resolves.
  //
  // Story 3.12 (ADR-2026-06-01) — Full mode now reads via ONE recursive
  // git-trees call + the shared `isFileInDocScope` matcher (picomatch@4),
  // exactly as Lite mode does (Story P2.6). `docScope` is the canonical
  // `string[]` (multi-path/glob). The old per-directory `getContent` walk
  // (`readDocsFromPath`) is retired in this story.
  return readDocsAtHeadViaGitTrees(octokit, ctx.owner, ctx.repo, docScope, ctx.headSha, options)
}

// v6.0 thin top-level PR comment (Story 3.11). Uses issues.createComment /
// updateComment (NOT pulls.createReview) — replaces the pre-v6.0 Request
// Changes / Approve review primitive on success paths. Idempotent on `Bot`
// author + label-prefix marker — re-runs update the same comment in place.
//
// The hidden HTML marker (DELFINI_PR_COMMENT_MARKER) is appended to every
// v6.0 thin template body so the matcher can be specific without depending
// on visible body text. A foreign Bot whose comment happens to start with
// `**` (Dependabot, Renovate, etc.) is NOT matched because they don't carry
// the marker. The matcher uses `body.includes(marker)` not `startsWith` so
// the marker can ride at the end of the body without affecting layout.
//
// Pagination: caps at 5 pages (500 comments) before warn-and-create — same
// shape as postOrUpdateReview's 100-cap warn pattern. PRs with >500 comments
// are pathological; warn-and-create produces a benign duplicate at worst.
const PR_COMMENT_PAGINATION_PAGE_CAP = 5
const PR_COMMENT_PAGINATION_PER_PAGE = 100

// Hidden HTML marker — invisible in rendered markdown, byte-stable in source.
// Keep this constant in sync with the marker appended by emitStreamDecision.
export const DELFINI_PR_COMMENT_MARKER = '<!-- delfini-pr-comment -->'

export async function postOrUpdatePrComment(
  octokit: Octokit,
  ctx: PrContext,
  body: string,
  options: { marker: string },
): Promise<void> {
  let existingId: number | null = null
  let extraMatches = 0
  let pagesScanned = 0

  for (let page = 1; page <= PR_COMMENT_PAGINATION_PAGE_CAP; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.pullNumber,
      per_page: PR_COMMENT_PAGINATION_PER_PAGE,
      page,
    })
    pagesScanned += 1

    const matches = data.filter(
      (c) => c.user?.type === 'Bot' && (c.body ?? '').includes(options.marker),
    )
    if (matches.length > 0) {
      if (existingId === null) {
        existingId = matches[0].id
        extraMatches = matches.length - 1
      } else {
        extraMatches += matches.length
      }
      // Continue paginating to count duplicates across pages for the warn-on-many path.
      // Stop early once we've scanned enough to be confident — first match is the
      // one we'll update; extras just produce a warning.
      if (data.length < PR_COMMENT_PAGINATION_PER_PAGE) break
      continue
    }
    if (data.length < PR_COMMENT_PAGINATION_PER_PAGE) break
  }

  if (extraMatches > 0) {
    core.warning(
      `Delfini: ${extraMatches + 1} matching Delfini PR comments found — updating the first; consider manual cleanup of duplicates.`,
    )
  }

  if (
    existingId === null &&
    pagesScanned === PR_COMMENT_PAGINATION_PAGE_CAP
  ) {
    core.warning(
      `Delfini: PR comment scan capped at ${PR_COMMENT_PAGINATION_PAGE_CAP * PR_COMMENT_PAGINATION_PER_PAGE} comments — idempotency may misfire on this PR.`,
    )
  }

  if (existingId !== null) {
    try {
      await octokit.rest.issues.updateComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: existingId,
        body,
      })
      return
    } catch (error) {
      // 404 = comment was deleted between listComments and updateComment
      // (manual delete by reviewer, race with another tool). Fall through to
      // createComment so the PR doesn't end up with no Delfini comment at all.
      if (isHttpStatus(error, 404)) {
        core.warning(
          `Delfini: PR comment #${existingId} disappeared between scan and update — creating a fresh comment.`,
        )
      } else {
        throw error
      }
    }
  }

  await octokit.rest.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.pullNumber,
    body,
  })
}

function isHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: number }).status === status
  )
}

// 403 (read-only token) and 404 (resource not visible) both signal the
// workflow lacks permission to write a check or PR comment — typically a fork
// PR. Callers tolerate these (warn + continue) rather than crashing the run.
// Story P2.2 (AC7) — moved here from pipeline.ts so the Full and Lite
// pipelines share one predicate.
export function isForbiddenError(error: unknown): boolean {
  return isHttpStatus(error, 403) || isHttpStatus(error, 404)
}

export async function createCheckStatus(
  octokit: Octokit,
  ctx: PrContext,
  conclusion: 'in_progress' | 'success' | 'failure' | 'neutral' | 'action_required',
  title: string,
  summary: string,
  detailsUrl?: string,
): Promise<void> {
  // Conditional spread keeps the request body free of an explicit
  // `details_url: undefined` — Octokit treats absent and `undefined` fields
  // differently for some endpoints, and we want GitHub's default Details
  // affordance (the built-in check_run page) when no URL is provided.
  //
  // 'in_progress' is the sentinel for "attention needed, static yellow icon":
  // we use the legacy Commit Statuses API with state='pending' because that
  // renders a STATIC yellow dot (no spinner). The check_runs API has no
  // conclusion that renders static yellow — status='in_progress' animates,
  // conclusion='action_required' renders red, and conclusion='neutral' renders
  // grey. Chromatic and other "needs review" integrations also use commit
  // statuses for this exact reason. The 140-char description cap is enforced
  // by GitHub; truncate defensively so a long title doesn't 422.
  if (conclusion === 'in_progress') {
    const description = title.length > 140 ? title.slice(0, 139) + '…' : title
    await octokit.rest.repos.createCommitStatus({
      owner: ctx.owner,
      repo: ctx.repo,
      sha: ctx.headSha,
      state: 'pending',
      context: 'Delfini Docs Drift Check',
      description,
      ...(detailsUrl !== undefined ? { target_url: detailsUrl } : {}),
    })
    return
  }
  await octokit.rest.checks.create({
    owner: ctx.owner,
    repo: ctx.repo,
    head_sha: ctx.headSha,
    name: 'Delfini Docs Drift Check',
    status: 'completed',
    conclusion,
    output: { title, summary },
    ...(detailsUrl !== undefined ? { details_url: detailsUrl } : {}),
  })
}

function extractShasFromIssueComment(_prUrl: string): Partial<PrContext> {
  // SHAs are not available on issue_comment events directly.
  // The caller must fetch them from the PR API after context creation.
  // Returning empty strings signals that SHAs need to be resolved.
  return {}
}
