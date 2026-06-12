import * as core from '@actions/core'
import type { GitHub } from '@actions/github/lib/utils'
import { normalizeDocScope } from '@delfini/drift-engine'

import type { AnalysisOrchestrator } from './ports/orchestrator.js'

// Story P3.9.2a (Lite/Full artifact split) — `readPipelineInputs` and the
// hoisted `PipelineInputs` / `PipelineDeps` / `Enforcement` types, extracted
// VERBATIM out of the former apps/action pipeline.ts. Both slim per-artifact
// entries (the public Lite action and the Full action) read their inputs
// through this ONE reader, so the FR137 doc_scope semantics (delimited-string
// split, normalizeDocScope, the code-side ['docs/'] default, the
// collapse-to-empty warning) can never silently diverge between artifacts.

type Octokit = InstanceType<typeof GitHub>

export type Enforcement = 'required' | 'warning'

export interface PipelineInputs {
  // ADR-2026-06-01 / Story P2.6 — multi-path doc-scope. Canonical type is
  // `string[]`; each entry is a directory (recursive `.md`), a single file, or
  // a picomatch@4 glob. Lite mode parses `docs_path` as a newline/comma-
  // delimited list and normalizes via `normalizeDocScope`. Full mode wraps
  // `config.docScope` (still a `string` until Story 3.12 lands `string[]` on
  // FR88g behind the dual-read window) as `[config.docScope]` at every
  // `string[]`-shaped call site — a type-shim that preserves byte-identical
  // Full-mode behaviour.
  docScope: string[]
  enforcement: Enforcement
  githubToken: string
  /**
   * Story P3.7.2 / FR151 — opt-in diff pre-filter. Default `false` — the
   * assembled analysis input is byte-identical to the pre-story baseline.
   * Optional in the type so test fixtures that build a minimal PipelineInputs
   * keep compiling; `readPipelineInputs` always sets it explicitly.
   */
  enableDiffPreFilter?: boolean
}

export interface PipelineDeps {
  octokit: Octokit
  orchestrator?: AnalysisOrchestrator
}

export function readPipelineInputs(): PipelineInputs {
  // Story P2.7 — Lite-mode doc-scope input is `doc_scope` (canonical name
  // shared with the drift-engine algebra, CLI, FR88g API response, DB column,
  // and Web settings). ADR-2026-06-01 / Story P2.6 — `doc_scope` accepts a
  // newline- or comma-delimited list (action.yml inputs are strings only). A
  // single bare path still works. The split list is fed through
  // `normalizeDocScope` from `@delfini/drift-engine` (POSIX, trim, trailing-
  // slash strip, dedupe, `./` / `..` resolution all handled there — do NOT
  // re-implement here).
  //
  // The default `['docs/']` keeps Lite's user-observable default identical to
  // pre-P2.6 (single string `'docs/'`) — only the type changes. The defensive
  // collapse-to-empty fallback covers the user-types-",,,," case so an
  // accidentally-empty normalized list never silently turns into a zero-scope
  // run (which would skip every PR via FR57(b)).
  const rawDocScope = core.getInput('doc_scope')
  const entries = rawDocScope.length > 0 ? rawDocScope.split(/[\n,]/) : ['docs/']
  const normalized = normalizeDocScope(entries)
  // A non-empty input that normalises to nothing (e.g. "   ", ",,," , "\n\n")
  // is almost certainly a typo, not an intentional default request. Warn so the
  // operator can tell "I omitted doc_scope → default" apart from "my doc_scope
  // collapsed → default" before silently analysing `docs/` (Story P2.6).
  if (rawDocScope.length > 0 && normalized.length === 0) {
    core.warning(
      `doc_scope "${rawDocScope}" contains no valid doc-scope entries after ` +
        'normalisation — falling back to the default "docs/". Check for stray ' +
        'delimiters or whitespace-only entries.',
    )
  }
  // Fallback flows through `normalizeDocScope` so the collapse-to-default path
  // yields the exact same value (`['docs']`) as the omitted-input path — no
  // trailing-slash inconsistency between the two default routes.
  const docScope = normalized.length > 0 ? normalized : normalizeDocScope(['docs/'])

  const rawEnforcement = (core.getInput('enforcement') || 'warning').toLowerCase()
  const enforcement: Enforcement = rawEnforcement === 'required' ? 'required' : 'warning'
  const githubToken = process.env.GITHUB_TOKEN ?? core.getInput('github_token')
  // Story P3.7.2 / FR151 — `enable_diff_prefilter` action.yml input. Default
  // false: any value other than the literal "true" (case-insensitive) leaves
  // the gate off so the pre-story behaviour is the path of least resistance.
  const enableDiffPreFilter = core.getInput('enable_diff_prefilter').toLowerCase() === 'true'

  return { docScope, enforcement, githubToken, enableDiffPreFilter }
}
