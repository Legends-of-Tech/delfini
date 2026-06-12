import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// =====================================================================
// Story P3.9.2a (AC5.5, Lite half) — the slim Lite-only entry suite.
//
// FR134 runtime mode selection is retired: there is no mode branch and no
// mode.ts. What this entry owns is (a) the AC4 hard-fail misconfiguration
// guard (workspace token present → setFailed, never a silent Lite downgrade),
// (b) the GITHUB_TOKEN-missing neutral exit, and (c) the dispatch into
// runLitePipeline. readPipelineInputs stays REAL (from @delfini/action-core)
// so the doc_scope/default semantics are exercised through the entry.
// =====================================================================

vi.mock('@actions/github', () => ({
  getOctokit: vi.fn(() => ({ rest: {} })),
}))

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
}))

vi.mock('../lite-pipeline.js', () => ({
  runLitePipeline: vi.fn(),
}))

import * as core from '@actions/core'

import { runLitePipeline } from '../lite-pipeline.js'
import { run } from '../main.js'

beforeEach(() => {
  vi.mocked(core.info).mockReset()
  vi.mocked(core.warning).mockReset()
  vi.mocked(core.setFailed).mockReset()
  vi.mocked(core.getInput).mockReset()
  vi.mocked(core.getInput).mockReturnValue('')
  vi.mocked(runLitePipeline).mockReset()
  // GITHUB_TOKEN must be present so run() reaches the dispatch point rather
  // than the empty-token early return (overridden per-test where relevant).
  vi.stubEnv('GITHUB_TOKEN', 'gh-token')
  vi.stubEnv('DELFINI_WORKSPACE_TOKEN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('run() — Lite entry dispatch', () => {
  it('no workspace token → runLitePipeline called once, no setFailed', async () => {
    await run()

    expect(runLitePipeline).toHaveBeenCalledTimes(1)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('passes the real readPipelineInputs output (docScope default) into runLitePipeline', async () => {
    await run()

    const [inputs] = vi.mocked(runLitePipeline).mock.calls[0]
    // Code-side default: omitted doc_scope → ['docs'] (normalizeDocScope
    // strips the trailing slash). FR137 default semantics unchanged (AC4.2).
    expect(inputs.docScope).toEqual(['docs'])
    expect(inputs.enforcement).toBe('warning')
    expect(inputs.githubToken).toBe('gh-token')
  })

  it('GITHUB_TOKEN missing → warns and exits neutrally without dispatching', async () => {
    vi.stubEnv('GITHUB_TOKEN', '')

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_TOKEN not set'),
    )
    expect(runLitePipeline).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})

describe('run() — AC4 hard-fail misconfiguration guard', () => {
  it('DELFINI_WORKSPACE_TOKEN env var set → setFailed, runLitePipeline NOT called', async () => {
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', 'ws-secret')

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(runLitePipeline).not.toHaveBeenCalled()
  })

  it('legacy delfini_workspace_token input set (undeclared with: entry) → setFailed', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'delfini_workspace_token' ? 'input-ws-secret' : '',
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(runLitePipeline).not.toHaveBeenCalled()
  })

  it('guard message points to the Delfini platform docs, never a public Full action', async () => {
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', 'ws-secret')

    await run()

    const message = String(vi.mocked(core.setFailed).mock.calls[0][0])
    expect(message).toContain('standalone (Lite) Delfini action')
    expect(message).toContain('Delfini platform documentation')
    expect(message).toContain('will not silently downgrade')
  })

  it('whitespace-only env token counts as absent → Lite runs (retired selectPipelineMode trim rule)', async () => {
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', '   \t ')

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(runLitePipeline).toHaveBeenCalledTimes(1)
  })

  it('the guard fires before any pipeline work — even before the GITHUB_TOKEN check', async () => {
    vi.stubEnv('GITHUB_TOKEN', '')
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', 'ws-secret')

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    // The GITHUB_TOKEN-missing warning never fired — the guard aborted first.
    expect(core.warning).not.toHaveBeenCalled()
    expect(runLitePipeline).not.toHaveBeenCalled()
  })
})
