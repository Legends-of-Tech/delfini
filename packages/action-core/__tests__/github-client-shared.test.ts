import { describe, it, expect, vi, beforeEach } from 'vitest'

// Story P3.9.2a — the SHARED half of the former apps/action
// github-client.test.ts, moved into @delfini/action-core alongside
// github-client-shared.ts. Test bodies unchanged; only import paths moved.

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    repo: { owner: 'test-owner', repo: 'test-repo' },
    payload: {
      pull_request: {
        number: 42,
        head: { sha: 'head-sha-abc' },
        base: { sha: 'base-sha-def' },
      },
    },
  },
}))

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
}))

import {
  getPrContext,
  listChangedFiles,
  getFileContent,
  createCheckStatus,
} from '../src/github-client-shared'
import * as github from '@actions/github'

function createMockOctokit() {
  return {
    rest: {
      pulls: {
        listFiles: vi.fn(),
        listReviews: vi.fn(),
        createReview: vi.fn(),
        updateReview: vi.fn(),
      },
      repos: { getContent: vi.fn() },
      checks: { create: vi.fn() },
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockOctokit: any

beforeEach(() => {
  mockOctokit = createMockOctokit()
  vi.clearAllMocks()
})

describe('getPrContext', () => {
  it('extracts context from a pull_request event', () => {
    const ctx = getPrContext()

    expect(ctx).toEqual({
      owner: 'test-owner',
      repo: 'test-repo',
      pullNumber: 42,
      headSha: 'head-sha-abc',
      baseSha: 'base-sha-def',
    })
  })

  it('extracts context from an issue_comment event on a PR', () => {
    const mutableContext = github.context as {
      eventName: string
      payload: Record<string, unknown>
    }
    const originalEventName = mutableContext.eventName
    const originalPayload = { ...mutableContext.payload }

    mutableContext.eventName = 'issue_comment'
    mutableContext.payload = {
      issue: {
        number: 99,
        pull_request: { url: 'https://api.github.com/repos/test-owner/test-repo/pulls/99' },
      },
      comment: { body: '/delfini' },
    }

    try {
      const ctx = getPrContext()

      expect(ctx.owner).toBe('test-owner')
      expect(ctx.repo).toBe('test-repo')
      expect(ctx.pullNumber).toBe(99)
    } finally {
      mutableContext.eventName = originalEventName
      mutableContext.payload = originalPayload
    }
  })

  it('throws for unsupported events', () => {
    const mutableContext = github.context as {
      eventName: string
      payload: Record<string, unknown>
    }
    const originalEventName = mutableContext.eventName
    const originalPayload = { ...mutableContext.payload }

    mutableContext.eventName = 'push'
    mutableContext.payload = {}

    try {
      expect(() => getPrContext()).toThrow('Unsupported event')
    } finally {
      mutableContext.eventName = originalEventName
      mutableContext.payload = originalPayload
    }
  })
})

describe('listChangedFiles', () => {
  const ctx = {
    owner: 'test-owner',
    repo: 'test-repo',
    pullNumber: 42,
    headSha: 'head-sha',
    baseSha: 'base-sha',
  }

  it('returns changed files from a single page', async () => {
    mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({
      data: [
        { filename: 'src/main.ts', status: 'modified', patch: '@@ -1,3 +1,5 @@' },
        { filename: 'src/utils.ts', status: 'added', patch: '@@ -0,0 +1,10 @@' },
      ],
    })

    const files = await listChangedFiles(mockOctokit, ctx)

    expect(files).toEqual([
      { filename: 'src/main.ts', status: 'modified', patch: '@@ -1,3 +1,5 @@' },
      { filename: 'src/utils.ts', status: 'added', patch: '@@ -0,0 +1,10 @@' },
    ])
    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      pull_number: 42,
      per_page: 100,
      page: 1,
    })
  })

  it('handles pagination across multiple pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `file-${i}.ts`,
      status: 'modified',
      patch: `patch-${i}`,
    }))
    const page2 = [
      { filename: 'file-100.ts', status: 'added', patch: 'patch-100' },
    ]

    mockOctokit.rest.pulls.listFiles
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 })

    const files = await listChangedFiles(mockOctokit, ctx)

    expect(files).toHaveLength(101)
    expect(files[0].filename).toBe('file-0.ts')
    expect(files[100].filename).toBe('file-100.ts')
    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledTimes(2)
    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2 }),
    )
  })

  it('returns empty array when PR has no changed files', async () => {
    mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: [] })

    const files = await listChangedFiles(mockOctokit, ctx)

    expect(files).toEqual([])
  })
})

describe('getFileContent', () => {
  const ctx = {
    owner: 'test-owner',
    repo: 'test-repo',
    pullNumber: 42,
    headSha: 'head-sha',
    baseSha: 'base-sha',
  }

  it('decodes base64 file content', async () => {
    const originalContent = 'export function hello() { return "world" }'
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        content: Buffer.from(originalContent).toString('base64'),
        encoding: 'base64',
      },
    })

    const content = await getFileContent(mockOctokit, ctx, 'src/hello.ts', 'head-sha')

    expect(content).toBe(originalContent)
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      path: 'src/hello.ts',
      ref: 'head-sha',
    })
  })

  it('returns null for 404 responses (deleted files)', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 })
    mockOctokit.rest.repos.getContent.mockRejectedValueOnce(notFoundError)

    const content = await getFileContent(mockOctokit, ctx, 'deleted-file.ts', 'head-sha')

    expect(content).toBeNull()
  })

  it('returns null when response is a directory listing', async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: [{ type: 'dir', name: 'sub' }],
    })

    const content = await getFileContent(mockOctokit, ctx, 'src/', 'head-sha')

    expect(content).toBeNull()
  })

  it('rethrows non-404 errors', async () => {
    const serverError = Object.assign(new Error('Server Error'), { status: 500 })
    mockOctokit.rest.repos.getContent.mockRejectedValueOnce(serverError)

    await expect(
      getFileContent(mockOctokit, ctx, 'src/hello.ts', 'head-sha'),
    ).rejects.toThrow('Server Error')
  })
})

describe('createCheckStatus', () => {
  const ctx = {
    owner: 'test-owner',
    repo: 'test-repo',
    pullNumber: 42,
    headSha: 'head-sha-abc',
    baseSha: 'base-sha',
  }

  it('creates a check with conclusion success', async () => {
    await createCheckStatus(mockOctokit, ctx, 'success', 'Delfini — PASS', 'No contradictions')

    expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      head_sha: 'head-sha-abc',
      name: 'Delfini Docs Drift Check',
      status: 'completed',
      conclusion: 'success',
      output: { title: 'Delfini — PASS', summary: 'No contradictions' },
    })
  })

  it('creates a check with conclusion failure', async () => {
    await createCheckStatus(mockOctokit, ctx, 'failure', 'Delfini — FAIL', '2 contradictions found')

    expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        output: { title: 'Delfini — FAIL', summary: '2 contradictions found' },
      }),
    )
  })

  it('creates a check with conclusion neutral', async () => {
    await createCheckStatus(mockOctokit, ctx, 'neutral', 'Delfini — Unable to complete analysis', 'LLM unavailable')

    expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'neutral',
        output: { title: 'Delfini — Unable to complete analysis', summary: 'LLM unavailable' },
      }),
    )
  })

  it('creates a check with conclusion action_required (Story action-3-18)', async () => {
    // FR90 (Story action-3-18): required-mode drift uses 'action_required'
    // (yellow `!`) — same merge-blocking semantics as 'failure', better visual
    // signal. Signature must accept the widened union.
    await createCheckStatus(
      mockOctokit,
      ctx,
      'action_required',
      'Delfini — attention needed',
      '1 contradiction detected.',
    )

    expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'action_required',
        output: { title: 'Delfini — attention needed', summary: '1 contradiction detected.' },
      }),
    )
  })

  it('passes head_sha from PrContext and sets status to completed', async () => {
    await createCheckStatus(mockOctokit, ctx, 'success', 'Test', 'Summary')

    expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        head_sha: 'head-sha-abc',
        status: 'completed',
      }),
    )
  })
})
