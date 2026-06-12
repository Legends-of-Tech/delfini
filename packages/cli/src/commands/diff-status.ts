// `delfini diff-status` — the read-only branch/change-state reporter.
//
// Prints a single-line JSON object to stdout:
//   {"branch":"<name>","isDefaultBranch":<bool>,"hasLocalChanges":<bool>,"hasCommittedChanges":<bool>}
//
// It is the helper the SKILL.md protocol (Story P3.3.1, FR143 step 3) shells
// out to in order to decide the diff source:
//   - neither local nor committed changes → early "nothing to analyse" exit
//   - only one present → resolve automatically (`local` / `committed`)
//   - both present on a feature branch → create-PR auto uses `both` silently,
//     a manual /delfini prompts the user (the prompt is the protocol's job)
//
// Deterministic, never calls an LLM, never prompts, and — unlike
// `local-prepare` — writes NOTHING to disk (no .delfini-trace/, no doc-scope
// read). Pure read-only git inspection (FR140).

import simpleGit from 'simple-git'

import {
  RepoRootNotFoundError,
  getCurrentBranch,
  getDefaultBranch,
  getRepoRoot,
  hasCommittedChangesAgainst,
  hasUncommittedChanges,
  resolveBaseRef,
} from '../git.js'

export interface RunDiffStatusOptions {
  /**
   * The `--base <ref>` value. When omitted, defaults to
   * `git merge-base HEAD origin/main` (with a fallback to `HEAD` on a
   * remote-less sandbox — see `resolveBaseRef`).
   */
  base?: string
  /**
   * Override the repo root. Test seam — production callers omit this and let
   * `getRepoRoot()` resolve via `git rev-parse --show-toplevel`.
   */
  repoRoot?: string
  /** Stream sink for the JSON output. Test seam — defaults to process.stdout. */
  stdout?: NodeJS.WritableStream
  /** Stream sink for errors + base-ref fallback warnings. Test seam. */
  stderr?: NodeJS.WritableStream
}

export interface DiffStatus {
  branch: string
  isDefaultBranch: boolean
  hasLocalChanges: boolean
  hasCommittedChanges: boolean
}

/**
 * Returns an exit code: `0` on success, non-zero on git failure (outside a
 * git repo, or any other git error). On the error path it writes a message to
 * stderr and emits NO JSON on stdout — consumers parse stdout only on exit 0.
 */
export async function runDiffStatus(options: RunDiffStatusOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  let repoRoot: string
  try {
    repoRoot = options.repoRoot ?? (await getRepoRoot())
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) {
      stderr.write(`${err.message}\n`)
    } else {
      stderr.write(`diff-status failed: ${describeError(err)}\n`)
    }
    return 1
  }

  try {
    const git = simpleGit({ baseDir: repoRoot })
    const baseRef = await resolveBaseRef(git, options.base, stderr)

    const branch = await getCurrentBranch(git)
    const defaultBranch = await getDefaultBranch(git)
    const isDefaultBranch = branch !== 'HEAD' && branch === defaultBranch

    const hasLocalChanges = await hasUncommittedChanges(git)
    const hasCommittedChanges = await hasCommittedChangesAgainst(git, baseRef)

    const status: DiffStatus = {
      branch,
      isDefaultBranch,
      hasLocalChanges,
      hasCommittedChanges,
    }
    stdout.write(`${JSON.stringify(status)}\n`)
    return 0
  } catch (err) {
    stderr.write(`diff-status failed: ${describeError(err)}\n`)
    return 1
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
