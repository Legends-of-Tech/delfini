// Read-only git helpers for the CLI.
//
// Story P3.2.5 shipped `getRepoRoot()`. Story P3.2.8 adds the diff-source
// inspection helpers consumed by both `diff-status` (commands/diff-status.ts)
// and `local-prepare` (commands/local-prepare.ts):
//
//   getCurrentBranch / getDefaultBranch  — branch identity + default detection
//   listUntrackedFiles                   — new files git diff misses by default
//   hasUncommittedChanges                — staged + unstaged + untracked predicate
//   hasCommittedChangesAgainst           — HEAD-vs-base range predicate
//   resolveBaseRef                       — shared --base resolution (was local-
//                                          prepare-private; lifted here so
//                                          diff-status and local-prepare agree)
//
// Every helper is a thin, side-effect-free `simple-git` wrapper. None of them
// mutate the index or working tree — `local-prepare` and `diff-status` are
// read paths (FR140 / NFR47). The CLI never calls an LLM (ESLint-enforced).

import simpleGit, { type SimpleGit } from 'simple-git'

export class RepoRootNotFoundError extends Error {
  readonly code = 'REPO_ROOT_NOT_FOUND' as const

  constructor(cause?: unknown) {
    super('not inside a git repository — Delfini requires a git checkout')
    this.name = 'RepoRootNotFoundError'
    if (cause !== undefined) {
      ;(this as { cause?: unknown }).cause = cause
    }
  }
}

export async function getRepoRoot(cwd?: string): Promise<string> {
  const baseDir = cwd ?? process.cwd()
  const git: SimpleGit = simpleGit({ baseDir })

  try {
    const raw = await git.revparse(['--show-toplevel'])
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      throw new RepoRootNotFoundError()
    }
    return trimmed
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) throw err
    throw new RepoRootNotFoundError(err)
  }
}

// -- Branch identity ---------------------------------------------------------

/**
 * Returns the current branch name (`git rev-parse --abbrev-ref HEAD`). On a
 * detached HEAD this is the literal `"HEAD"` — a valid, reportable state, not
 * an error.
 */
export async function getCurrentBranch(git: SimpleGit): Promise<string> {
  const raw = await git.revparse(['--abbrev-ref', 'HEAD'])
  return raw.trim()
}

/**
 * Resolves the repo's default branch without requiring a remote (temp-repo
 * tests have no `origin`). Cascade, first hit wins:
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD` → strip `origin/`.
 *   2. Whichever of `main` / `master` exists as a local ref.
 *   3. Literal `"main"`.
 */
export async function getDefaultBranch(git: SimpleGit): Promise<string> {
  // 1. Remote HEAD (set on clone; absent in `git init` repos).
  try {
    const raw = await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    const trimmed = raw.trim()
    if (trimmed.startsWith('origin/')) {
      return trimmed.slice('origin/'.length)
    }
    if (trimmed.length > 0) {
      return trimmed
    }
  } catch {
    // No remote HEAD — fall through to the local-ref probe.
  }

  // 2. Local main / master.
  for (const name of ['main', 'master']) {
    try {
      // --verify --quiet prints the SHA when the ref exists; when absent it
      // exits non-zero with EMPTY stderr (--quiet) — and simple-git's default
      // error detection only rejects a non-zero exit that also wrote stderr,
      // so the missing-ref probe RESOLVES with empty stdout instead of
      // throwing. The non-empty-stdout check, not the catch, discriminates.
      const sha = await git.raw(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
      if (sha.trim().length > 0) {
        return name
      }
    } catch {
      // Not present — try the next candidate.
    }
  }

  // 3. Conservative fallback.
  return 'main'
}

// -- Change detection --------------------------------------------------------

// The CLI's own per-run trace directory. It is created during `local-prepare`
// and is gitignored only after a `delfini install`; a bare `--scope` run never
// touches `.gitignore`. We exclude it unconditionally so a not-yet-ignored
// trace dir never leaks into the analysed diff or flips `hasLocalChanges`.
const TRACE_DIR_PREFIX = '.delfini-trace/'

/**
 * Lists untracked, non-ignored files (`git ls-files --others --exclude-standard`),
 * minus the CLI's own `.delfini-trace/` artefacts. These are the brand-new
 * files `git diff` / `git diff --cached` miss by default; the analysed diff
 * must still see them (FR141a untracked inclusion).
 */
export async function listUntrackedFiles(git: SimpleGit): Promise<string[]> {
  // `-z` → NUL-delimited, *unquoted* output. Without it, `git ls-files`
  // C-quotes paths containing spaces or non-ASCII bytes (octal escapes wrapped
  // in double quotes, under the default core.quotepath=true) — the quoted
  // literal is not a real path, so `git diff --no-index` cannot resolve it and
  // the file silently vanishes from the analysed diff. NUL-splitting also means
  // no per-line trim (paths are emitted verbatim); the trailing NUL yields one
  // empty segment, dropped by the length filter.
  const raw = await git.raw(['ls-files', '--others', '--exclude-standard', '-z'])
  return raw
    .split('\0')
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith(TRACE_DIR_PREFIX))
}

/**
 * True when there are staged, unstaged, OR untracked changes — i.e.
 * `git diff HEAD` is non-empty OR at least one untracked file exists. Either
 * condition alone is sufficient (FR141a `hasLocalChanges` semantics).
 */
export async function hasUncommittedChanges(git: SimpleGit): Promise<boolean> {
  const diff = await git.diff(['HEAD'])
  if (diff.trim().length > 0) {
    return true
  }
  const untracked = await listUntrackedFiles(git)
  return untracked.length > 0
}

/**
 * True when the `HEAD`-vs-`baseRef` range is non-empty — the feature branch's
 * committed delta (FR141a `hasCommittedChanges` semantics). On the default
 * branch the range is empty by construction (base ≈ HEAD).
 */
export async function hasCommittedChangesAgainst(
  git: SimpleGit,
  baseRef: string,
): Promise<boolean> {
  const diff = await git.diff([baseRef, 'HEAD'])
  return diff.trim().length > 0
}

// -- Base-ref resolution -----------------------------------------------------

/**
 * Resolves the effective base ref shared by `diff-status` and `local-prepare`
 * so the "does a committed delta exist?" predicate agrees with what
 * `local-prepare` actually analyses. When `--base` is provided it is used
 * directly; otherwise `git merge-base HEAD origin/main`; on failure (e.g. a
 * freshly-cloned remote-less sandbox) warns to stderr and falls back to `HEAD`
 * (empty committed range) rather than crashing.
 */
export async function resolveBaseRef(
  git: SimpleGit,
  explicitBase: string | undefined,
  stderr: NodeJS.WritableStream,
): Promise<string> {
  if (explicitBase !== undefined && explicitBase.length > 0) {
    return explicitBase
  }
  try {
    const raw = await git.raw(['merge-base', 'HEAD', 'origin/main'])
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      stderr.write(
        '⚠️  Could not resolve `git merge-base HEAD origin/main` — diff base falling back to HEAD (empty diff).\n',
      )
      return 'HEAD'
    }
    return trimmed
  } catch {
    stderr.write(
      '⚠️  Could not resolve `git merge-base HEAD origin/main` — diff base falling back to HEAD (empty diff).\n',
    )
    return 'HEAD'
  }
}
