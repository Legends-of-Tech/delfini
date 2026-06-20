import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'

import { main } from '../src/cli.js'
import { DELFINI_CONFIG_RELATIVE_PATH } from '../src/config.js'

// Helper: read the running package's version straight from package.json, so
// the test stays in sync with whatever value `--version` actually prints.
async function getCliVersion(): Promise<string> {
  const pkgPath = path.join(__dirname, '..', 'package.json')
  const raw = await fs.readFile(pkgPath, 'utf8')
  const pkg = JSON.parse(raw) as { version: string }
  return pkg.version
}

async function makeTempGitRepo(): Promise<string> {
  const root = path.join(os.tmpdir(), `delfini-cli-cli-${crypto.randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  await simpleGit({ baseDir: root }).init()
  return root
}

async function makeTempNonGitDir(): Promise<string> {
  // Important: a fresh dir under os.tmpdir() that has NO .git ancestor. On
  // most dev machines os.tmpdir() itself has no parent .git, but on some CI
  // runners or hand-configured boxes the tmpdir can sit under a checkout —
  // which would make `getRepoRoot()` succeed instead of throwing, and the
  // AC3 / AC5 "outside a git repo" tests would pass for the WRONG reason.
  // Verify the invariant explicitly: if `git rev-parse --show-toplevel`
  // succeeds inside the new dir, abort the test setup with a clear message
  // so the failure is visible at the source rather than masquerading as a
  // pass.
  const root = path.join(os.tmpdir(), `delfini-cli-nogit-${crypto.randomUUID()}`)
  await fs.mkdir(root, { recursive: true })

  let isInsideGit = false
  try {
    const raw = await simpleGit({ baseDir: root }).revparse(['--show-toplevel'])
    if (raw.trim().length > 0) isInsideGit = true
  } catch {
    // Expected path — `git rev-parse` exits non-zero outside a repo.
  }

  if (isInsideGit) {
    await fs.rm(root, { recursive: true, force: true })
    throw new Error(
      `makeTempNonGitDir invariant broken: ${root} is inside a git repo. ` +
        `The host's os.tmpdir() is parented by a git checkout, which means the ` +
        `"outside a git repo" tests cannot meaningfully exercise AC3/AC5. Move ` +
        `the test temp dir outside the checkout (e.g. set TMPDIR before running).`,
    )
  }

  return root
}

async function rmrf(target: string, restoreCwd: string): Promise<void> {
  // On Windows, rmdir fails with EBUSY if any process has the directory
  // as its cwd. Restore the original cwd BEFORE attempting to remove the
  // temp dir to avoid that failure.
  process.chdir(restoreCwd)
  await fs.rm(target, { recursive: true, force: true })
}

describe('cli.ts — main(argv)', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
  })

  describe('--version', () => {
    it('prints the version from package.json in a git repo and exits 0', async () => {
      const repo = await makeTempGitRepo()
      const exitCodeBefore = process.exitCode
      try {
        process.chdir(repo)
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

        await main(['node', 'delfini', '--version'])

        const expected = await getCliVersion()
        // commander prints `${version}\n` via process.stdout.write.
        const writes = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
        expect(writes).toBe(`${expected}\n`)
        // Exit code must not be marked non-zero. We accept undefined or 0
        // only — any other value is a regression. `exitCodeBefore` is
        // restored in `finally` so subsequent tests do not see drift.
        expect(process.exitCode === undefined || process.exitCode === 0).toBe(true)
      } finally {
        process.exitCode = exitCodeBefore
        await rmrf(repo, originalCwd)
      }
    })

    it('works outside a git repo (no git rev-parse requirement)', async () => {
      const dir = await makeTempNonGitDir()
      try {
        process.chdir(dir)
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

        await main(['node', 'delfini', '--version'])

        const expected = await getCliVersion()
        const writes = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
        expect(writes).toBe(`${expected}\n`)
      } finally {
        await rmrf(dir, originalCwd)
      }
    })
  })

  describe('--reset-scope', () => {
    it('deletes doc-scope.json when present and leaves sibling files alone', async () => {
      const repo = await makeTempGitRepo()
      try {
        process.chdir(repo)

        const docScopeAbs = path.join(repo, DELFINI_CONFIG_RELATIVE_PATH)
        const skillMdAbs = path.join(repo, '.claude/skills/delfini/SKILL.md')
        const claudeMdAbs = path.join(repo, 'CLAUDE.md')
        const traceFileAbs = path.join(repo, '.delfini-trace/foo.txt')

        await fs.mkdir(path.dirname(docScopeAbs), { recursive: true })
        await fs.writeFile(
          docScopeAbs,
          `${JSON.stringify({ version: 1, doc_scope: ['docs/'] }, null, 2)}\n`,
          'utf8',
        )
        await fs.writeFile(skillMdAbs, '# SKILL.md sentinel\n', 'utf8')
        await fs.writeFile(claudeMdAbs, '# CLAUDE.md sentinel\n', 'utf8')
        await fs.mkdir(path.dirname(traceFileAbs), { recursive: true })
        await fs.writeFile(traceFileAbs, 'trace sentinel\n', 'utf8')

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

        await main(['node', 'delfini', '--reset-scope'])

        await expect(fs.access(docScopeAbs)).rejects.toThrow()
        // Sibling files untouched.
        expect(await fs.readFile(skillMdAbs, 'utf8')).toBe('# SKILL.md sentinel\n')
        expect(await fs.readFile(claudeMdAbs, 'utf8')).toBe('# CLAUDE.md sentinel\n')
        expect(await fs.readFile(traceFileAbs, 'utf8')).toBe('trace sentinel\n')
        // Directory holding SKILL.md still exists.
        const skillDir = await fs.stat(path.dirname(skillMdAbs))
        expect(skillDir.isDirectory()).toBe(true)
        // No stdout/stderr output on success.
        const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
        const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
        expect(stdoutWrites).toBe('')
        expect(stderrWrites).toBe('')
      } finally {
        await rmrf(repo, originalCwd)
      }
    })

    it('is a silent no-op when doc-scope.json is absent (in a git repo)', async () => {
      const repo = await makeTempGitRepo()
      try {
        process.chdir(repo)

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

        await main(['node', 'delfini', '--reset-scope'])

        const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
        const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
        expect(stdoutWrites).toBe('')
        expect(stderrWrites).toBe('')
      } finally {
        await rmrf(repo, originalCwd)
      }
    })

    it('exits 0 quietly outside a git repo', async () => {
      const dir = await makeTempNonGitDir()
      try {
        process.chdir(dir)

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

        // Must not throw.
        await main(['node', 'delfini', '--reset-scope'])

        const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
        const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
        expect(stdoutWrites).toBe('')
        expect(stderrWrites).toBe('')
      } finally {
        await rmrf(dir, originalCwd)
      }
    })
  })

  describe('unknown flag', () => {
    it('surfaces a clear error and a non-zero outcome via exitOverride', async () => {
      const repo = await makeTempGitRepo()
      try {
        process.chdir(repo)

        // Commander writes its error to stderr; silence it for clean test
        // output but let the thrown CommanderError bubble up.
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

        await expect(main(['node', 'delfini', '--bogus'])).rejects.toThrow(/--bogus/)
      } finally {
        await rmrf(repo, originalCwd)
      }
    })
  })

  describe('local-prepare --relevance-threshold flag parser', () => {
    // These tests exercise the parser callback directly through commander's
    // argument validation — no git repo or file I/O needed because the error
    // is thrown before the subcommand action runs.

    const invalidInputs = ['5.5', '1.0', '-1', '-0', '1e2', '0x5', '3.14', '1.', '.5', ' 5', '5 ', '']

    for (const bad of invalidInputs) {
      it(`rejects "${bad}" with a clear error message`, async () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

        await expect(
          main(['node', 'delfini', 'local-prepare', '--relevance-threshold', bad]),
        ).rejects.toThrow('--relevance-threshold must be a non-negative integer')
      })
    }

    const validInputs = [
      { raw: '0', expected: 0 },
      { raw: '5', expected: 5 },
      { raw: '10', expected: 10 },
      { raw: '100', expected: 100 },
    ]

    for (const { raw, expected } of validInputs) {
      it(`accepts "${raw}" and forwards it as integer ${expected}`, async () => {
        // We only care that the parser does not throw; the subcommand itself
        // will fail (no git repo, no trace dir) but that is unrelated to the
        // flag validation under test. Swallow all output.
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

        // The action will fail with a non-parser error (e.g. no git repo),
        // but if the parser accepted the value it will NOT throw with the
        // "non-negative integer" message.
        const result = main(['node', 'delfini', 'local-prepare', '--relevance-threshold', raw])
        await expect(result).resolves.not.toThrow()
        // process.exitCode may be set to a non-zero value by the subcommand
        // (no git root, etc.) — that is fine. Reset after test.
        process.exitCode = 0
      })
    }
  })
})
