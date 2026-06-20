import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    repo: { owner: 'acme', repo: 'widgets' },
    payload: {
      action: 'synchronize',
      pull_request: {
        number: 7,
        title: 'Add batch endpoint',
        head: { sha: 'head-sha' },
        base: { sha: 'base-sha' },
      },
    },
  },
  getOctokit: vi.fn(),
}))

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
}))

// Story P3.9.2a (AC5.2) — the former vi.mock tripwires on ../config-client.js
// and ../intake-client.js are DROPPED: the FR88g/FR88d modules physically do
// not exist in this artifact's tree any more (absence-by-construction). The
// release-time bundle scan (AC7) now owns the no-platform-code invariant.

// formatLiteComment mocked so the verdict -> comment-kind routing can be
// asserted at the call site. P2.3 owns the formatter's own snapshot tests.
vi.mock('../lite-comment-formatter.js', () => ({
  formatLiteComment: vi.fn(() => 'FORMATTED-LITE-BODY'),
}))

import * as core from '@actions/core'
import * as github from '@actions/github'

import { formatLiteComment } from '../lite-comment-formatter.js'
import { runLitePipeline } from '../lite-pipeline.js'
import type { AnalysisOrchestrator, PipelineDeps } from '@delfini/action-core'
import type { AnalysisInput, AnalysisResult } from '@delfini/drift-engine'

interface OctokitStub {
  rest: {
    pulls: { listFiles: ReturnType<typeof vi.fn> }
    repos: {
      getContent: ReturnType<typeof vi.fn>
      createCommitStatus: ReturnType<typeof vi.fn>
    }
    checks: { create: ReturnType<typeof vi.fn> }
    issues: {
      listComments: ReturnType<typeof vi.fn>
      createComment: ReturnType<typeof vi.fn>
      updateComment: ReturnType<typeof vi.fn>
    }
    git: {
      getTree: ReturnType<typeof vi.fn>
    }
  }
}

function makeOctokit(): OctokitStub {
  return {
    rest: {
      pulls: { listFiles: vi.fn().mockResolvedValue({ data: [] }) },
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: [] }),
        createCommitStatus: vi.fn().mockResolvedValue({}),
      },
      checks: { create: vi.fn().mockResolvedValue({}) },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
      },
      // Story P2.6 — Lite reader is `readDocsViaGitTrees`. Default-mock the
      // tree to empty so the existing tests' analysis path runs with zero
      // docs (the orchestrator stub never reads `docs` content).
      git: {
        getTree: vi.fn().mockResolvedValue({ data: { tree: [], truncated: false } }),
      },
    },
  }
}

function deps(octokit: OctokitStub, orchestrator?: AnalysisOrchestrator): PipelineDeps {
  return { octokit: octokit as unknown as PipelineDeps['octokit'], orchestrator }
}

class FakeOrchestrator implements AnalysisOrchestrator {
  public callCount = 0
  public lastInput: AnalysisInput | undefined
  constructor(private readonly result: AnalysisResult) {}
  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    this.callCount += 1
    this.lastInput = input
    return this.result
  }
}

class ThrowingOrchestrator implements AnalysisOrchestrator {
  public callCount = 0
  constructor(private readonly err: Error) {}
  async analyze(): Promise<AnalysisResult> {
    this.callCount += 1
    throw this.err
  }
}

function passResult(): AnalysisResult {
  return { contradictions: [], additions: [], rawConfidence: 1 }
}

function contradictionResult(): AnalysisResult {
  return {
    contradictions: [
      {
        targetDocPath: 'docs/arch.md',
        targetSection: '3.2 Batch API',
        targetLineStart: 114,
        targetLineEnd: 114,
        whatChanged: 'Single-item endpoint introduced.',
        whatContradicts: 'Section 3.2 describes the batch endpoint.',
        proposedReplacement: 'Section 3.2 now describes the single-item endpoint.',
        severity: 'High',
        confidence: 4,
        quotedDocText: 'verbatim doc quote',
      },
    ],
    additions: [],
    rawConfidence: 0.8,
  }
}

function mockListFiles(octokit: OctokitStub, filenames: string[]): void {
  octokit.rest.pulls.listFiles.mockResolvedValue({
    data: filenames.map((filename) => ({
      filename,
      status: 'modified',
      patch: '@@ -1 +1 @@\n-a\n+b',
    })),
  })
}

// Story P2.6 — docScope is `string[]`. The default `'docs/'` is normalized to
// `['docs']` by `readPipelineInputs`; tests pass the post-normalize form
// directly so the array-shape contract is exercised end-to-end.
const LITE_INPUTS = {
  docScope: ['docs'] as string[],
  enforcement: 'warning' as const,
  githubToken: 't',
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(github.context as unknown as { eventName: string }).eventName = 'pull_request'
  ;(github.context as unknown as { payload: Record<string, unknown> }).payload = {
    action: 'synchronize',
    pull_request: {
      number: 7,
      title: 'Add batch endpoint',
      head: { sha: 'head-sha' },
      base: { sha: 'base-sha' },
    },
  }
})

describe('runLitePipeline', () => {
  it('PASS verdict — green check via checks.create + a pass comment with the marker', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(1)
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled()
    expect(formatLiteComment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pass', docScope: 'docs' }),
    )
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(octokit.rest.issues.createComment.mock.calls[0][0].body).toContain(
      '<!-- delfini-pr-comment -->',
    )
  })

  it('drift verdict — static-yellow commit status (state: pending), no checks.create, findings comment', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    const orchestrator = new FakeOrchestrator(contradictionResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(1)
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledTimes(1)
    expect(octokit.rest.repos.createCommitStatus.mock.calls[0][0].state).toBe('pending')
    expect(octokit.rest.checks.create).not.toHaveBeenCalled()
    expect(formatLiteComment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'findings', docScope: 'docs' }),
    )
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  it('smart-skip FR57(a) — structurally-uninteresting changes skip analysis, green check', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['package.json', 'pnpm-lock.yaml'])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(0)
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(formatLiteComment).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment.mock.calls[0][0].body).toContain('Smart-skipped')
  })

  it('smart-skip FR57(b) — docs-only-in-scope changes skip analysis, green check', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['docs/architecture.md', 'docs/intro.md'])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(0)
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(octokit.rest.issues.createComment.mock.calls[0][0].body).toContain('Smart-skipped')
  })

  it('ignore_code_scope — a PR touching only ignored code smart-skips to a clean PASS', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/generated/client.ts', 'src/generated/types.ts'])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(
      { ...LITE_INPUTS, ignoreCodeScope: ['src/generated/**'] },
      deps(octokit, orchestrator),
    )

    // Both changed files are ignored → nothing reaches smart-skip's
    // business-logic check → clean PASS, orchestrator never runs.
    expect(orchestrator.callCount).toBe(0)
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('ignored 2 changed file(s) via ignore_code_scope'),
    )
  })

  it('ignore_code_scope — drops ignored files from the analysed diff, keeps the rest', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts', 'src/generated/client.ts'])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(
      { ...LITE_INPUTS, ignoreCodeScope: ['src/generated/**'] },
      deps(octokit, orchestrator),
    )

    // src/api.ts is real business logic → analysis runs; the ignored generated
    // file must not appear in the diff the orchestrator sees.
    expect(orchestrator.callCount).toBe(1)
    const diff = orchestrator.lastInput?.diff ?? ''
    expect(diff).toContain('src/api.ts')
    expect(diff).not.toContain('src/generated/client.ts')
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('ignored 1 changed file(s) via ignore_code_scope'),
    )
  })

  it('hard error — orchestrator throw routes to a neutral check + error comment, no setFailed', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    const orchestrator = new ThrowingOrchestrator(new Error('LLM provider 503'))

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('neutral')
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body
    expect(body).toContain('Unable to Complete Analysis')
    expect(body).toContain('LLM provider 503')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('getPrContext throw — unsupported event warns and writes no check or comment', async () => {
    ;(github.context as unknown as { eventName: string }).eventName = 'push'
    ;(github.context as unknown as { payload: Record<string, unknown> }).payload = {}

    const octokit = makeOctokit()
    await runLitePipeline(LITE_INPUTS, deps(octokit, new FakeOrchestrator(passResult())))

    expect(core.warning).toHaveBeenCalled()
    expect(octokit.rest.pulls.listFiles).not.toHaveBeenCalled()
    expect(octokit.rest.checks.create).not.toHaveBeenCalled()
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })

  it('comment idempotency — updates an existing marker-bearing Delfini comment in place', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        {
          id: 4242,
          user: { type: 'Bot' },
          body: 'stale body\n\n<!-- delfini-pr-comment -->',
        },
      ],
    })

    await runLitePipeline(LITE_INPUTS, deps(octokit, new FakeOrchestrator(passResult())))

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1)
    expect(octokit.rest.issues.updateComment.mock.calls[0][0].comment_id).toBe(4242)
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })
})
