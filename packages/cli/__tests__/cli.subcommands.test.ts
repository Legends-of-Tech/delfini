// Integration tests for the three commander subcommands wired into
// `main(argv)` by Story P3.2.7: `install`, `local-prepare`, `local-finalize`.
//
// These tests drive the router end-to-end (commander → action handler →
// library function → exit code) over real fs + real git temp repos. No
// mocking of `runInstall` / `runLocalPrepare` / `runLocalFinalize` —
// mocking the library function tests the mock, not the wiring (story
// P3.2.7 AC6 + Dev Notes §"Why integration tests instead of mocking").
//
// Per-test discipline mirrors the existing `cli.test.ts`:
//   - process.chdir(repo) under beforeEach/afterEach restoration
//   - vi.spyOn(process.stdout/stderr, 'write') to suppress + assert output
//   - process.exitCode is read inside the test body and restored in finally
//
// Unit-level coverage of every exit-code branch already lives in
// install.test.ts / local-prepare.test.ts / local-finalize.test.ts. The
// cases here exercise the cli-layer glue: argument parsing, option
// forwarding, and `process.exitCode` propagation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'

import { main } from '../src/cli.js'

// ---------------------------------------------------------------------------
// Shared helpers — patterned on cli.test.ts
// ---------------------------------------------------------------------------

async function makeTempGitRepo(): Promise<string> {
  const root = path.join(os.tmpdir(), `delfini-cli-sub-${crypto.randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  const git = simpleGit({ baseDir: root })
  await git.init()
  // CI-safe author info + no gpgsign prompts (mirrors local-prepare.test.ts).
  await git.addConfig('user.email', 'test@delfini.local')
  await git.addConfig('user.name', 'Delfini Test')
  await git.addConfig('commit.gpgsign', 'false')
  return root
}

async function rmrf(target: string, restoreCwd: string): Promise<void> {
  // Restore cwd BEFORE rm to avoid Windows EBUSY on the cwd-held dir.
  process.chdir(restoreCwd)
  await fs.rm(target, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// `delfini install <path>`
// ---------------------------------------------------------------------------

describe('cli.ts — `install <path>` subcommand', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
  })

  it('scaffolds SKILL.md + CLAUDE.md marker + .gitignore line with --auto-invoke', async () => {
    const repo = await makeTempGitRepo()
    try {
      process.chdir(repo)
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      // runInstall calls `console.log(...)` via its default logger.
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      // --auto-invoke forwards a true decision, bypassing the interactive prompt.
      await main(['node', 'delfini', 'install', repo, '--auto-invoke'])

      // Post-conditions on disk — proves the handler reached runInstall.
      const skillPath = path.join(repo, '.claude', 'skills', 'delfini', 'SKILL.md')
      await expect(fs.access(skillPath)).resolves.toBeUndefined()

      const claudeMd = await fs.readFile(path.join(repo, 'CLAUDE.md'), 'utf8')
      expect(claudeMd).toContain('<!-- delfini:auto-invoke-block-v1 -->')

      const gitignore = await fs.readFile(path.join(repo, '.gitignore'), 'utf8')
      expect(gitignore).toMatch(/\.delfini-trace\/$/m)

      // `runInstall` logged scaffolding messages — proves the shim invoked it.
      expect(logSpy).toHaveBeenCalled()
    } finally {
      await rmrf(repo, originalCwd)
    }
  })

  it('--no-auto-invoke strips the block (toggle off); SKILL.md + .gitignore unaffected', async () => {
    const repo = await makeTempGitRepo()
    try {
      process.chdir(repo)
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation(() => {})

      // Opt in, then toggle off via --no-auto-invoke.
      await main(['node', 'delfini', 'install', repo, '--auto-invoke'])
      const withBlock = await fs.readFile(path.join(repo, 'CLAUDE.md'), 'utf8')
      expect(withBlock).toContain('<!-- delfini:auto-invoke-block-v1 -->')

      await main(['node', 'delfini', 'install', repo, '--no-auto-invoke'])
      const stripped = await fs.readFile(path.join(repo, 'CLAUDE.md'), 'utf8')
      expect(stripped).not.toContain('<!-- delfini:auto-invoke-block-v1 -->')

      const skillPath = path.join(repo, '.claude', 'skills', 'delfini', 'SKILL.md')
      await expect(fs.access(skillPath)).resolves.toBeUndefined()
      const gitignore = await fs.readFile(path.join(repo, '.gitignore'), 'utf8')
      expect(gitignore).toMatch(/\.delfini-trace\/$/m)
    } finally {
      await rmrf(repo, originalCwd)
    }
  })

  it('rejects with InstallToolNotSupportedError when --tool is not CLAUDE', async () => {
    const repo = await makeTempGitRepo()
    try {
      process.chdir(repo)
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation(() => {})

      // runInstall throws synchronously inside the action handler; commander
      // propagates the rejection out of parseAsync. The bin entry's .catch()
      // is what would set process.exitCode = 1 in production — here we just
      // observe the rejection directly.
      await expect(
        main(['node', 'delfini', 'install', repo, '--tool', 'CURSOR']),
      ).rejects.toThrow(/not supported/i)
    } finally {
      await rmrf(repo, originalCwd)
    }
  })

  it('--scope seeds doc-scope.json non-interactively (no prompt)', async () => {
    const repo = await makeTempGitRepo()
    try {
      process.chdir(repo)
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation(() => {})

      // --scope provides the path list, so the install never reaches the
      // interactive scope prompt (would otherwise hang under a TTY stdin).
      await main([
        'node',
        'delfini',
        'install',
        repo,
        '--auto-invoke',
        '--scope',
        'docs/ specs/architecture.md',
      ])

      const docScopePath = path.join(
        repo,
        '.claude',
        'skills',
        'delfini',
        'doc-scope.json',
      )
      const raw = await fs.readFile(docScopePath, 'utf8')
      const parsed = JSON.parse(raw) as { version: number; doc_scope: string[] }
      expect(parsed).toEqual({ version: 1, doc_scope: ['docs', 'specs/architecture.md'] })
    } finally {
      await rmrf(repo, originalCwd)
    }
  })

  it('passes --tool CLAUDE through to runInstall as the default tool', async () => {
    const repo = await makeTempGitRepo()
    try {
      process.chdir(repo)
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation(() => {})

      // Explicit --tool CLAUDE must succeed identically to the omitted-flag
      // form (commander default), proving the flag is wired correctly.
      await main(['node', 'delfini', 'install', repo, '--tool', 'CLAUDE'])

      const skillPath = path.join(repo, '.claude', 'skills', 'delfini', 'SKILL.md')
      await expect(fs.access(skillPath)).resolves.toBeUndefined()
    } finally {
      await rmrf(repo, originalCwd)
    }
  })
})

// ---------------------------------------------------------------------------
// `delfini local-prepare`
// ---------------------------------------------------------------------------

describe('cli.ts — `local-prepare` subcommand', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
  })

  it('propagates exit code 2 when neither --scope nor doc-scope.json is configured', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)

      // Make a commit so `git diff HEAD HEAD` is valid (zero-diff but the
      // ref exists).
      await fs.writeFile(path.join(repo, 'README.md'), '# scratch\n', 'utf8')
      const git = simpleGit({ baseDir: repo })
      await git.add('.')
      await git.commit('initial')

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true)

      await main(['node', 'delfini', 'local-prepare', '--base', 'HEAD'])

      expect(process.exitCode).toBe(2)
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrText).toMatch(/No doc-scope configured/)
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })

  it('propagates exit code 0 when --scope expands successfully and budget passes', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)

      // Real-fs setup: a docs/ folder with a single small markdown file +
      // an initial commit so the diff base ref resolves.
      await fs.mkdir(path.join(repo, 'docs'), { recursive: true })
      await fs.writeFile(
        path.join(repo, 'docs', 'arch.md'),
        '# Architecture\n\nWe use Postgres.\n',
        'utf8',
      )
      const git = simpleGit({ baseDir: repo })
      await git.add('.')
      await git.commit('initial')

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await main([
        'node',
        'delfini',
        'local-prepare',
        '--scope',
        'docs/',
        '--base',
        'HEAD',
      ])

      expect(process.exitCode).toBe(0)
      // Trace artefacts written — proves the shim reached runLocalPrepare.
      await expect(
        fs.access(path.join(repo, '.delfini-trace', 'analysis-input.json')),
      ).resolves.toBeUndefined()
      await expect(
        fs.access(path.join(repo, '.delfini-trace', 'analysis-prompt.md')),
      ).resolves.toBeUndefined()
      await expect(
        fs.access(path.join(repo, '.delfini-trace', 'schema.json')),
      ).resolves.toBeUndefined()
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })

  it('forwards --diff-source both to runLocalPrepare (untracked file in the diff)', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)

      await fs.mkdir(path.join(repo, 'docs'), { recursive: true })
      await fs.writeFile(path.join(repo, 'docs', 'arch.md'), '# Arch\n', 'utf8')
      const git = simpleGit({ baseDir: repo })
      await git.add('.')
      await git.commit('initial')
      // Untracked file that only `local`/`both` should surface.
      await fs.writeFile(path.join(repo, 'docs', 'new.md'), '# Brand new\n', 'utf8')

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await main([
        'node',
        'delfini',
        'local-prepare',
        '--scope',
        'docs/',
        '--base',
        'HEAD',
        '--diff-source',
        'both',
      ])

      expect(process.exitCode).toBe(0)
      const inputJson = await fs.readFile(
        path.join(repo, '.delfini-trace', 'analysis-input.json'),
        'utf8',
      )
      const parsed = JSON.parse(inputJson) as { diff: string }
      expect(parsed.diff).toContain('new.md')
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })

  // NFR49 — retrieval is ON by default at the CLI call-site. A bare
  // `delfini local-prepare` (no --relevance-threshold) renders only the doc
  // sections a change could plausibly contradict; an unrelated doc is dropped
  // from the assembled prompt. `--relevance-threshold 0` opts back out and
  // embeds every in-scope doc whole. These two cases pin the user-facing
  // default — the library-level `runLocalPrepare(undefined)` off-path stays
  // covered by local-prepare.test.ts.
  async function seedRelevanceRepo(repo: string): Promise<string> {
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true })
    await fs.mkdir(path.join(repo, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(repo, 'docs', 'relevant.md'),
      '# Relevant\n\nThe module src/x.ts is documented here.\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(repo, 'docs', 'unrelated.md'),
      '# Unrelated\n\nNothing here matches the diff.\n',
      'utf8',
    )
    await fs.writeFile(path.join(repo, 'src', 'x.ts'), 'export const a = 1\n', 'utf8')
    const git = simpleGit({ baseDir: repo })
    await git.add('.')
    await git.commit('initial')
    // Commit a change to src/x.ts so the committed diff vs HEAD~1 is non-empty
    // and references the relevant doc's subject.
    await fs.writeFile(path.join(repo, 'src', 'x.ts'), 'export const a = 2\n', 'utf8')
    await git.add('.')
    await git.commit('change x.ts')
    const base = await git.raw(['rev-parse', 'HEAD~1'])
    return base.trim()
  }

  it('default (no --relevance-threshold) drops an unrelated doc from the prompt (retrieval on)', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)
      const base = await seedRelevanceRepo(repo)

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await main([
        'node',
        'delfini',
        'local-prepare',
        '--scope',
        'docs/',
        '--base',
        base,
        '--diff-source',
        'committed',
      ])

      expect(process.exitCode).toBe(0)
      const prompt = await fs.readFile(
        path.join(repo, '.delfini-trace', 'analysis-prompt.md'),
        'utf8',
      )
      expect(prompt).toContain('<document path="docs/relevant.md">')
      expect(prompt).not.toContain('<document path="docs/unrelated.md">')
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })

  it('--relevance-threshold 0 opts out — embeds every in-scope doc whole', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)
      const base = await seedRelevanceRepo(repo)

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await main([
        'node',
        'delfini',
        'local-prepare',
        '--scope',
        'docs/',
        '--base',
        base,
        '--diff-source',
        'committed',
        '--relevance-threshold',
        '0',
      ])

      expect(process.exitCode).toBe(0)
      const prompt = await fs.readFile(
        path.join(repo, '.delfini-trace', 'analysis-prompt.md'),
        'utf8',
      )
      expect(prompt).toContain('<document path="docs/relevant.md">')
      expect(prompt).toContain('<document path="docs/unrelated.md">')
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })
})

// ---------------------------------------------------------------------------
// `delfini diff-status`
// ---------------------------------------------------------------------------

describe('cli.ts — `diff-status` subcommand', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
  })

  it('prints JSON to stdout and propagates exit code 0', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)
      await fs.writeFile(path.join(repo, 'README.md'), '# scratch\n', 'utf8')
      const git = simpleGit({ baseDir: repo })
      await git.add('.')
      await git.commit('initial')

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await main(['node', 'delfini', 'diff-status', '--base', 'HEAD'])

      expect(process.exitCode).toBe(0)
      const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      const parsed = JSON.parse(stdoutText) as { branch: string; hasLocalChanges: boolean }
      expect(typeof parsed.branch).toBe('string')
      expect(parsed.hasLocalChanges).toBe(false)
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })
})

// ---------------------------------------------------------------------------
// `delfini local-finalize <findingsPath>`
// ---------------------------------------------------------------------------

describe('cli.ts — `local-finalize <findingsPath>` subcommand', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
  })

  /**
   * Seed `.delfini-trace/analysis-input.json` so `runLocalFinalize` can
   * recover the docs array (it errors out with exit 3 otherwise).
   */
  async function seedAnalysisInput(
    repoRoot: string,
    docContent = '# Architecture\n\nWe use Postgres.\n',
  ): Promise<void> {
    const traceDir = path.join(repoRoot, '.delfini-trace')
    await fs.mkdir(traceDir, { recursive: true })
    const analysisInput = {
      diff: '',
      docs: [{ path: 'docs/arch.md', content: docContent, frontMatterLineCount: 0 }],
      prMetadata: {
        owner: 'local',
        repo: 'test',
        prNumber: 0,
        headSha: 'abc',
        baseSha: 'def',
        title: 'Local /delfini run',
      },
    }
    await fs.writeFile(
      path.join(traceDir, 'analysis-input.json'),
      `${JSON.stringify(analysisInput, null, 2)}\n`,
      'utf8',
    )
  }

  it('propagates exit code 0 when findings file has zero findings', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)
      await seedAnalysisInput(repo)
      const findingsPath = path.join(repo, '.delfini-trace', 'findings.json')
      await fs.writeFile(
        findingsPath,
        JSON.stringify({ contradictions: [], additions: [], rawConfidence: 0.9 }),
        'utf8',
      )

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await main(['node', 'delfini', 'local-finalize', findingsPath])

      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })

  it('propagates exit code 1 when findings include at least one drift', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)
      // Doc content positions the quoted text on line 3.
      const docContent =
        '# Architecture\n\nWe use Postgres for storage.\n'
      await seedAnalysisInput(repo, docContent)
      const findingsPath = path.join(repo, '.delfini-trace', 'findings.json')
      await fs.writeFile(
        findingsPath,
        JSON.stringify({
          contradictions: [
            {
              targetDocPath: 'docs/arch.md',
              targetSection: 'Architecture',
              targetLineStart: 3,
              targetLineEnd: 3,
              whatChanged: 'Switched to MySQL',
              whatContradicts: 'Doc claims Postgres',
              proposedReplacement: 'We use MySQL for storage.',
              severity: 'High',
              confidence: 5,
              quotedDocText: 'We use Postgres for storage.',
            },
          ],
          additions: [],
          rawConfidence: 0.9,
        }),
        'utf8',
      )

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await main(['node', 'delfini', 'local-finalize', findingsPath])

      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })

  it('propagates exit code 3 when findings file is malformed JSON', async () => {
    const repo = await makeTempGitRepo()
    const exitCodeBefore = process.exitCode
    try {
      process.chdir(repo)
      await seedAnalysisInput(repo)
      const findingsPath = path.join(repo, '.delfini-trace', 'findings.json')
      await fs.writeFile(findingsPath, '{not valid json', 'utf8')

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true)

      await main(['node', 'delfini', 'local-finalize', findingsPath])

      expect(process.exitCode).toBe(3)
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      // schema_validation payload is emitted on stderr (per AC2 of P3.2.3).
      expect(stderrText).toMatch(/"error":\s*"schema_validation"/)
    } finally {
      process.exitCode = exitCodeBefore
      await rmrf(repo, originalCwd)
    }
  })
})
