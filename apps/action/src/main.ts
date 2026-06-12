import * as core from '@actions/core'
import * as github from '@actions/github'
import { readPipelineInputs } from '@delfini/action-core'

import { runLitePipeline } from './lite-pipeline.js'

// Story P3.9.2a (Lite/Full artifact split) — the slim LITE-ONLY entry. FR134
// runtime mode selection is retired: this artifact carries ONLY the Lite
// pipeline; the Full (hosted-platform) pipeline lives in a separate artifact
// that ships with the Delfini platform. There is NO mode branch here.

// AC4 hard-fail misconfiguration guard. A workspace token reaching this
// artifact means the consumer wanted Full mode (hosted Delfini platform) —
// silently downgrading to a Lite run would hand a paying Full customer a
// green check that looks like a platform-backed verdict. Fail loud instead.
//
// Detection covers BOTH supply paths (AC4.1):
//   - the legacy `delfini_workspace_token` input: dropped from action.yml, but
//     an undeclared `with:` entry still materialises as
//     INPUT_DELFINI_WORKSPACE_TOKEN on the runner (with an "Unexpected
//     input(s)" warning), so core.getInput() keeps working for the guard;
//   - the DELFINI_WORKSPACE_TOKEN env var.
// Whitespace-only counts as absent — the retired selectPipelineMode trim rule
// (an empty `${{ secrets.X }}` expression resolves to nothing).
function detectWorkspaceToken(): boolean {
  // core.getInput trims by default; trim the env var to match.
  const tokenInput = core.getInput('delfini_workspace_token')
  const tokenEnv = (process.env.DELFINI_WORKSPACE_TOKEN ?? '').trim()
  return tokenInput !== '' || tokenEnv !== ''
}

const WORKSPACE_TOKEN_GUARD_MESSAGE =
  'A Delfini workspace token was supplied (delfini_workspace_token input or ' +
  'DELFINI_WORKSPACE_TOKEN env var), but this is the standalone (Lite) Delfini ' +
  'action — it does not pair with the hosted Delfini platform and will not ' +
  'silently downgrade to a standalone run. Full mode ships with the Delfini ' +
  'platform: see the Delfini platform documentation for installing the ' +
  'platform-paired action. To run this standalone action, remove the token ' +
  'from your workflow.'

export async function run(): Promise<void> {
  try {
    // Guard FIRST — before reading inputs or doing any pipeline work (AC4).
    if (detectWorkspaceToken()) {
      core.setFailed(WORKSPACE_TOKEN_GUARD_MESSAGE)
      return
    }

    const inputs = readPipelineInputs()

    core.info('Delfini action started (standalone)')
    core.info(`  doc_scope: ${inputs.docScope}`)
    core.info(`  enforcement: ${inputs.enforcement}`)

    if (!inputs.githubToken) {
      core.warning('GITHUB_TOKEN not set; cannot access GitHub API. Exiting neutrally.')
      return
    }

    const octokit = github.getOctokit(inputs.githubToken)

    await runLitePipeline(inputs, { octokit })
  } catch (error) {
    // Per Story 3.2 AC: unexpected crashes surface via setFailed. Expected
    // failures (LLM / GitHub API errors) are caught inside runLitePipeline and
    // routed to the neutral-check path instead.
    const message = error instanceof Error ? error.message : String(error)
    core.setFailed(`Delfini crashed unexpectedly: ${message}`)
  }
}

// Auto-run as the GitHub Action entrypoint, but not when imported by Vitest.
// Guard on Vitest's own `VITEST` sentinel rather than `NODE_ENV` — a consumer
// workflow that sets `NODE_ENV=test` (e.g. a job-level env applied to every
// step) must not silently disable the action.
if (!process.env.VITEST) {
  run()
}
