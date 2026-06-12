import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import {
  DOC_SCOPE_RELATIVE_PATH,
  DOC_SCOPE_VERSION,
  DocScopeCorruptError,
  DocScopeValidationError,
  DocScopeVersionMismatchError,
  deleteDocScope,
  docScopeExists,
  expandDocScope,
  readDocScope,
  writeDocScope,
} from '../src/doc-scope.js'

// Helper: build a fresh fake repo root under os.tmpdir() per test.
async function makeTempRepoRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `delfini-cli-doc-scope-${crypto.randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  // Bare `.git` dir is enough for tests that don't shell out to git — but
  // we don't pass `repoRoot` through `getRepoRoot()` in these tests; we
  // hand `repoRoot` in explicitly to keep this file fs-only.
  return root
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
}

describe('doc-scope.ts — constants', () => {
  it('exports the canonical relative path for doc-scope.json', () => {
    expect(DOC_SCOPE_RELATIVE_PATH).toBe('.claude/skills/delfini/doc-scope.json')
  })

  it('exports the current schema version (1)', () => {
    expect(DOC_SCOPE_VERSION).toBe(1)
  })
})

describe('readDocScope', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('returns null when doc-scope.json does not exist', async () => {
    const result = await readDocScope(repoRoot)
    expect(result).toBeNull()
  })

  it('returns the parsed v1 schema for a well-formed file', async () => {
    const target = path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(
      target,
      JSON.stringify({ version: 1, doc_scope: ['docs/', 'README.md'] }),
      'utf8',
    )

    const result = await readDocScope(repoRoot)
    expect(result).toEqual({ version: 1, doc_scope: ['docs/', 'README.md'] })
  })

  it('throws DocScopeVersionMismatchError (code DOC_SCOPE_VERSION_MISMATCH) when version > 1', async () => {
    const target = path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify({ version: 2, doc_scope: ['docs/'] }), 'utf8')

    await expect(readDocScope(repoRoot)).rejects.toMatchObject({
      code: 'DOC_SCOPE_VERSION_MISMATCH',
      message: 'your doc-scope.json is for a newer @delfini/cli; please upgrade.',
    })
    await expect(readDocScope(repoRoot)).rejects.toBeInstanceOf(DocScopeVersionMismatchError)
  })

  it('throws DocScopeCorruptError for malformed JSON', async () => {
    const target = path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{ not-valid-json', 'utf8')

    await expect(readDocScope(repoRoot)).rejects.toBeInstanceOf(DocScopeCorruptError)
    await expect(readDocScope(repoRoot)).rejects.toMatchObject({ code: 'DOC_SCOPE_CORRUPT' })
  })

  it('throws DocScopeCorruptError for valid JSON that fails Zod', async () => {
    const target = path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(
      target,
      JSON.stringify({ version: 1, doc_scope: 'not-an-array' }),
      'utf8',
    )

    await expect(readDocScope(repoRoot)).rejects.toBeInstanceOf(DocScopeCorruptError)
  })

  it('accepts an explicit repoRoot parameter and reads from there', async () => {
    const target = path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify({ version: 1, doc_scope: ['x'] }), 'utf8')

    const result = await readDocScope(repoRoot)
    expect(result?.doc_scope).toEqual(['x'])
  })
})

describe('writeDocScope', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('creates .claude/skills/delfini/ when absent and writes valid v1 JSON', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    const written = await fs.readFile(path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH), 'utf8')
    expect(written.endsWith('\n')).toBe(true)
    // P3.6.1 normalize strengthening: trailing slashes are stripped at write
    // time (not a regression — the engine's normalizeDocScope makes the
    // persisted form canonical so picomatch can match it consistently).
    expect(JSON.parse(written)).toEqual({ version: 1, doc_scope: ['docs'] })
  })

  it('P3.6.1 normalize strengthening: collapses //, ./ and .. segments at write time (not a regression)', async () => {
    // The engine's normalizeDocScope runs a real POSIX path normalisation per
    // entry. Same dedupe rules: first-occurrence order preserved. picomatch
    // can actually match these canonical forms — the previous CLI passed the
    // literal strings through to fast-glob, which would silently no-match on
    // e.g. `docs//api`.
    await writeDocScope(
      ['docs//api', './docs', 'docs/sub/../api/*.md'],
      { repoRoot },
    )
    const written = await fs.readFile(path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH), 'utf8')
    expect(JSON.parse(written)).toEqual({
      version: 1,
      doc_scope: ['docs/api', 'docs', 'docs/api/*.md'],
    })
  })

  it('overwrites an existing file', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    await writeDocScope(['specs/architecture.md'], { repoRoot })

    const result = await readDocScope(repoRoot)
    expect(result).toEqual({ version: 1, doc_scope: ['specs/architecture.md'] })
  })

  it('rejects an empty paths array with DocScopeValidationError', async () => {
    await expect(writeDocScope([], { repoRoot })).rejects.toBeInstanceOf(DocScopeValidationError)
    await expect(writeDocScope([], { repoRoot })).rejects.toMatchObject({
      code: 'DOC_SCOPE_VALIDATION',
    })
  })

  it('rejects an absolute path with a clear error', async () => {
    const absolute = path.resolve(repoRoot, 'docs')
    await expect(writeDocScope([absolute], { repoRoot })).rejects.toThrow(/relative to the repo root/)
  })

  it('rejects a path that escapes the repo root via ../ segments', async () => {
    await expect(writeDocScope(['../etc/passwd'], { repoRoot })).rejects.toThrow(/escapes repo root/)
  })

  it('accepts a relative directory path', async () => {
    await expect(writeDocScope(['docs/'], { repoRoot })).resolves.toBeUndefined()
  })

  it('accepts a relative single-file path', async () => {
    await expect(writeDocScope(['README.md'], { repoRoot })).resolves.toBeUndefined()
  })

  it('accepts a glob pattern', async () => {
    await expect(writeDocScope(['packages/*/README.md'], { repoRoot })).resolves.toBeUndefined()
  })

  it('aggregates multiple validation failures into a single thrown error naming every offending path', async () => {
    try {
      await writeDocScope(['../escape1', '/abs/escape2', 'docs/'], { repoRoot })
      throw new Error('expected writeDocScope to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DocScopeValidationError)
      const msg = (err as Error).message
      expect(msg).toMatch(/\.\.\/escape1/)
      expect(msg).toMatch(/\/abs\/escape2/)
      // The valid entry must NOT appear in the error message
      expect(msg.includes('docs/\n')).toBe(false)
    }
  })

  it('rejects empty-string entries', async () => {
    await expect(writeDocScope([''], { repoRoot })).rejects.toBeInstanceOf(DocScopeValidationError)
  })

  it('rejects a glob whose normalised form escapes the repo root (P3.6.1 full-entry normalize)', async () => {
    // The CLI's previous static-prefix-only check could not see traversal
    // hidden inside a glob portion — `**/../../x`'s static prefix is empty,
    // so the old code returned `'.'` and the escape went undetected. The
    // engine's validateDocScopeEntry normalises the WHOLE entry, so the
    // collapsed form starts with `..` and the escape is caught.
    await expect(
      writeDocScope(['**/../../escape/*.md'], { repoRoot }),
    ).rejects.toThrow(/escapes repo root/)
  })

  it('rejects entries containing ASCII control characters', async () => {
    await expect(
      writeDocScope(['docs/foo\nbar.md'], { repoRoot }),
    ).rejects.toThrow(/control characters/)
  })

  // Review patch (P3.6.2 code review): repo-root tautologies like `.`, `./`,
  // and `docs/..` pass per-entry validation but collapse to nothing under the
  // shared dialect. Without an all-collapse guard, writeDocScope would
  // silently persist `{doc_scope: []}` — a meaningless empty scope with no
  // error. Guard rejects it, mirroring the empty-array rejection.
  it('rejects when every entry collapses to an empty scope after normalisation', async () => {
    await expect(writeDocScope(['.'], { repoRoot })).rejects.toBeInstanceOf(
      DocScopeValidationError,
    )
    await expect(writeDocScope(['.'], { repoRoot })).rejects.toThrow(/empty scope/)
    await expect(writeDocScope(['./', 'docs/..'], { repoRoot })).rejects.toThrow(
      /empty scope/,
    )
    // Confirm NOTHING was persisted (no silent empty doc-scope.json on disk).
    expect(await docScopeExists(repoRoot)).toBe(false)
  })

  it('persists surviving entries when only SOME entries collapse (partial collapse is not an error)', async () => {
    // `docs` survives, `.` collapses out — that is the documented dedupe /
    // normalize behaviour, not an error. The guard only fires on TOTAL
    // collapse.
    await writeDocScope(['docs', '.'], { repoRoot })
    const result = await readDocScope(repoRoot)
    expect(result).toEqual({ version: 1, doc_scope: ['docs'] })
  })
})

describe('docScopeExists', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('returns false for a fresh repo', async () => {
    expect(await docScopeExists(repoRoot)).toBe(false)
  })

  it('returns true after writeDocScope', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    expect(await docScopeExists(repoRoot)).toBe(true)
  })

  it('returns true for a malformed file (presence-only check)', async () => {
    const target = path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'not json at all', 'utf8')
    expect(await docScopeExists(repoRoot)).toBe(true)
  })

  // Review patch F2: a directory at the JSON path is reported as not-exists,
  // not as exists. fs.access would incorrectly answer true; fs.stat + isFile()
  // surfaces the truth so readDocScope doesn't surface an opaque EISDIR.
  it('returns false when a directory occupies the doc-scope.json path', async () => {
    const target = path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH)
    await fs.mkdir(target, { recursive: true })
    expect(await docScopeExists(repoRoot)).toBe(false)
  })
})

describe('deleteDocScope', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('removes the file when present', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    expect(await docScopeExists(repoRoot)).toBe(true)
    await deleteDocScope(repoRoot)
    expect(await docScopeExists(repoRoot)).toBe(false)
  })

  it('is idempotent — no error when file already absent', async () => {
    await expect(deleteDocScope(repoRoot)).resolves.toBeUndefined()
  })

  it('does NOT delete the enclosing .claude/skills/delfini/ directory', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    // Write a sibling file to simulate SKILL.md being present
    const siblingPath = path.join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md')
    await fs.writeFile(siblingPath, '# SKILL.md placeholder\n', 'utf8')

    await deleteDocScope(repoRoot)

    // Sibling must survive
    await expect(fs.access(siblingPath)).resolves.toBeUndefined()
  })
})

describe('expandDocScope', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('expands a directory entry to its recursive .md children', async () => {
    await fs.mkdir(path.join(repoRoot, 'docs', 'sub'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'docs', 'a.md'), '# a', 'utf8')
    await fs.writeFile(path.join(repoRoot, 'docs', 'sub', 'b.md'), '# b', 'utf8')
    await fs.writeFile(path.join(repoRoot, 'docs', 'sub', 'c.txt'), 'not md', 'utf8')

    const result = await expandDocScope(['docs/'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot)).sort()).toEqual([
      'docs/a.md',
      'docs/sub/b.md',
    ])
    expect(result.missingPaths).toEqual([])
  })

  it('includes a single-file entry verbatim', async () => {
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# r', 'utf8')

    const result = await expandDocScope(['README.md'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot))).toEqual(['README.md'])
  })

  it('includes a single non-.md file verbatim (caller filters)', async () => {
    await fs.writeFile(path.join(repoRoot, 'NOTES.txt'), 'plain text', 'utf8')

    const result = await expandDocScope(['NOTES.txt'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot))).toEqual(['NOTES.txt'])
  })

  it('expands a glob entry via tinyglobby', async () => {
    await fs.mkdir(path.join(repoRoot, 'packages', 'pkg-a'), { recursive: true })
    await fs.mkdir(path.join(repoRoot, 'packages', 'pkg-b'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'packages', 'pkg-a', 'README.md'), '# a', 'utf8')
    await fs.writeFile(path.join(repoRoot, 'packages', 'pkg-b', 'README.md'), '# b', 'utf8')

    const result = await expandDocScope(['packages/*/README.md'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot)).sort()).toEqual([
      'packages/pkg-a/README.md',
      'packages/pkg-b/README.md',
    ])
  })

  it('adds non-existent entries to missingPaths and continues with surviving paths', async () => {
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# r', 'utf8')

    const result = await expandDocScope(['README.md', 'does/not/exist.md'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot))).toEqual(['README.md'])
    expect(result.missingPaths).toEqual(['does/not/exist.md'])
  })

  it('deduplicates files matched by both a directory entry and a glob entry', async () => {
    await fs.mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'docs', 'shared.md'), '# s', 'utf8')

    const result = await expandDocScope(['docs/', 'docs/*.md'], repoRoot)
    const rels = result.files.map(toRepoRel.bind(null, repoRoot))
    expect(rels).toEqual(['docs/shared.md'])
  })

  // Review patch (P3.6.2 code review): a non-empty user entry that collapses
  // to nothing under the shared dialect (`.`, `./`, `docs/..`) must surface as
  // a missing path so the caller emits a "Skipped" warning — not vanish
  // silently. A genuinely empty / whitespace-only entry stays silent.
  it('surfaces collapse-to-empty entries (`.`, `docs/..`) as missingPaths, not silent drops', async () => {
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# r', 'utf8')

    const result = await expandDocScope(['README.md', '.', 'docs/..'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot))).toEqual(['README.md'])
    expect(result.missingPaths).toEqual(['.', 'docs/..'])
  })

  it('skips genuinely empty / whitespace-only entries silently (no missingPaths noise)', async () => {
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# r', 'utf8')

    const result = await expandDocScope(['README.md', '', '   '], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot))).toEqual(['README.md'])
    expect(result.missingPaths).toEqual([])
  })

  it('returns a sorted file list for deterministic output', async () => {
    await fs.mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'docs', 'z.md'), '# z', 'utf8')
    await fs.writeFile(path.join(repoRoot, 'docs', 'a.md'), '# a', 'utf8')
    await fs.writeFile(path.join(repoRoot, 'docs', 'm.md'), '# m', 'utf8')

    const result = await expandDocScope(['docs/'], repoRoot)
    const rels = result.files.map(toRepoRel.bind(null, repoRoot))
    expect(rels).toEqual([...rels].sort())
  })

  it('does NOT print warnings to stderr', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expandDocScope(['does/not/exist.md'], repoRoot)
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('does NOT mutate doc-scope.json on disk when called with override paths', async () => {
    await writeDocScope(['original/path'], { repoRoot })
    const before = await fs.readFile(path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH), 'utf8')

    await expandDocScope(['some/other/override.md'], repoRoot)

    const after = await fs.readFile(path.join(repoRoot, DOC_SCOPE_RELATIVE_PATH), 'utf8')
    expect(after).toBe(before)
  })

  it('handles Windows-style backslash separators in input entries (normalises before resolve)', async () => {
    await fs.mkdir(path.join(repoRoot, 'docs', 'nested'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'docs', 'nested', 'win.md'), '# w', 'utf8')

    const result = await expandDocScope(['docs\\nested\\win.md'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot))).toEqual(['docs/nested/win.md'])
  })

  // Review patch F1: a hand-edited doc-scope.json could include `../escape`
  // entries that walk outside the repo root. expandDocScope must NOT
  // resolve any file outside the repo root, even via glob or symlink. Such
  // entries route to missingPaths so the caller can warn normally.
  it('treats `../` escape entries as missing (does not walk outside repo root)', async () => {
    // Create a sibling directory at the parent of repoRoot to verify it
    // would have matched if validation was missing.
    const parent = path.dirname(repoRoot)
    const sibling = path.join(parent, `delfini-cli-escape-${Date.now()}`)
    await fs.mkdir(sibling, { recursive: true })
    await fs.writeFile(path.join(sibling, 'leak.md'), '# leak', 'utf8')

    try {
      const result = await expandDocScope(
        [`../${path.basename(sibling)}/leak.md`, `../${path.basename(sibling)}/*.md`],
        repoRoot,
      )
      expect(result.files).toEqual([])
      expect(result.missingPaths.length).toBe(2)
    } finally {
      await fs.rm(sibling, { recursive: true, force: true })
    }
  })

  it('treats absolute-path entries as missing (rejected by validatePath)', async () => {
    const absoluteEntry = path.resolve(repoRoot, 'docs', 'foo.md')
    const result = await expandDocScope([absoluteEntry], repoRoot)
    expect(result.files).toEqual([])
    expect(result.missingPaths).toEqual([absoluteEntry])
  })
})

// Convert absolute path back to repo-root-relative POSIX-style for stable assertions.
function toRepoRel(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join('/')
}
