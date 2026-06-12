import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// =====================================================================
// Story P2.5 — E2E Lite-mode coverage (rewritten for the Story P3.9.2a
// Lite-only artifact — AC5.4).
//
// "E2E" here is a Vitest integration test (the Action has no Playwright
// project). It drives the real Lite stack — runLitePipeline / run() →
// lite-comment-formatter → the @delfini/action-core shared core (smart-skip,
// doc-reader, github-client-shared) — with only the two genuine I/O
// boundaries faked: the LLM at the AnalysisOrchestrator port, and GitHub at
// the Octokit boundary. The FR88g/FR88d modules physically do not exist in
// this artifact (absence-by-construction); the zero-outbound-fetch spy in L6
// is the remaining no-platform-egress tripwire.
//
// Fixtures are self-contained — nothing is imported from pipeline.test.ts /
// lite-pipeline.test.ts (per-mode fixture isolation).
// =====================================================================

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
  setSecret: vi.fn(),
}))

// The orchestrator factory — partial-mocked on the @delfini/action-core
// barrel so the L6 run()-level scenario yields a FakeOrchestrator with no
// real LangChain / LLM HTTP. Everything else on the barrel (smart-skip,
// doc-reader, github-client-shared, readPipelineInputs) stays REAL. L1–L5 /
// L7 inject deps.orchestrator directly and never reach createOrchestrator().
vi.mock('@delfini/action-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfini/action-core')>()
  return { ...actual, createOrchestrator: vi.fn() }
})

import * as core from '@actions/core'
import * as github from '@actions/github'

import { createOrchestrator } from '@delfini/action-core'
import { runLitePipeline } from '../lite-pipeline.js'
import { run } from '../main.js'
import type { AnalysisOrchestrator, PipelineDeps } from '@delfini/action-core'
import type { AnalysisInput, AnalysisResult } from '@delfini/drift-engine'

interface OctokitStub {
  rest: {
    pulls: {
      listFiles: ReturnType<typeof vi.fn>
      createReview: ReturnType<typeof vi.fn>
    }
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
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: [] }),
        createReview: vi.fn().mockResolvedValue({}),
      },
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: [] }),
        createCommitStatus: vi.fn().mockResolvedValue({}),
      },
      checks: { create: vi.fn().mockResolvedValue({}) },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 1001 } }),
        updateComment: vi.fn().mockResolvedValue({ data: { id: 1001 } }),
      },
      // Story P2.6 — Lite mode now reads via `git.getTree` + shared
      // `isFileInDocScope` matcher + matched-blob fetch. Default-mock to an
      // empty tree; `mockDocs` per-test injects a tree + getContent that
      // collectively look like a real repo.
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

// Drift — a concrete-replacement contradiction.
function driftResult(): AnalysisResult {
  return {
    contradictions: [
      {
        targetDocPath: 'docs/architecture.md',
        targetSection: '3.2 Batch API',
        targetLineStart: 114,
        targetLineEnd: 120,
        whatChanged: 'The PR replaces the batch endpoint with a single-item endpoint.',
        whatContradicts: 'Section 3.2 documents the batch endpoint as the only supported path.',
        proposedReplacement: 'The service exposes a single-item /v2/process endpoint.',
        severity: 'High',
        confidence: 4,
        quotedDocText: 'all payment operations use batch mode',
      },
    ],
    additions: [],
    rawConfidence: 0.8,
  }
}

// Clarification — a null-replacement contradiction (the orchestrator has no
// separate clarification arm; a Contradiction with proposedReplacement: null
// is the narrative-only / "Delfini can't propose a concrete fix" case).
function clarificationResult(): AnalysisResult {
  return {
    contradictions: [
      {
        targetDocPath: 'docs/architecture.md',
        targetSection: '4. Rate Limits',
        targetLineStart: 88,
        targetLineEnd: 88,
        whatChanged: 'The PR adds a retry policy with no documented limit interaction.',
        whatContradicts: 'Section 4 does not state how retries count against the rate limit.',
        proposedReplacement: null,
        severity: 'Medium',
        confidence: 3,
        quotedDocText: 'rate limits apply per workspace',
      },
    ],
    additions: [],
    rawConfidence: 0.6,
  }
}

function mockListFiles(octokit: OctokitStub, filenames: string[]): void {
  let called = false
  octokit.rest.pulls.listFiles.mockImplementation(async () => {
    if (called) return { data: [] }
    called = true
    return {
      data: filenames.map((filename) => ({
        filename,
        status: 'modified',
        patch: '@@ -1 +1 @@\n-old\n+new',
      })),
    }
  })
}

// Story P2.6: fakes the git-trees API + the per-blob Contents API for the real
// `readDocsViaGitTrees`. The tree advertises every doc path as a blob; the
// matched-blob fetch then hits the per-path `getContent` fallback that
// returns the file content. Lite no longer walks a directory via the
// Contents API.
function mockDocs(octokit: OctokitStub, docs: Array<{ path: string; content: string }>): void {
  octokit.rest.git.getTree.mockResolvedValue({
    data: {
      tree: docs.map((d) => ({ path: d.path, type: 'blob', sha: 'fake-blob-sha' })),
      truncated: false,
    },
  })
  octokit.rest.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
    const fileMatch = docs.find((d) => d.path === path)
    if (fileMatch) {
      return {
        data: {
          type: 'file',
          name: path.split('/').pop(),
          path,
          content: Buffer.from(fileMatch.content, 'utf8').toString('base64'),
        },
      }
    }
    // Default: return an empty dir listing for any unmatched path so a stray
    // legacy directory-walk does not throw if something falls through.
    return { data: [] }
  })
}

// Story P2.6 — docScope is `string[]`.
const LITE_INPUTS = {
  docScope: ['docs'] as string[],
  enforcement: 'warning' as const,
  githubToken: 't',
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so a mockReturnValue configured inside
  // one test — e.g. L6's createOrchestrator / getOctokit / getInput — cannot
  // leak into a later test. Matches the spec's reset-discipline Dev Note.
  vi.resetAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
  // Restore the globalThis.fetch spy created in L6 even if an assertion threw.
  vi.restoreAllMocks()
})

describe('Lite pipeline E2E (Story P2.5)', () => {
  it('L1 — drift verdict → yellow check + rich findings comment', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    mockDocs(octokit, [
      { path: 'docs/architecture.md', content: '# Architecture\n\n## 3.2 Batch API\nUse batch mode.' },
    ])
    const orchestrator = new FakeOrchestrator(driftResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(1)

    // A top-level PR comment was posted (real lite-comment-formatter output).
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body as string
    expect(body).toContain('docs/architecture.md')
    expect(body).toContain('3.2 Batch API')
    expect(body).toContain('114–120')
    expect(body).not.toContain('```suggestion')
    expect(body).toContain('<!-- delfini-pr-comment -->')

    // Yellow check via the in_progress → createCommitStatus('pending') sentinel.
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledTimes(1)
    expect(octokit.rest.repos.createCommitStatus.mock.calls[0][0].state).toBe('pending')
    expect(octokit.rest.checks.create).not.toHaveBeenCalled()

    // Lite mode posts a top-level comment, never a PR review.
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('L2 — clarification verdict (null replacement) → yellow check + rich comment', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    mockDocs(octokit, [
      { path: 'docs/architecture.md', content: '# Architecture\n\n## 4. Rate Limits\nLimits apply.' },
    ])
    const orchestrator = new FakeOrchestrator(clarificationResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(1)

    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body as string
    expect(body).toContain('docs/architecture.md')
    expect(body).toContain('4. Rate Limits')
    expect(body).not.toContain('```suggestion')
    expect(body).toContain('<!-- delfini-pr-comment -->')

    // A null-replacement finding still counts toward the verdict → yellow.
    expect(octokit.rest.repos.createCommitStatus.mock.calls[0][0].state).toBe('pending')
    expect(octokit.rest.checks.create).not.toHaveBeenCalled()
  })

  it('L3 — PASS verdict → green check + PASS comment', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    mockDocs(octokit, [{ path: 'docs/architecture.md', content: '# Architecture' }])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(1)

    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body as string
    expect(body).toContain('Delfini — PASS')
    expect(body).toContain('<!-- delfini-pr-comment -->')
    expect(body).not.toContain('```suggestion')

    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled()
  })

  it('L4 — smart-skip FR57(a): structurally-uninteresting changes → no analysis, green check', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['package.json', 'pnpm-lock.yaml'])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(0)
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(octokit.rest.issues.createComment.mock.calls[0][0].body).toContain('Smart-skipped')
  })

  it('L5 — smart-skip FR57(b): docs-only-in-scope changes → no analysis, green check', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['docs/architecture.md', 'docs/intro.md'])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(0)
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(octokit.rest.issues.createComment.mock.calls[0][0].body).toContain('Smart-skipped')

    // The skip fires before any doc read.
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled()
  })

  it('L6 — run()-level Lite E2E: no platform egress, no FR88g/FR88d, zero outbound fetch', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'gh-token')
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', '')
    vi.mocked(core.getInput).mockReturnValue('')

    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    mockDocs(octokit, [
      { path: 'docs/architecture.md', content: '# Architecture\n\n## 3.2 Batch API\nUse batch mode.' },
    ])
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    )
    vi.mocked(createOrchestrator).mockReturnValue(new FakeOrchestrator(driftResult()))

    // Stubbed (not a bare spy) so an accidental outbound call fails fast
    // rather than hitting the real network; afterEach restores it.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected outbound fetch in Lite mode'))

    await run()

    // The Lite path ran end-to-end: a comment + a yellow check were posted.
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(octokit.rest.repos.createCommitStatus.mock.calls[0][0].state).toBe('pending')

    // No outbound network beyond the (faked) GitHub API. The FR88g/FR88d
    // clients no longer exist in this tree — zero outbound fetch IS the
    // no-platform-egress assertion now.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('L10 — AC4 guard: a supplied workspace token hard-fails the run before any pipeline work', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'gh-token')
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', 'ws-secret')
    vi.mocked(core.getInput).mockReturnValue('')

    const octokit = makeOctokit()
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    )

    await run()

    // Hard fail, loud message — and explicitly NO silent Lite downgrade:
    // no comment, no check, no orchestrator construction.
    expect(core.setFailed).toHaveBeenCalledTimes(1)
    const message = String(vi.mocked(core.setFailed).mock.calls[0][0])
    expect(message).toContain('standalone (Lite) Delfini action')
    expect(message).toContain('Delfini platform documentation')
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
    expect(octokit.rest.checks.create).not.toHaveBeenCalled()
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled()
    expect(createOrchestrator).not.toHaveBeenCalled()
  })

  it('L11 — AC4.1 guard: the legacy delfini_workspace_token input (undeclared with: entry) also hard-fails', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'gh-token')
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', '')
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'delfini_workspace_token' ? 'input-ws-secret' : '',
    )

    const octokit = makeOctokit()
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
    expect(octokit.rest.checks.create).not.toHaveBeenCalled()
  })

  it('L12 — AC4.1 guard: a whitespace-only token counts as absent (Lite runs normally)', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'gh-token')
    vi.stubEnv('DELFINI_WORKSPACE_TOKEN', '   \t ')
    vi.mocked(core.getInput).mockReturnValue('')

    const octokit = makeOctokit()
    mockListFiles(octokit, ['package.json'])
    vi.mocked(github.getOctokit).mockReturnValue(
      octokit as unknown as ReturnType<typeof github.getOctokit>,
    )

    await run()

    // No hard fail — the run proceeded into the Lite pipeline (smart-skip).
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
  })

  it('L8 — Story P2.6 multi-path + glob docScope: rich comment surfaces matched docs from every entry', async () => {
    // Story P2.6 / AC8 — docs_path now accepts a newline-/comma-delimited
    // list. Drive the post-readPipelineInputs string[] form directly: a
    // directory (recursive .md), a single root file, and a glob.
    const docScope = ['docs', 'README.md', 'architecture/decisions/*.md']
    const inputs = {
      docScope,
      enforcement: 'warning' as const,
      githubToken: 't',
    }

    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    // Tree advertises docs under all three scope entries, plus a non-matched
    // file (`docs/diagram.png`) to verify the `.md` filter and a sibling
    // tree (`src/api.ts`) to verify the in-scope predicate excludes it.
    mockDocs(octokit, [
      { path: 'docs/architecture.md', content: '# Architecture\n\n## 3.2 Batch API' },
      { path: 'docs/sub/intro.md', content: '# Intro' },
      { path: 'README.md', content: '# Repo README' },
      { path: 'architecture/decisions/0001-foo.md', content: '# ADR 0001' },
      { path: 'architecture/decisions/0002-bar.md', content: '# ADR 0002' },
    ])
    // Inject a couple of tree entries that MUST be filtered out — a non-md
    // file (path-shape predicate would still match `docs/diagram.png` per the
    // P3.6.1 fixture, but the reader's `.md` filter strips it), and a file
    // under a non-scoped directory.
    octokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: 'docs/architecture.md', type: 'blob', sha: 'a' },
          { path: 'docs/sub/intro.md', type: 'blob', sha: 'b' },
          { path: 'docs/diagram.png', type: 'blob', sha: 'c' },
          { path: 'README.md', type: 'blob', sha: 'd' },
          { path: 'architecture/decisions/0001-foo.md', type: 'blob', sha: 'e' },
          { path: 'architecture/decisions/0002-bar.md', type: 'blob', sha: 'f' },
          { path: 'src/api.ts', type: 'blob', sha: 'g' },
          { path: 'architecture/decisions/notes.txt', type: 'blob', sha: 'h' },
        ],
        truncated: false,
      },
    })

    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(inputs, deps(octokit, orchestrator))

    // The orchestrator received exactly the matched + .md set: docs/** (2),
    // README.md (1), architecture/decisions/*.md (2). diagram.png filtered
    // out by the .md restriction; src/api.ts + notes.txt excluded by the
    // predicate.
    expect(orchestrator.callCount).toBe(1)
    const ingestedPaths = (orchestrator.lastInput?.docs ?? []).map((d) => d.path).sort()
    expect(ingestedPaths).toEqual([
      'README.md',
      'architecture/decisions/0001-foo.md',
      'architecture/decisions/0002-bar.md',
      'docs/architecture.md',
      'docs/sub/intro.md',
    ])

    // Rich PASS comment names the joined scope (multi-entry display).
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body as string
    expect(body).toContain('docs, README.md, architecture/decisions/*.md')
    expect(body).toContain('<!-- delfini-pr-comment -->')

    // Green check via the PASS path.
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
  })

  it('L9 — Story P2.6 multi-path smart-skip FR57(b): every changed file in scope across multiple entries → skip', async () => {
    // Story P2.6 / AC8 — smart-skip's FR57(b) leg uses the shared predicate.
    // Files matching different scope entries all collapse to "in-scope" via
    // ONE call to the shared `isFileInDocScope`.
    const docScope = ['docs', 'README.md', 'architecture/decisions/*.md']
    const inputs = {
      docScope,
      enforcement: 'warning' as const,
      githubToken: 't',
    }

    const octokit = makeOctokit()
    mockListFiles(octokit, [
      'docs/architecture.md',
      'README.md',
      'architecture/decisions/0001-foo.md',
    ])
    const orchestrator = new FakeOrchestrator(passResult())

    await runLitePipeline(inputs, deps(octokit, orchestrator))

    expect(orchestrator.callCount).toBe(0)
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    expect(octokit.rest.issues.createComment.mock.calls[0][0].body).toContain('Smart-skipped')
    expect(octokit.rest.git.getTree).not.toHaveBeenCalled()
  })

  it('L7 — hard error → neutral check, no setFailed', async () => {
    const octokit = makeOctokit()
    mockListFiles(octokit, ['src/api.ts'])
    mockDocs(octokit, [{ path: 'docs/architecture.md', content: '# Architecture' }])
    const orchestrator = new ThrowingOrchestrator(new Error('LLM provider 503'))

    await runLitePipeline(LITE_INPUTS, deps(octokit, orchestrator))

    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    expect(octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('neutral')
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body as string
    expect(body).toContain('Unable to Complete Analysis')
    expect(body).toContain('LLM provider 503')
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
