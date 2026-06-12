import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Writable } from 'node:stream'
import simpleGit, { type SimpleGit } from 'simple-git'

import { runDiffStatus, type DiffStatus } from '../src/commands/diff-status.js'

// ---------------------------------------------------------------------------
// Helpers — real fs + real git temp repos (mirrors local-prepare.test.ts)
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'delfini-cli-diff-status-'))
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

function makeCapture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      cb()
    },
  })
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

interface RunResult {
  code: number
  status: DiffStatus | null
  stdoutText: string
  stderrText: string
}

async function run(repoRoot: string, base?: string): Promise<RunResult> {
  const stdout = makeCapture()
  const stderr = makeCapture()
  const code = await runDiffStatus({ repoRoot, base, stdout: stdout.stream, stderr: stderr.stream })
  const stdoutText = stdout.text()
  let status: DiffStatus | null = null
  if (stdoutText.trim().length > 0) {
    status = JSON.parse(stdoutText) as DiffStatus
  }
  return { code, status, stdoutText, stderrText: stderr.text() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDiffStatus — JSON shape + exit code (AC1)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'README.md': '# Hello\n' })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('prints valid single-line JSON with the four keys and exits 0', async () => {
    const { code, status, stdoutText } = await run(repo.root, 'HEAD')
    expect(code).toBe(0)
    expect(status).not.toBeNull()
    expect(Object.keys(status as object)).toEqual([
      'branch',
      'isDefaultBranch',
      'hasLocalChanges',
      'hasCommittedChanges',
    ])
    // Single line terminated by exactly one newline.
    expect(stdoutText.endsWith('\n')).toBe(true)
    expect(stdoutText.trimEnd().includes('\n')).toBe(false)
  })

  it('reports the current branch name', async () => {
    const expected = (await repo.git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    const { status } = await run(repo.root, 'HEAD')
    expect(status?.branch).toBe(expected)
  })
})

describe('runDiffStatus — hasLocalChanges / hasCommittedChanges (AC2)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('clean tree, no untracked → both false (base ≈ HEAD)', async () => {
    await repo.commit('initial', { 'README.md': '# Hello\n' })
    const { status } = await run(repo.root, 'HEAD')
    expect(status?.hasLocalChanges).toBe(false)
    expect(status?.hasCommittedChanges).toBe(false)
  })

  it('only working-tree change → hasLocalChanges true, hasCommittedChanges false', async () => {
    await repo.commit('initial', { 'src/x.ts': 'export const x = 1\n' })
    await fs.writeFile(path.join(repo.root, 'src', 'x.ts'), 'export const x = 2\n', 'utf8')
    const { status } = await run(repo.root, 'HEAD')
    expect(status?.hasLocalChanges).toBe(true)
    expect(status?.hasCommittedChanges).toBe(false)
  })

  it('untracked-only file counts as a local change', async () => {
    await repo.commit('initial', { 'README.md': '# Hello\n' })
    await fs.writeFile(path.join(repo.root, 'new.ts'), 'export const n = 1\n', 'utf8')
    const { status } = await run(repo.root, 'HEAD')
    expect(status?.hasLocalChanges).toBe(true)
  })

  it('only committed delta vs an explicit earlier base → hasCommittedChanges true, local false', async () => {
    const first = await repo.commit('initial', { 'src/x.ts': 'export const x = 1\n' })
    await repo.commit('delta', { 'src/x.ts': 'export const x = 2\n' })
    const { status } = await run(repo.root, first)
    expect(status?.hasCommittedChanges).toBe(true)
    expect(status?.hasLocalChanges).toBe(false)
  })

  it('committed delta + working-tree change → both true', async () => {
    const first = await repo.commit('initial', { 'src/x.ts': 'export const x = 1\n' })
    await repo.commit('delta', { 'src/x.ts': 'export const x = 2\n' })
    await fs.writeFile(path.join(repo.root, 'src', 'x.ts'), 'export const x = 3\n', 'utf8')
    const { status } = await run(repo.root, first)
    expect(status?.hasCommittedChanges).toBe(true)
    expect(status?.hasLocalChanges).toBe(true)
  })
})

describe('runDiffStatus — isDefaultBranch (AC3)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('true on the default branch (the repo has a single init branch)', async () => {
    await repo.commit('initial', { 'README.md': '# Hello\n' })
    const { status } = await run(repo.root, 'HEAD')
    expect(status?.isDefaultBranch).toBe(true)
  })

  it('true on the default branch when the sole init branch is master (regression: missing refs/heads/main probe must not win)', async () => {
    const masterRepo = await makeTempRepo('master')
    try {
      await masterRepo.commit('initial', { 'README.md': '# Hello\n' })
      const { status } = await run(masterRepo.root, 'HEAD')
      expect(status?.branch).toBe('master')
      expect(status?.isDefaultBranch).toBe(true)
    } finally {
      await masterRepo.cleanup()
    }
  })

  it('false on a feature branch', async () => {
    await repo.commit('initial', { 'README.md': '# Hello\n' })
    await repo.git.checkoutLocalBranch('feature/x')
    const { status } = await run(repo.root, 'HEAD')
    expect(status?.branch).toBe('feature/x')
    expect(status?.isDefaultBranch).toBe(false)
  })

  it('detached HEAD reports branch "HEAD" and isDefaultBranch false', async () => {
    const first = await repo.commit('initial', { 'README.md': '# Hello\n' })
    await repo.commit('second', { 'README.md': '# Hello again\n' })
    await repo.git.checkout([first]) // detach
    const { status } = await run(repo.root, 'HEAD')
    expect(status?.branch).toBe('HEAD')
    expect(status?.isDefaultBranch).toBe(false)
  })
})

describe('runDiffStatus — error path (AC1)', () => {
  it('exits non-zero with no JSON on stdout outside a git repo', async () => {
    const nonGit = mkdtempSync(path.join(os.tmpdir(), 'delfini-cli-nongit-'))
    try {
      const { code, status, stdoutText, stderrText } = await run(nonGit, 'HEAD')
      expect(code).not.toBe(0)
      expect(status).toBeNull()
      expect(stdoutText.trim()).toBe('')
      expect(stderrText.length).toBeGreaterThan(0)
    } finally {
      await fs.rm(nonGit, { recursive: true, force: true })
    }
  })
})
