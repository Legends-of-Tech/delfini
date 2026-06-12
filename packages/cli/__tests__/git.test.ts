import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Writable } from 'node:stream'
import simpleGit, { type SimpleGit } from 'simple-git'

import {
  RepoRootNotFoundError,
  getCurrentBranch,
  getDefaultBranch,
  getRepoRoot,
  hasCommittedChangesAgainst,
  hasUncommittedChanges,
  listUntrackedFiles,
  resolveBaseRef,
} from '../src/git.js'

describe('getRepoRoot', () => {
  let temp: string

  beforeEach(async () => {
    temp = path.join(os.tmpdir(), `delfini-cli-git-${crypto.randomUUID()}`)
    await fs.mkdir(temp, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(temp, { recursive: true, force: true })
  })

  it('returns the path of an initialised git repo', async () => {
    await simpleGit({ baseDir: temp }).init()

    const root = await getRepoRoot(temp)
    // Real path comparison handles macOS /private/tmp vs /tmp symlink and
    // Windows 8.3 short names. Compare via fs.realpath.
    const expected = await fs.realpath(temp)
    const actual = await fs.realpath(root)
    expect(actual).toBe(expected)
  })

  it('throws RepoRootNotFoundError for a directory that is not inside a git repo', async () => {
    // No `git init` — `temp` is a bare directory with no .git ancestor.
    await expect(getRepoRoot(temp)).rejects.toBeInstanceOf(RepoRootNotFoundError)
    await expect(getRepoRoot(temp)).rejects.toThrow(/not inside a git repository/)
  })
})

// ---------------------------------------------------------------------------
// P3.2.8 diff-source helpers
// ---------------------------------------------------------------------------

interface TempRepo {
  root: string
  git: SimpleGit
  commit: (message: string, files: Record<string, string>) => Promise<string>
  cleanup: () => Promise<void>
}

// `initialBranch` is explicit so the suite is hermetic — the host's
// `init.defaultBranch` config must not decide which cascade path runs.
async function makeTempRepo(initialBranch = 'main'): Promise<TempRepo> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delfini-cli-git-helpers-'))
  const git = simpleGit({ baseDir: root })
  await git.init([`--initial-branch=${initialBranch}`])
  await git.addConfig('user.email', 'test@delfini.local')
  await git.addConfig('user.name', 'Delfini Test')
  await git.addConfig('commit.gpgsign', 'false')
  return {
    root,
    git,
    async commit(message, files) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
      }
      await git.add('.')
      await git.commit(message)
      return (await git.revparse(['HEAD'])).trim()
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function nullStream(): NodeJS.WritableStream {
  return new Writable({ write: (_c, _e, cb) => cb() })
}

describe('getCurrentBranch', () => {
  let repo: TempRepo
  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'README.md': '# Hi\n' })
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('returns the checked-out branch name', async () => {
    await repo.git.checkoutLocalBranch('feature/abc')
    expect(await getCurrentBranch(repo.git)).toBe('feature/abc')
  })

  it('returns "HEAD" on a detached HEAD', async () => {
    const first = (await repo.git.revparse(['HEAD'])).trim()
    await repo.commit('second', { 'README.md': '# Hi again\n' })
    await repo.git.checkout([first])
    expect(await getCurrentBranch(repo.git)).toBe('HEAD')
  })
})

describe('getDefaultBranch', () => {
  let repo: TempRepo
  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'README.md': '# Hi\n' })
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('falls back to the sole local branch when there is no remote HEAD', async () => {
    expect(await getDefaultBranch(repo.git)).toBe('main')
  })

  it('detects master in a master-only repo (regression: the --quiet probe for a missing refs/heads/main must not falsely resolve)', async () => {
    const masterRepo = await makeTempRepo('master')
    try {
      await masterRepo.commit('initial', { 'README.md': '# Hi\n' })
      expect(await getDefaultBranch(masterRepo.git)).toBe('master')
    } finally {
      await masterRepo.cleanup()
    }
  })

  it('does not equal a feature branch name', async () => {
    await repo.git.checkoutLocalBranch('feature/x')
    expect(await getDefaultBranch(repo.git)).not.toBe('feature/x')
  })
})

describe('listUntrackedFiles', () => {
  let repo: TempRepo
  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'README.md': '# Hi\n', '.gitignore': 'ignored.txt\n' })
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('lists new files and honours .gitignore via --exclude-standard', async () => {
    await fs.writeFile(path.join(repo.root, 'a.ts'), 'a\n', 'utf8')
    await fs.writeFile(path.join(repo.root, 'ignored.txt'), 'x\n', 'utf8')
    const untracked = await listUntrackedFiles(repo.git)
    expect(untracked).toContain('a.ts')
    expect(untracked).not.toContain('ignored.txt')
  })

  it('returns an empty array on a clean tree', async () => {
    expect(await listUntrackedFiles(repo.git)).toEqual([])
  })
})

describe('hasUncommittedChanges', () => {
  let repo: TempRepo
  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'src/x.ts': 'export const x = 1\n' })
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('false on a clean tree', async () => {
    expect(await hasUncommittedChanges(repo.git)).toBe(false)
  })

  it('true on an unstaged edit', async () => {
    await fs.writeFile(path.join(repo.root, 'src', 'x.ts'), 'export const x = 2\n', 'utf8')
    expect(await hasUncommittedChanges(repo.git)).toBe(true)
  })

  it('true on an untracked-only addition', async () => {
    await fs.writeFile(path.join(repo.root, 'new.ts'), 'export const n = 1\n', 'utf8')
    expect(await hasUncommittedChanges(repo.git)).toBe(true)
  })
})

describe('hasCommittedChangesAgainst', () => {
  let repo: TempRepo
  beforeEach(async () => {
    repo = await makeTempRepo()
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('false when base equals HEAD', async () => {
    await repo.commit('initial', { 'src/x.ts': 'export const x = 1\n' })
    expect(await hasCommittedChangesAgainst(repo.git, 'HEAD')).toBe(false)
  })

  it('true when there is a commit ahead of base', async () => {
    const first = await repo.commit('initial', { 'src/x.ts': 'export const x = 1\n' })
    await repo.commit('delta', { 'src/x.ts': 'export const x = 2\n' })
    expect(await hasCommittedChangesAgainst(repo.git, first)).toBe(true)
  })
})

describe('resolveBaseRef', () => {
  let repo: TempRepo
  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'README.md': '# Hi\n' })
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('returns the explicit base when provided', async () => {
    expect(await resolveBaseRef(repo.git, 'abc123', nullStream())).toBe('abc123')
  })

  it('falls back to HEAD and warns when origin/main is unresolvable', async () => {
    const chunks: string[] = []
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk))
        cb()
      },
    })
    const base = await resolveBaseRef(repo.git, undefined, stderr)
    expect(base).toBe('HEAD')
    expect(chunks.join('')).toMatch(/falling back to HEAD/)
  })
})
