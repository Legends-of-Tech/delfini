import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readDocsViaGitTrees } from '../src/doc-reader'

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
}))

// Story 3.12 (ADR-2026-06-01) — Full + Lite both read docs via ONE recursive
// git-trees call + the shared `isFileInDocScope` matcher, then fetch only the
// matched `.md` blobs. These tests drive `readDocsViaGitTrees` directly (the
// old per-directory `getContent` walk `readDocsFromPath` was retired in this
// story). They preserve the front-matter / `.md`-filter / 404 behaviour the
// retired `readDocsFromPath` tests covered, plus multi-path/glob scope cases.

// Build a recursive git-trees response from a list of blob paths.
function treeResponse(paths: string[], truncated = false) {
  return {
    data: {
      tree: paths.map((path) => ({
        type: 'blob' as const,
        path,
        sha: `sha-${path}`,
        mode: '100644',
      })),
      truncated,
    },
  }
}

function fileContentResponse(content: string) {
  return {
    data: {
      type: 'file' as const,
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    },
  }
}

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockOctokit: any

// Path-keyed blob-content mock — robust to the reader's fetch ordering.
function mockBlobContents(contents: Record<string, string>) {
  mockOctokit.rest.repos.getContent.mockImplementation(
    async ({ path }: { path: string }) => {
      if (path in contents) return fileContentResponse(contents[path]!)
      throw notFound()
    },
  )
}

beforeEach(() => {
  mockOctokit = {
    rest: {
      git: { getTree: vi.fn() },
      repos: { getContent: vi.fn() },
    },
  }
  vi.clearAllMocks()
})

describe('readDocsViaGitTrees', () => {
  const owner = 'test-owner'
  const repo = 'test-repo'
  const ref = 'abc123'

  it('returns empty included+excluded for an empty matched set', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(treeResponse([]))

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([])
    expect(result.excluded).toEqual([])
    expect(result.scope).toEqual({ kind: 'docs_path', docScope: 'docs' })
  })

  it('returns a single .md file under a directory scope', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse(['docs/guide.md']),
    )
    mockBlobContents({ 'docs/guide.md': '# Guide\n\nSome content' })

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([
      { path: 'docs/guide.md', content: '# Guide\n\nSome content', frontMatterLineCount: 0 },
    ])
    expect(result.excluded).toEqual([])
  })

  it('recursively includes .md files from nested subdirectories (one tree call)', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse([
        'docs/root.md',
        'docs/sub/nested.md',
        'docs/sub/deep/deep.md',
      ]),
    )
    mockBlobContents({
      'docs/root.md': 'Root doc',
      'docs/sub/nested.md': 'Nested doc',
      'docs/sub/deep/deep.md': 'Deep doc',
    })

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([
      { path: 'docs/root.md', content: 'Root doc', frontMatterLineCount: 0 },
      { path: 'docs/sub/deep/deep.md', content: 'Deep doc', frontMatterLineCount: 0 },
      { path: 'docs/sub/nested.md', content: 'Nested doc', frontMatterLineCount: 0 },
    ])
    // ONE recursive tree call, not a walk-per-directory.
    expect(mockOctokit.rest.git.getTree).toHaveBeenCalledTimes(1)
    expect(mockOctokit.rest.git.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ recursive: '1', tree_sha: ref }),
    )
  })

  it('excludes non-.md files from results (predicate is in-scope; .md filter is the expander)', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse([
        'docs/readme.md',
        'docs/config.json',
        'docs/image.png',
        'docs/notes.txt',
      ]),
    )
    mockBlobContents({ 'docs/readme.md': 'Readme content' })

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([
      { path: 'docs/readme.md', content: 'Readme content', frontMatterLineCount: 0 },
    ])
  })

  it('returns empty result with a warning when the git tree is 404 (ref missing)', async () => {
    const core = await import('@actions/core')
    mockOctokit.rest.git.getTree.mockRejectedValueOnce(notFound())

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([])
    expect(result.excluded).toEqual([])
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining(ref))
  })

  it('warns and proceeds with partial results on a truncated tree', async () => {
    const core = await import('@actions/core')
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse(['docs/a.md'], /* truncated */ true),
    )
    mockBlobContents({ 'docs/a.md': 'A' })

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([
      { path: 'docs/a.md', content: 'A', frontMatterLineCount: 0 },
    ])
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('truncated'))
  })

  it('excludes files marked ignore via front-matter shorthand', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse(['docs/real.md', 'docs/draft.md']),
    )
    mockBlobContents({
      'docs/real.md': 'Real source of truth',
      'docs/draft.md': '---\ndelfini: ignore\n---\n# Draft\n\nIgnore me',
    })

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([
      { path: 'docs/real.md', content: 'Real source of truth', frontMatterLineCount: 0 },
    ])
    expect(result.excluded).toEqual([
      { path: 'docs/draft.md', reason: 'front-matter', detail: undefined },
    ])
  })

  it('captures front-matter reason when verbose object form is used', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse(['docs/archive.md']),
    )
    mockBlobContents({
      'docs/archive.md':
        '---\ndelfini:\n  ignore: true\n  reason: "historical, superseded"\n---\n# Archive',
    })

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toEqual([])
    expect(result.excluded).toEqual([
      {
        path: 'docs/archive.md',
        reason: 'front-matter',
        detail: 'historical, superseded',
      },
    ])
  })

  it('strips front-matter from included doc content', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse(['docs/guide.md']),
    )
    mockBlobContents({ 'docs/guide.md': '---\ntitle: Guide\n---\n# Guide\n\nBody' })

    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

    expect(result.included).toHaveLength(1)
    expect(result.included[0]!.content).not.toContain('---')
    expect(result.included[0]!.content).toContain('# Guide')
    expect(result.included[0]!.content).toContain('Body')
  })

  // Story 3.12 — multi-path / glob scope.
  it('matches a multi-entry scope: a directory + a single file + a glob', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValueOnce(
      treeResponse([
        'docs/index.md', // matched by 'docs'
        'README.md', // matched by 'README.md'
        'specs/api/users.md', // matched by 'specs/**/*.md'
        'specs/api/notes.txt', // glob is *.md only → excluded by .md filter
        'src/code.ts', // out of scope
      ]),
    )
    mockBlobContents({
      'docs/index.md': 'Index',
      'README.md': 'Readme',
      'specs/api/users.md': 'Users',
    })

    const result = await readDocsViaGitTrees(
      mockOctokit,
      owner,
      repo,
      ['docs', 'README.md', 'specs/**/*.md'],
      ref,
    )

    // Output is stably sorted by `localeCompare` (docs < README < specs).
    expect(result.included.map((d) => d.path)).toEqual([
      'docs/index.md',
      'README.md',
      'specs/api/users.md',
    ])
  })

  it('returns an empty result for an empty scope (never matches every blob)', async () => {
    const result = await readDocsViaGitTrees(mockOctokit, owner, repo, [], ref)
    expect(result.included).toEqual([])
    // Empty scope short-circuits before any network call.
    expect(mockOctokit.rest.git.getTree).not.toHaveBeenCalled()
  })

  describe('frontMatterLineCount propagation (Story 3.9b)', () => {
    it('populates 0 for a doc with no front-matter', async () => {
      mockOctokit.rest.git.getTree.mockResolvedValueOnce(
        treeResponse(['docs/guide.md']),
      )
      mockBlobContents({ 'docs/guide.md': '# Guide\n\nBody' })

      const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

      expect(result.included).toHaveLength(1)
      expect(result.included[0]!.frontMatterLineCount).toBe(0)
    })

    it('populates the stripped line count for a doc with YAML front-matter', async () => {
      mockOctokit.rest.git.getTree.mockResolvedValueOnce(
        treeResponse(['docs/guide.md']),
      )
      mockBlobContents({
        'docs/guide.md': '---\ntitle: Guide\nversion: 2\n---\n# Guide\n\nBody',
      })

      const result = await readDocsViaGitTrees(mockOctokit, owner, repo, ['docs'], ref)

      expect(result.included).toHaveLength(1)
      // 4 lines: --- + title + version + ---
      expect(result.included[0]!.frontMatterLineCount).toBe(4)
    })
  })
})
