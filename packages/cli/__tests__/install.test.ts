import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'

import {
  InstallToolNotSupportedError,
  RepoRootNotFoundError,
  readConfig,
  runInstall,
} from '../src/index.js'
import { parseScopeInput, parseYesNo } from '../src/commands/install.js'

const DOC_SCOPE_REL = join('.claude', 'skills', 'delfini', 'delfini-config.json')

const OPEN_MARKER = '<!-- delfini:auto-invoke-block-v1 -->'
const CLOSE_MARKER = '<!-- /delfini:auto-invoke-block-v1 -->'

// Auto-invoke decision seams. Injecting these keeps CLAUDE.md behaviour
// deterministic and TTY-independent (a bare runInstall on a non-TTY stdin
// SKIPS the CLAUDE.md mutation).
const yes = (): Promise<boolean> => Promise.resolve(true)
const no = (): Promise<boolean> => Promise.resolve(false)

// Doc-scope seam. Returning a non-empty array drives the write/overwrite
// path; an empty array drives the no-op path. Injecting this keeps doc-scope
// seeding deterministic and TTY-independent (a bare runInstall on a non-TTY
// stdin SKIPS the doc-scope prompt).
const scope =
  (paths: string[]) =>
  (): Promise<string[]> =>
    Promise.resolve(paths)

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'delfini-install-test-'))
}

async function mkGitRepo(): Promise<string> {
  const dir = mkTmp()
  await simpleGit({ baseDir: dir }).init()
  return dir
}

function makeLogger(): { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() }
}

// Force a non-TTY stdin for the whole file so a no-`confirmAutoInvoke` call
// deterministically hits the skip path (never blocks on a readline prompt),
// regardless of how the test runner attaches stdin. Tests that exercise the
// append/strip paths inject `yes` / `no` explicitly.
let savedIsTTY: boolean | undefined
beforeAll(() => {
  savedIsTTY = process.stdin.isTTY
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
})
afterAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true })
})

describe('runInstall — AC1 SKILL.md scaffolding', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('creates .claude/skills/delfini/SKILL.md on first run', async () => {
    await runInstall(repoRoot, { logger: makeLogger() })
    const skillPath = join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md')
    expect(existsSync(skillPath)).toBe(true)
    const content = readFileSync(skillPath, 'utf8')
    expect(content.length).toBeGreaterThan(0)
  })

  it('creates intermediate directories recursively', async () => {
    await runInstall(repoRoot, { logger: makeLogger() })
    expect(existsSync(join(repoRoot, '.claude'))).toBe(true)
    expect(existsSync(join(repoRoot, '.claude', 'skills'))).toBe(true)
    expect(existsSync(join(repoRoot, '.claude', 'skills', 'delfini'))).toBe(true)
  })

  it('overwrites SKILL.md on re-run (documented upgrade path)', async () => {
    const skillPath = join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md')
    await runInstall(repoRoot, { logger: makeLogger() })
    const firstRun = readFileSync(skillPath)
    // Mutate the file as if the user had hand-edited it.
    writeFileSync(skillPath, 'USER EDIT — should be overwritten')
    await runInstall(repoRoot, { logger: makeLogger() })
    const secondRun = readFileSync(skillPath)
    expect(secondRun).toEqual(firstRun)
  })

  it('runs successfully when invoked from a subdirectory of the repo', async () => {
    const subDir = join(repoRoot, 'some', 'nested', 'subdir')
    mkdirSync(subDir, { recursive: true })
    await runInstall(subDir, { logger: makeLogger() })
    // SKILL.md lands at the repo root, NOT at the subdir.
    expect(existsSync(join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(subDir, '.claude', 'skills', 'delfini', 'SKILL.md'))).toBe(false)
  })
})

describe('runInstall — AC3 CLAUDE.md auto-invoke block (opt-in YES)', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('creates CLAUDE.md if absent and includes both markers', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    expect(existsSync(claudeMdPath)).toBe(true)
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain(OPEN_MARKER)
    expect(content).toContain(CLOSE_MARKER)
  })

  it('appends the block to an existing CLAUDE.md', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    writeFileSync(claudeMdPath, '# Existing content\n\nSome text.\n')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain('# Existing content')
    expect(content).toContain('Some text.')
    expect(content).toContain(OPEN_MARKER)
    expect(content).toContain(CLOSE_MARKER)
  })

  it('does not duplicate the block on re-run', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const afterFirst = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const afterSecond = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')
    expect(afterSecond).toBe(afterFirst)
    // Only ONE occurrence of the opening marker.
    expect(afterSecond.match(new RegExp(escapeRegex(OPEN_MARKER), 'g'))).toHaveLength(1)
  })

  it('inserts a leading newline when CLAUDE.md does not end with one', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    writeFileSync(claudeMdPath, 'no trailing newline')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const content = readFileSync(claudeMdPath, 'utf8')
    // The block must not glue onto the previous line.
    expect(content).toMatch(/no trailing newline\r?\n<!-- delfini:auto-invoke-block-v1 -->/)
  })

  it('does not insert a double newline when CLAUDE.md already ends with one', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    writeFileSync(claudeMdPath, 'existing content\n')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain('existing content\n<!-- delfini:auto-invoke-block-v1 -->')
    expect(content).not.toContain('existing content\n\n<!-- delfini:auto-invoke-block-v1 -->')
  })

  it('treats an empty CLAUDE.md as missing-content (no leading newline)', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    writeFileSync(claudeMdPath, '')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content.startsWith(OPEN_MARKER)).toBe(true)
  })
})

describe('runInstall — AC2 interactive prompt parser (parseYesNo)', () => {
  it('treats y / yes (any case, padded) as opt-in', () => {
    expect(parseYesNo('y')).toBe(true)
    expect(parseYesNo('Y')).toBe(true)
    expect(parseYesNo('yes')).toBe(true)
    expect(parseYesNo('YES')).toBe(true)
    expect(parseYesNo('  yes  ')).toBe(true)
    expect(parseYesNo('Yes\n')).toBe(true)
  })

  it('treats n / empty / anything else as opt-out', () => {
    expect(parseYesNo('n')).toBe(false)
    expect(parseYesNo('no')).toBe(false)
    expect(parseYesNo('')).toBe(false)
    expect(parseYesNo('   ')).toBe(false)
    expect(parseYesNo('maybe')).toBe(false)
    expect(parseYesNo('yep')).toBe(false)
  })
})

describe('runInstall — AC2 non-TTY fallback (no explicit decision)', () => {
  let repoRoot: string
  let originalIsTTY: boolean | undefined

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
    originalIsTTY = process.stdin.isTTY
    // Force non-TTY so the test is deterministic regardless of the runner.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('skips the CLAUDE.md mutation entirely and logs the skip', async () => {
    const logger = makeLogger()
    await runInstall(repoRoot, { logger })
    // CLAUDE.md is neither created nor touched.
    expect(existsSync(join(repoRoot, 'CLAUDE.md'))).toBe(false)
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/non-interactive shell/i)
    expect(allLogs).toMatch(/skipped/i)
    // SKILL.md + .gitignore still happen regardless of the prompt.
    expect(existsSync(join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(repoRoot, '.gitignore'))).toBe(true)
  })

  it('does not strip an existing block on a non-TTY skip', async () => {
    // Pre-seed a YES install, then re-run with no decision on a non-TTY: the
    // block must survive (skip ≠ strip).
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    await runInstall(repoRoot, { logger: makeLogger() })
    const content = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')
    expect(content).toContain(OPEN_MARKER)
    expect(content).toContain(CLOSE_MARKER)
  })
})

describe('runInstall — AC4 opt-in NO strips the block (toggle off)', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('removes a previously-appended block', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: no })
    const content = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')
    expect(content).not.toContain(OPEN_MARKER)
    expect(content).not.toContain(CLOSE_MARKER)
  })

  it('preserves surrounding hand-written content when stripping', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    writeFileSync(claudeMdPath, '# My project rules\n\nKeep me.\n')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: no })
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain('# My project rules')
    expect(content).toContain('Keep me.')
    expect(content).not.toContain(OPEN_MARKER)
  })

  it('is a no-op when no block is present (file exists, no marker)', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    writeFileSync(claudeMdPath, '# Just my rules\n')
    const logger = makeLogger()
    await runInstall(repoRoot, { logger, confirmAutoInvoke: no })
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toBe('# Just my rules\n')
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/no block to remove/i)
  })

  it('never creates CLAUDE.md on a NO answer when the file is absent', async () => {
    const logger = makeLogger()
    await runInstall(repoRoot, { logger, confirmAutoInvoke: no })
    expect(existsSync(join(repoRoot, 'CLAUDE.md'))).toBe(false)
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/no block to remove/i)
  })

  it('strips a malformed block (opening marker, missing closing marker) to EOF', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    // User deleted the close tag but left the open marker + body.
    writeFileSync(claudeMdPath, `# Header\n\n${OPEN_MARKER}\nsome body text\n`)
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: no })
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain('# Header')
    expect(content).not.toContain(OPEN_MARKER)
    expect(content).not.toContain('some body text')
  })

  it('YES → NO → YES is byte-stable (re-append matches first append)', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    writeFileSync(claudeMdPath, '# Pre-existing\n')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const afterFirstYes = readFileSync(claudeMdPath, 'utf8')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: no })
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const afterSecondYes = readFileSync(claudeMdPath, 'utf8')
    expect(afterSecondYes).toBe(afterFirstYes)
  })

  it('strips to zero-length file when CLAUDE.md contained only the block (AC4 empty-file guard)', async () => {
    // YES creates CLAUDE.md with block as its only content (file was absent).
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    // NO must leave a zero-length file — never delete it (it may be tracked).
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: no })
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    expect(existsSync(claudeMdPath)).toBe(true)
    expect(readFileSync(claudeMdPath, 'utf8')).toBe('')
  })
})

describe('runInstall — AC7 scaffolded block names create-PR intent, no ship-it', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('writes a block that references create-PR intent and contains no ship-it reference', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const content = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')
    // Assert against the INSTALLED block, not the template file (catches any
    // write-time mangling / truncation).
    expect(content.toLowerCase()).toMatch(/create a pr|open a pr|pr creation/)
    expect(content).not.toContain('ship-it')
  })
})

describe('runInstall — AC3 .gitignore append', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('appends .delfini-trace/ to .gitignore on first run', async () => {
    await runInstall(repoRoot, { logger: makeLogger() })
    const gitignorePath = join(repoRoot, '.gitignore')
    expect(existsSync(gitignorePath)).toBe(true)
    const content = readFileSync(gitignorePath, 'utf8')
    expect(content).toContain('.delfini-trace/')
  })

  it('does not duplicate .delfini-trace/ on re-run', async () => {
    await runInstall(repoRoot, { logger: makeLogger() })
    await runInstall(repoRoot, { logger: makeLogger() })
    const content = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
    // Exactly one occurrence of the line.
    const matches = content.match(/^\.delfini-trace\/$/gm)
    expect(matches).toHaveLength(1)
  })

  it('respects pre-existing .gitignore contents', async () => {
    const gitignorePath = join(repoRoot, '.gitignore')
    writeFileSync(gitignorePath, 'node_modules\ndist\n')
    await runInstall(repoRoot, { logger: makeLogger() })
    const content = readFileSync(gitignorePath, 'utf8')
    expect(content).toContain('node_modules\n')
    expect(content).toContain('dist\n')
    expect(content).toContain('.delfini-trace/')
  })
})

describe('runInstall — AC6 marker-absence restores block (opt-in YES)', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('re-appends the block if the user manually removed it', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    // Simulate user removing the entire block (and everything between).
    writeFileSync(claudeMdPath, '# I removed the delfini block\n')
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain('# I removed the delfini block')
    expect(content).toContain(OPEN_MARKER)
    expect(content).toContain(CLOSE_MARKER)
  })

  it('detects opening-marker substring (no parsing required)', async () => {
    const claudeMdPath = join(repoRoot, 'CLAUDE.md')
    // File contains the opening marker but with no body and no closing marker.
    writeFileSync(claudeMdPath, `# Header\n${OPEN_MARKER}\n`)
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const content = readFileSync(claudeMdPath, 'utf8')
    // Block was treated as present → only one opening marker, no closing.
    const openCount = content.match(new RegExp(escapeRegex(OPEN_MARKER), 'g'))?.length ?? 0
    expect(openCount).toBe(1)
  })
})

describe('runInstall — AC5 --tool CLAUDE only', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('default tool (omitted) is CLAUDE — succeeds', async () => {
    await expect(runInstall(repoRoot, { logger: makeLogger() })).resolves.toBeUndefined()
  })

  it("explicit --tool 'CLAUDE' succeeds", async () => {
    await expect(
      runInstall(repoRoot, { tool: 'CLAUDE', logger: makeLogger() }),
    ).resolves.toBeUndefined()
  })

  it("rejects --tool 'CURSOR' with InstallToolNotSupportedError", async () => {
    await expect(
      runInstall(repoRoot, { tool: 'CURSOR', logger: makeLogger() }),
    ).rejects.toBeInstanceOf(InstallToolNotSupportedError)
  })

  it('error message references NG2', async () => {
    await expect(
      runInstall(repoRoot, { tool: 'cursor', logger: makeLogger() }),
    ).rejects.toThrow(/NG2/)
  })

  it('error fires BEFORE git-root detection (cheap check first)', async () => {
    // Pass a non-git path; if tool validation runs first the InstallTool error wins.
    const nonGit = mkTmp()
    try {
      await expect(
        runInstall(nonGit, { tool: 'AIDER', logger: makeLogger() }),
      ).rejects.toBeInstanceOf(InstallToolNotSupportedError)
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('tool comparison is case-sensitive — lowercase claude is rejected', async () => {
    await expect(
      runInstall(repoRoot, { tool: 'claude', logger: makeLogger() }),
    ).rejects.toBeInstanceOf(InstallToolNotSupportedError)
  })
})

describe('runInstall — AC6 git-root detection failure', () => {
  let nonGitDir: string

  beforeEach(() => {
    nonGitDir = mkTmp()
  })

  afterEach(() => {
    rmSync(nonGitDir, { recursive: true, force: true })
  })

  it('rejects with RepoRootNotFoundError when path is not inside a git repo', async () => {
    await expect(runInstall(nonGitDir, { logger: makeLogger() })).rejects.toBeInstanceOf(
      RepoRootNotFoundError,
    )
  })

  it('error message mentions git repository', async () => {
    await expect(runInstall(nonGitDir, { logger: makeLogger() })).rejects.toThrow(
      /not inside a git repository/,
    )
  })
})

describe('runInstall — AC10 logging', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('logs the SKILL.md write target', async () => {
    const logger = makeLogger()
    await runInstall(repoRoot, { logger })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toContain('SKILL.md')
  })

  it('logs CLAUDE.md "created" on first run when CLAUDE.md was absent', async () => {
    const logger = makeLogger()
    await runInstall(repoRoot, { logger, confirmAutoInvoke: yes })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/CLAUDE\.md/)
    expect(allLogs).toMatch(/created/)
  })

  it('logs CLAUDE.md "block already present" on idempotent re-run', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const logger = makeLogger()
    await runInstall(repoRoot, { logger, confirmAutoInvoke: yes })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/already present/)
  })

  it('logs CLAUDE.md "block removed" on opt-in NO', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const logger = makeLogger()
    await runInstall(repoRoot, { logger, confirmAutoInvoke: no })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/block removed/)
  })

  it('logs CLAUDE.md "block appended" when file exists but has no marker', async () => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# Existing\n')
    const logger = makeLogger()
    await runInstall(repoRoot, { logger, confirmAutoInvoke: yes })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/block appended/)
  })

  it('logs .gitignore "appended" on first run', async () => {
    const logger = makeLogger()
    await runInstall(repoRoot, { logger })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/\.gitignore/)
    expect(allLogs).toMatch(/appended/)
  })

  it('logs .gitignore "already present" on idempotent re-run', async () => {
    await runInstall(repoRoot, { logger: makeLogger() })
    const logger = makeLogger()
    await runInstall(repoRoot, { logger })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/already present/)
  })

  it('uses console as the default logger when none is provided', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runInstall(repoRoot)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('runInstall — AC11 success returns void (no process.exit)', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('resolves with undefined on success', async () => {
    const result = await runInstall(repoRoot, { logger: makeLogger() })
    expect(result).toBeUndefined()
  })
})

describe('runInstall — determinism (NFR46 spirit)', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('two successive runs on the same repo produce byte-identical artefacts', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const skillFirst = readFileSync(join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md'))
    const claudeFirst = readFileSync(join(repoRoot, 'CLAUDE.md'))
    const gitignoreFirst = readFileSync(join(repoRoot, '.gitignore'))

    await runInstall(repoRoot, { logger: makeLogger(), confirmAutoInvoke: yes })
    const skillSecond = readFileSync(join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md'))
    const claudeSecond = readFileSync(join(repoRoot, 'CLAUDE.md'))
    const gitignoreSecond = readFileSync(join(repoRoot, '.gitignore'))

    expect(skillSecond).toEqual(skillFirst)
    expect(claudeSecond).toEqual(claudeFirst)
    expect(gitignoreSecond).toEqual(gitignoreFirst)
  })
})

// ---------------------------------------------------------------------------
// doc-scope.json seeding (interactive scope prompt + --scope seam)
// ---------------------------------------------------------------------------

describe('parseScopeInput — free-text path list parser', () => {
  it('splits on whitespace, trims, drops empties', () => {
    expect(parseScopeInput('docs/ specs/architecture.md')).toEqual([
      'docs/',
      'specs/architecture.md',
    ])
    expect(parseScopeInput('  docs/   README.md  ')).toEqual(['docs/', 'README.md'])
  })

  it('splits on commas and mixed comma/space', () => {
    expect(parseScopeInput('docs/,specs/a.md')).toEqual(['docs/', 'specs/a.md'])
    expect(parseScopeInput('docs/, specs/a.md ,  b.md')).toEqual([
      'docs/',
      'specs/a.md',
      'b.md',
    ])
  })

  it('returns an empty array for blank / whitespace-only input', () => {
    expect(parseScopeInput('')).toEqual([])
    expect(parseScopeInput('   ')).toEqual([])
    expect(parseScopeInput(' , , ')).toEqual([])
  })
})

describe('runInstall — doc-scope.json seeding via provideDocScope', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('writes doc-scope.json with the canonical v1 shape from a non-empty list', async () => {
    await runInstall(repoRoot, {
      logger: makeLogger(),
      provideDocScope: scope(['docs/', 'specs/architecture.md']),
    })
    expect(existsSync(join(repoRoot, DOC_SCOPE_REL))).toBe(true)
    const parsed = await readConfig(repoRoot)
    expect(parsed).toEqual({ version: 1, doc_scope: ['docs', 'specs/architecture.md'], ignore_code_scope: [] })
  })

  it('does not write doc-scope.json when the list is empty (no-op)', async () => {
    const logger = makeLogger()
    await runInstall(repoRoot, { logger, provideDocScope: scope([]) })
    expect(existsSync(join(repoRoot, DOC_SCOPE_REL))).toBe(false)
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/delfini-config\.json/)
    expect(allLogs).toMatch(/no paths provided/i)
  })

  it('drops blank entries from the provided list before writing', async () => {
    await runInstall(repoRoot, {
      logger: makeLogger(),
      provideDocScope: scope(['docs/', '  ', '']),
    })
    const parsed = await readConfig(repoRoot)
    expect(parsed).toEqual({ version: 1, doc_scope: ['docs'], ignore_code_scope: [] })
  })

  it('overwrites an existing scope when --scope/seam is given (explicit intent)', async () => {
    await runInstall(repoRoot, { logger: makeLogger(), provideDocScope: scope(['docs/']) })
    await runInstall(repoRoot, {
      logger: makeLogger(),
      provideDocScope: scope(['specs/', 'README.md']),
    })
    const parsed = await readConfig(repoRoot)
    expect(parsed).toEqual({ version: 1, doc_scope: ['specs', 'README.md'], ignore_code_scope: [] })
  })

  it('warn-and-skips an invalid path (escape) without aborting the scaffold', async () => {
    const logger = makeLogger()
    // `../outside` escapes the repo root — rejected by writeDocScope.
    await expect(
      runInstall(repoRoot, { logger, provideDocScope: scope(['../outside']) }),
    ).resolves.toBeUndefined()
    // doc-scope.json NOT written…
    expect(existsSync(join(repoRoot, DOC_SCOPE_REL))).toBe(false)
    // …but the rest of the scaffold still completed.
    expect(existsSync(join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(repoRoot, '.gitignore'))).toBe(true)
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/delfini-config\.json.*skipped/i)
  })
})

describe('runInstall — doc-scope.json default (no seam) behaviour', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkGitRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('skips the scope prompt on a non-TTY stdin and writes nothing', async () => {
    // The file-level beforeAll forces isTTY=false, so a no-seam call hits skip.
    const logger = makeLogger()
    await runInstall(repoRoot, { logger })
    expect(existsSync(join(repoRoot, DOC_SCOPE_REL))).toBe(false)
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/non-interactive shell: scope prompt skipped/i)
  })

  it('never clobbers an already-configured scope on a no-seam re-run', async () => {
    // Seed a scope, then re-run install with NO seam: the file must survive.
    await runInstall(repoRoot, { logger: makeLogger(), provideDocScope: scope(['docs/']) })
    const logger = makeLogger()
    await runInstall(repoRoot, { logger })
    const parsed = await readConfig(repoRoot)
    expect(parsed).toEqual({ version: 1, doc_scope: ['docs'], ignore_code_scope: [] })
    const allLogs = logger.log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogs).toMatch(/already configured/i)
  })
})

// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
