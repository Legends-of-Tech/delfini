import * as core from '@actions/core'
import * as github from '@actions/github'

import { buildUnifiedDiff } from './diff-builder.js'
import type { ChangedFile, PrContext } from './github-client-shared.js'
import type { AnalysisInput, DocFile } from '@delfini/drift-engine'
import { filterDiff } from '@delfini/drift-engine'

export interface BuildAnalysisInputOptions {
  /**
   * Story P3.7.2 / FR151 — deterministic diff pre-filter. When `true`, drops
   * lockfile/generated/vendored/fixture paths plus pure whitespace-only and
   * import-only hunks from the diff before it lands in `AnalysisInput`.
   * Default off — the assembled `AnalysisInput.diff` is byte-identical to
   * the pre-story behaviour (NFR49(b) parity), and the NFR44 Action pipeline
   * test stays green by construction.
   *
   * When the filter runs, a single `core.info` summary line is emitted with
   * the per-category drop counts — no per-path log spam.
   */
  enableDiffPreFilter?: boolean
}

// Story P2.2 (AC6) — extracted verbatim from pipeline.ts. The Lite pipeline
// reuses this without importing pipeline.ts as a value, which would pull the
// FR88g/FR88d module graph (config-client / stream-routing / intake-client)
// into lite-pipeline.ts's runtime graph and break the epic's "Lite never calls
// FR88g/FR88d" invariant. `buildUnifiedDiff` + the `@actions/github` context
// carry no FR88d coupling, so this is a clean shared module.
export function buildAnalysisInput(
  ctx: PrContext,
  changedFiles: ChangedFile[],
  docs: DocFile[],
  options: BuildAnalysisInputOptions = {},
): AnalysisInput {
  let diff = buildUnifiedDiff(changedFiles)

  if (options.enableDiffPreFilter === true) {
    const result = filterDiff(diff)
    diff = result.keptDiff
    // One info line; no per-path logs to keep a large lockfile churn from
    // flooding the Action log. Counts only — sufficient to diagnose under-
    // or over-aggressive filtering without leaking diff content.
    //
    // Count BOTH droppedPaths and droppedHunks per reason: a file whose every
    // hunk is whitespace-only / import-only is promoted to a path-level drop
    // with that reason, so a path-bucket-only summary would render whole-file
    // whitespace/import drops invisible (AC3 — drops must never be silently
    // discarded).
    const counts = countByReason([
      ...result.droppedPaths.map((p) => p.reason),
      ...result.droppedHunks.map((h) => h.reason),
    ])
    core.info(
      `Delfini diff pre-filter dropped: lockfiles=${counts.lockfile} ` +
        `generated=${counts.generated} vendored=${counts.vendored} ` +
        `fixtures=${counts.fixture} whitespace=${counts['whitespace-only']} ` +
        `import=${counts['import-only']}`,
    )
  }

  const prTitle = (github.context.payload.pull_request?.title as string | undefined) ?? ''

  return {
    diff,
    docs,
    prMetadata: {
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.pullNumber,
      headSha: ctx.headSha,
      baseSha: ctx.baseSha,
      title: prTitle,
    },
  }
}

type DropReasonKey =
  | 'lockfile'
  | 'generated'
  | 'vendored'
  | 'fixture'
  | 'whitespace-only'
  | 'import-only'

function countByReason(reasons: DropReasonKey[]): Record<DropReasonKey, number> {
  const out: Record<DropReasonKey, number> = {
    lockfile: 0,
    generated: 0,
    vendored: 0,
    fixture: 0,
    'whitespace-only': 0,
    'import-only': 0,
  }
  for (const r of reasons) out[r]++
  return out
}
