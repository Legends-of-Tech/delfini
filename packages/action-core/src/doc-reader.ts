import * as core from '@actions/core'
import type { GitHub } from '@actions/github/lib/utils'
import { isFileInDocScope } from '@delfini/drift-engine'
import {
  parseFrontMatter,
  type ExcludedDoc,
} from './doc-exclusion.js'

export interface DocFile {
  path: string
  content: string
  // Story 3.9b — see the matching field comment on `ports/types.ts:DocFile`.
  // doc-reader.ts and ports/types.ts intentionally keep twin definitions to
  // preserve the action package's zero-cross-package coupling.
  frontMatterLineCount: number
}

export interface DocsReadResult {
  included: DocFile[]
  excluded: ExcludedDoc[]
  scope: ScopeSource
}

// v6.1 — Web-managed doc scope (FR122a) is the single source of truth. The
// `.delfinidocs` allowlist (and its associated discriminated-union variant
// `{kind: 'delfinidocs'}`) was removed under that PRD; only `docs_path`
// remains. Keeping `ScopeSource` as a union (rather than a bare interface)
// preserves the discriminator shape so future scope sources can land without
// reshuffling consumers.
export type ScopeSource = { kind: 'docs_path'; docScope: string }

type Octokit = InstanceType<typeof GitHub>

export type ReadDocsOptions = Record<string, never>

// Story 3.12 (ADR-2026-06-01) — the per-directory `getContent` walk
// (`readDocsFromPath` + `collectDocs`) is retired. BOTH modes now read docs
// via `readDocsViaGitTrees` (ONE recursive git-trees call + the shared
// `isFileInDocScope` matcher). Full mode reaches it through
// `readDocsAtHeadViaGitTrees` (github-client.ts:readDocs); Lite mode reaches
// it directly (lite-pipeline.ts).

async function processFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
  out: DocsReadResult,
): Promise<void> {
  const content = await fetchFileContent(octokit, owner, repo, filePath, ref)
  if (content === null) {
    return
  }

  const frontMatter = parseFrontMatter(content, (message) => {
    core.warning(`${filePath}: ${message}`)
  })

  if (frontMatter.ignore) {
    out.excluded.push({
      path: filePath,
      reason: 'front-matter',
      detail: frontMatter.reason,
    })
    return
  }

  out.included.push({
    path: filePath,
    content: frontMatter.body,
    frontMatterLineCount: frontMatter.frontMatterLineCount,
  })
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    })

    if (Array.isArray(data) || data.type !== 'file' || !data.content) {
      return null
    }

    return Buffer.from(data.content, 'base64').toString('utf-8')
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: number }).status === 404
  )
}

// ----------------------------------------------------------------------------
// Story P2.6 / ADR-2026-06-01 — multi-path / glob doc-scope reader
// ----------------------------------------------------------------------------
//
// `readDocsViaGitTrees` is the new Lite-mode reader. It replaces the Lite
// pipeline's per-directory `getContent` walk (`readDocsFromPath`) with ONE
// recursive git-trees call, filters every blob path through the shared
// `isFileInDocScope` predicate from `@delfini/drift-engine` (picomatch@4
// dialect), then fetches only the matched `.md` blobs.
//
// Why git-trees: the Contents API has no glob support; the trees API is the
// only tractable way to glob a remote tree and is usually FEWER round-trips
// than the directory walk. Dialect parity with smart-skip is enforced by
// construction — the SAME `isFileInDocScope` runs against the SAME `string[]`
// scope on both sides (the 23-row dialect-parity fixture in
// `packages/drift-engine/__tests__/fixtures/doc-scope-dialect.json` gates it).
//
// Story 3.12 retired `readDocsFromPath` — Full mode now reaches this reader
// via `readDocsAtHeadViaGitTrees` (github-client.ts:readDocs), at full
// multi-path/glob parity with Lite mode.

const MAX_CONCURRENT_BLOB_FETCHES = 8
const MARKDOWN_EXTENSIONS = ['.md', '.markdown']

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

interface GitTreeEntry {
  path?: string
  type?: string
  sha?: string
  mode?: string
}

export async function readDocsViaGitTrees(
  octokit: Octokit,
  owner: string,
  repo: string,
  docScope: string[],
  ref: string,
  _options: ReadDocsOptions = {},
): Promise<DocsReadResult> {
  // Joined string for the internal `ScopeSource.docScope` display field — keeps
  // the existing `{kind: 'docs_path'; docScope: string}` shape byte-identical
  // for downstream log/display consumers (Story P2.6 AC4 default per the
  // Questions for the User answer). `ScopeSource` is internal to apps/action;
  // widening to `string | string[]` is a forward option for Story 3.12.
  const scopeDisplay = docScope.join(', ')
  const result: DocsReadResult = {
    included: [],
    excluded: [],
    scope: { kind: 'docs_path', docScope: scopeDisplay },
  }

  // Empty scope -> empty result, never analyse. Matches FR57(b)'s "no
  // doc-in-scope files" baseline; never fall through to a recursive call
  // against an empty scope (would match every blob).
  if (docScope.length === 0) {
    return result
  }

  let treeData
  try {
    const response = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      // The Octokit REST typing accepts the string '1' here (cast on the
      // wire to a query param). Boolean `true` works at runtime but is not
      // strictly typed.
      recursive: '1',
    })
    treeData = response.data
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      core.warning(`git tree for ref ${ref} not found — returning empty docs list`)
      return result
    }
    throw error
  }

  // V1 truncated-tree contract: warn-and-proceed. A truncated tree means the
  // user has a very large monorepo and the response hit GitHub's size cap;
  // some docs may be missed. A correctness-first follow-up walks the tree
  // subtree-by-subtree on truncation — backlogged.
  if (treeData.truncated) {
    core.warning(
      `git tree for ${ref} was truncated by GitHub; some docs may be missed. ` +
        'Consider narrowing docs_path or splitting the repo.',
    )
  }

  const tree = (treeData.tree ?? []) as GitTreeEntry[]
  const matchedPaths: string[] = []
  for (const entry of tree) {
    if (entry.type !== 'blob') continue
    const path = entry.path
    if (typeof path !== 'string' || path.length === 0) continue
    if (!isFileInDocScope(path, docScope)) continue
    // The predicate is path-shape-only (P3.6.1 AC5). The `.md` / `.markdown`
    // restriction is an expander concern — apply it AFTER the in-scope check.
    if (!isMarkdownPath(path)) continue
    matchedPaths.push(path)
  }

  // Concurrency-capped blob fetch. A repo with thousands of matched .md files
  // could otherwise trip GitHub's secondary rate limit. The cap is a safety
  // floor, not a perf knob.
  for (let i = 0; i < matchedPaths.length; i += MAX_CONCURRENT_BLOB_FETCHES) {
    const batch = matchedPaths.slice(i, i + MAX_CONCURRENT_BLOB_FETCHES)
    await Promise.all(batch.map((path) => processFile(octokit, owner, repo, path, ref, result)))
  }

  // Stable output order — git-trees response order can vary; tests depend on
  // determinism for snapshot-style assertions.
  result.included.sort((a, b) => a.path.localeCompare(b.path))

  return result
}

/**
 * Lite-mode reader wrapper. Always reads at the PR head SHA (`ctx.headSha`),
 * matching `github-client.ts:readDocs`'s rationale: walking at base would
 * re-detect the same drift forever once Approve-and-Commit splices doc
 * updates onto the PR branch (Story P2.6 carries the rationale forward;
 * Lite mode has no Approve-and-Commit but the head-vs-base distinction is
 * still the correct one for analysing "what the PR's current docs look like").
 *
 * Lives here rather than in `github-client.ts` to keep the new reader and its
 * wrapper colocated. Story 3.12 retired `readDocsFromPath`; BOTH modes read
 * via this git-trees path now (Full through `github-client.ts:readDocs`).
 */
export async function readDocsAtHeadViaGitTrees(
  octokit: Octokit,
  owner: string,
  repo: string,
  docScope: string[],
  headSha: string,
  options: ReadDocsOptions = {},
): Promise<DocsReadResult> {
  return readDocsViaGitTrees(octokit, owner, repo, docScope, headSha, options)
}

