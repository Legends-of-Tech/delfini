import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendToGitignore,
  ensureTraceDir,
  writeRetryAttemptFile,
  writeTraceFile,
} from '../src/index.js'

const TRACE_DIR = '.delfini-trace'

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'delfini-trace-test-'))
}

describe('ensureTraceDir', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkTmp()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates .delfini-trace/ when missing', () => {
    const result = ensureTraceDir(tmpDir)
    expect(result).toBe(join(tmpDir, TRACE_DIR))
    expect(existsSync(result)).toBe(true)
    expect(statSync(result).isDirectory()).toBe(true)
  })

  it('no-ops on a second call and returns the same path', () => {
    const first = ensureTraceDir(tmpDir)
    const second = ensureTraceDir(tmpDir)
    expect(second).toBe(first)
    expect(statSync(first).isDirectory()).toBe(true)
  })

  it('throws when .delfini-trace exists as a regular file', () => {
    const conflictingPath = join(tmpDir, TRACE_DIR)
    writeFileSync(conflictingPath, 'oops not a directory')
    expect(() => ensureTraceDir(tmpDir)).toThrow(/\.delfini-trace/)
  })

  it('returns an absolute path', () => {
    const result = ensureTraceDir(tmpDir)
    // mkdtempSync returns absolute path on every supported platform; the
    // trace dir lives inside it, so result is absolute.
    expect(result.startsWith(tmpDir)).toBe(true)
  })
})

describe('appendToGitignore', () => {
  let tmpDir: string
  let gitignorePath: string

  beforeEach(() => {
    tmpDir = mkTmp()
    gitignorePath = join(tmpDir, '.gitignore')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates .gitignore with `.delfini-trace/\\n` when missing → { changed: true }', () => {
    const result = appendToGitignore(tmpDir)
    expect(result).toEqual({ changed: true })
    expect(existsSync(gitignorePath)).toBe(true)
    expect(readFileSync(gitignorePath, 'utf8')).toBe('.delfini-trace/\n')
  })

  it('no-ops when the exact line already exists → { changed: false }', () => {
    writeFileSync(gitignorePath, 'node_modules\n.delfini-trace/\nfoo\n')
    const before = readFileSync(gitignorePath)
    const result = appendToGitignore(tmpDir)
    expect(result).toEqual({ changed: false })
    const after = readFileSync(gitignorePath)
    expect(after).toEqual(before)
  })

  it('is not fooled by `.delfini-trace` (no trailing slash) — still appends', () => {
    writeFileSync(gitignorePath, '.delfini-trace\n')
    const result = appendToGitignore(tmpDir)
    expect(result).toEqual({ changed: true })
    const content = readFileSync(gitignorePath, 'utf8')
    expect(content).toContain('.delfini-trace\n')
    expect(content).toContain('.delfini-trace/')
  })

  it('is not fooled by `# .delfini-trace/` (commented-out) — still appends', () => {
    writeFileSync(gitignorePath, '# .delfini-trace/\n')
    const result = appendToGitignore(tmpDir)
    expect(result).toEqual({ changed: true })
    const lines = readFileSync(gitignorePath, 'utf8').split('\n')
    expect(lines).toContain('.delfini-trace/')
  })

  it('is not fooled by `!.delfini-trace/` (negation) — still appends', () => {
    writeFileSync(gitignorePath, '!.delfini-trace/\n')
    const result = appendToGitignore(tmpDir)
    expect(result).toEqual({ changed: true })
    const lines = readFileSync(gitignorePath, 'utf8').split('\n')
    expect(lines).toContain('.delfini-trace/')
  })

  it('preserves LF line endings when the existing file is pure LF', () => {
    writeFileSync(gitignorePath, 'node_modules\nfoo\n')
    appendToGitignore(tmpDir)
    const raw = readFileSync(gitignorePath, 'utf8')
    expect(raw.includes('\r\n')).toBe(false)
    expect(raw).toBe('node_modules\nfoo\n.delfini-trace/\n')
  })

  it('preserves CRLF line endings when the existing file uses CRLF', () => {
    writeFileSync(gitignorePath, 'node_modules\r\nfoo\r\n')
    appendToGitignore(tmpDir)
    const raw = readFileSync(gitignorePath, 'utf8')
    expect(raw).toBe('node_modules\r\nfoo\r\n.delfini-trace/\r\n')
  })

  it('adds a leading newline when the existing file does not end in a newline', () => {
    writeFileSync(gitignorePath, 'node_modules')
    appendToGitignore(tmpDir)
    const raw = readFileSync(gitignorePath, 'utf8')
    expect(raw).toBe('node_modules\n.delfini-trace/\n')
  })

  it('adds a leading CRLF when CRLF-style file does not end in a newline', () => {
    writeFileSync(gitignorePath, 'node_modules\r\nfoo')
    appendToGitignore(tmpDir)
    const raw = readFileSync(gitignorePath, 'utf8')
    expect(raw).toBe('node_modules\r\nfoo\r\n.delfini-trace/\r\n')
  })

  it('is idempotent — running twice in succession is byte-identical to running once', () => {
    appendToGitignore(tmpDir)
    const afterFirst = readFileSync(gitignorePath)
    const second = appendToGitignore(tmpDir)
    expect(second).toEqual({ changed: false })
    const afterSecond = readFileSync(gitignorePath)
    expect(afterSecond).toEqual(afterFirst)
  })

  it('handles an empty .gitignore file', () => {
    writeFileSync(gitignorePath, '')
    const result = appendToGitignore(tmpDir)
    expect(result).toEqual({ changed: true })
    expect(readFileSync(gitignorePath, 'utf8')).toBe('.delfini-trace/\n')
  })
})

describe('writeTraceFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkTmp()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes content byte-for-byte to <repoRoot>/.delfini-trace/<filename>', () => {
    const content = '{"foo":"bar"}'
    const result = writeTraceFile(tmpDir, 'analysis-input.json', content)
    expect(result).toBe(join(tmpDir, TRACE_DIR, 'analysis-input.json'))
    expect(readFileSync(result, 'utf8')).toBe(content)
  })

  it('overwrites existing content on a second call', () => {
    writeTraceFile(tmpDir, 'report.md', 'first')
    const second = writeTraceFile(tmpDir, 'report.md', 'second')
    expect(readFileSync(second, 'utf8')).toBe('second')
  })

  it('calls ensureTraceDir implicitly (works on a fresh tmp dir)', () => {
    expect(existsSync(join(tmpDir, TRACE_DIR))).toBe(false)
    const result = writeTraceFile(tmpDir, 'schema.json', '{}')
    expect(existsSync(result)).toBe(true)
    expect(statSync(join(tmpDir, TRACE_DIR)).isDirectory()).toBe(true)
  })

  it('throws on filenames containing /', () => {
    expect(() => writeTraceFile(tmpDir, 'sub/file.json', '{}')).toThrow()
  })

  it('throws on filenames containing \\', () => {
    expect(() => writeTraceFile(tmpDir, 'sub\\file.json', '{}')).toThrow()
  })

  it('throws on `..`', () => {
    expect(() => writeTraceFile(tmpDir, '..', '{}')).toThrow()
  })

  it('throws on `.`', () => {
    expect(() => writeTraceFile(tmpDir, '.', '{}')).toThrow()
  })

  it('throws on path-traversal attempt `../escaped.json`', () => {
    expect(() => writeTraceFile(tmpDir, '../escaped.json', '{}')).toThrow()
  })

  it('throws on filenames starting with /', () => {
    expect(() => writeTraceFile(tmpDir, '/absolute', '{}')).toThrow()
  })

  it('throws on empty filename', () => {
    expect(() => writeTraceFile(tmpDir, '', '{}')).toThrow()
  })

  it('returns the absolute path of the written file', () => {
    const result = writeTraceFile(tmpDir, 'foo.json', '{}')
    expect(result).toBe(join(tmpDir, TRACE_DIR, 'foo.json'))
  })

  it('determinism — writing the same content twice produces a byte-identical file', () => {
    const content = '{"a":1,"b":2}'
    writeTraceFile(tmpDir, 'analysis-input.json', content)
    const first = readFileSync(join(tmpDir, TRACE_DIR, 'analysis-input.json'))
    writeTraceFile(tmpDir, 'analysis-input.json', content)
    const second = readFileSync(join(tmpDir, TRACE_DIR, 'analysis-input.json'))
    expect(second).toEqual(first)
  })

  it('NFR46 — byte-identical re-runs across a full dir tear-down + rebuild', () => {
    const fixtureA = '{"deterministic":"payload","ints":[1,2,3]}'
    const repoRoot = tmpDir
    const target = writeTraceFile(repoRoot, 'analysis-input.json', fixtureA)
    const readFirst = readFileSync(target)
    rmSync(join(repoRoot, TRACE_DIR), { recursive: true })
    writeTraceFile(repoRoot, 'analysis-input.json', fixtureA)
    const readSecond = readFileSync(target)
    expect(readSecond).toEqual(readFirst)
  })

  it('writes empty content faithfully', () => {
    const result = writeTraceFile(tmpDir, 'empty.json', '')
    expect(readFileSync(result, 'utf8')).toBe('')
  })

  it('does not inject a trailing newline if caller did not pass one', () => {
    const result = writeTraceFile(tmpDir, 'no-trailing.txt', 'abc')
    const raw = readFileSync(result, 'utf8')
    expect(raw).toBe('abc')
    expect(raw.endsWith('\n')).toBe(false)
  })
})

describe('writeRetryAttemptFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkTmp()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes findings-attempt-1.json when attemptNumber === 1', () => {
    const result = writeRetryAttemptFile(tmpDir, 1, '{"raw":"attempt1"}')
    expect(result).toBe(join(tmpDir, TRACE_DIR, 'findings-attempt-1.json'))
    expect(readFileSync(result, 'utf8')).toBe('{"raw":"attempt1"}')
  })

  it('writes findings-attempt-2.json when attemptNumber === 2', () => {
    const result = writeRetryAttemptFile(tmpDir, 2, '{"raw":"attempt2"}')
    expect(result).toBe(join(tmpDir, TRACE_DIR, 'findings-attempt-2.json'))
    expect(readFileSync(result, 'utf8')).toBe('{"raw":"attempt2"}')
  })

  it('throws at runtime when called with an attemptNumber outside 1 | 2 (cast via as)', () => {
    expect(() => writeRetryAttemptFile(tmpDir, 3 as 1 | 2, '{}')).toThrow(
      /attemptNumber must be 1 or 2/,
    )
    expect(() => writeRetryAttemptFile(tmpDir, 0 as 1 | 2, '{}')).toThrow(
      /attemptNumber must be 1 or 2/,
    )
    expect(() => writeRetryAttemptFile(tmpDir, -1 as 1 | 2, '{}')).toThrow(
      /attemptNumber must be 1 or 2/,
    )
  })

  it('returns the absolute path of the written file', () => {
    const result = writeRetryAttemptFile(tmpDir, 1, '{}')
    expect(result).toBe(join(tmpDir, TRACE_DIR, 'findings-attempt-1.json'))
  })

  it('both attempt files coexist after writing attempt 1 then attempt 2 (no overwrite between attempts)', () => {
    const a1 = writeRetryAttemptFile(tmpDir, 1, '{"first":true}')
    const a2 = writeRetryAttemptFile(tmpDir, 2, '{"second":true}')
    expect(existsSync(a1)).toBe(true)
    expect(existsSync(a2)).toBe(true)
    expect(readFileSync(a1, 'utf8')).toBe('{"first":true}')
    expect(readFileSync(a2, 'utf8')).toBe('{"second":true}')
  })
})
