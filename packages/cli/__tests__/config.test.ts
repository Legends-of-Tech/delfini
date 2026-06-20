import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import {
  DELFINI_CONFIG_RELATIVE_PATH,
  DELFINI_CONFIG_VERSION,
  LEGACY_DOC_SCOPE_RELATIVE_PATH,
  ConfigCorruptError,
  ConfigValidationError,
  ConfigVersionMismatchError,
  configExists,
  deleteConfig,
  expandDocScope,
  readConfig,
  writeConfig,
  writeDocScope,
} from '../src/config.js'

// Helper: build a fresh fake repo root under os.tmpdir() per test.
async function makeTempRepoRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `delfini-cli-config-${crypto.randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  // Bare `.git` dir is enough for tests that don't shell out to git — but
  // we don't pass `repoRoot` through `getRepoRoot()` in these tests; we
  // hand `repoRoot` in explicitly to keep this file fs-only.
  return root
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
}

async function writeRaw(root: string, relPath: string, contents: unknown): Promise<void> {
  const target = path.join(root, relPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(contents), 'utf8')
}

describe('config.ts — constants', () => {
  it('exports the canonical relative path for delfini-config.json', () => {
    expect(DELFINI_CONFIG_RELATIVE_PATH).toBe('.claude/skills/delfini/delfini-config.json')
  })

  it('exports the legacy doc-scope.json path for migration fallback', () => {
    expect(LEGACY_DOC_SCOPE_RELATIVE_PATH).toBe('.claude/skills/delfini/doc-scope.json')
  })

  it('exports the current schema version (1)', () => {
    expect(DELFINI_CONFIG_VERSION).toBe(1)
  })
})

describe('readConfig', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('returns null when no config file exists', async () => {
    const result = await readConfig(repoRoot)
    expect(result).toBeNull()
  })

  it('returns the parsed v1 schema for a well-formed file, defaulting ignore_code_scope to []', async () => {
    await writeRaw(repoRoot, DELFINI_CONFIG_RELATIVE_PATH, {
      version: 1,
      doc_scope: ['docs/', 'README.md'],
    })

    const result = await readConfig(repoRoot)
    expect(result).toEqual({
      version: 1,
      doc_scope: ['docs/', 'README.md'],
      ignore_code_scope: [],
    })
  })

  it('reads ignore_code_scope when present', async () => {
    await writeRaw(repoRoot, DELFINI_CONFIG_RELATIVE_PATH, {
      version: 1,
      doc_scope: ['docs/'],
      ignore_code_scope: ['src/generated/**', 'db/migrations/'],
    })

    const result = await readConfig(repoRoot)
    expect(result).toEqual({
      version: 1,
      doc_scope: ['docs/'],
      ignore_code_scope: ['src/generated/**', 'db/migrations/'],
    })
  })

  it('throws ConfigVersionMismatchError (code CONFIG_VERSION_MISMATCH) when version > 1', async () => {
    await writeRaw(repoRoot, DELFINI_CONFIG_RELATIVE_PATH, { version: 2, doc_scope: ['docs/'] })

    await expect(readConfig(repoRoot)).rejects.toMatchObject({
      code: 'CONFIG_VERSION_MISMATCH',
      message: 'your delfini-config.json is for a newer @delfini/cli; please upgrade.',
    })
    await expect(readConfig(repoRoot)).rejects.toBeInstanceOf(ConfigVersionMismatchError)
  })

  it('throws ConfigCorruptError for malformed JSON', async () => {
    const target = path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{ not-valid-json', 'utf8')

    await expect(readConfig(repoRoot)).rejects.toBeInstanceOf(ConfigCorruptError)
    await expect(readConfig(repoRoot)).rejects.toMatchObject({ code: 'CONFIG_CORRUPT' })
  })

  it('throws ConfigCorruptError for valid JSON that fails Zod', async () => {
    await writeRaw(repoRoot, DELFINI_CONFIG_RELATIVE_PATH, {
      version: 1,
      doc_scope: 'not-an-array',
    })

    await expect(readConfig(repoRoot)).rejects.toBeInstanceOf(ConfigCorruptError)
  })

  it('accepts an explicit repoRoot parameter and reads from there', async () => {
    await writeRaw(repoRoot, DELFINI_CONFIG_RELATIVE_PATH, { version: 1, doc_scope: ['x'] })

    const result = await readConfig(repoRoot)
    expect(result?.doc_scope).toEqual(['x'])
  })

  // Migration — the pre-rename file is read when the new file is absent.
  describe('legacy doc-scope.json fallback', () => {
    it('falls back to a legacy doc-scope.json when delfini-config.json is absent', async () => {
      await writeRaw(repoRoot, LEGACY_DOC_SCOPE_RELATIVE_PATH, {
        version: 1,
        doc_scope: ['docs/'],
      })

      const result = await readConfig(repoRoot)
      expect(result).toEqual({ version: 1, doc_scope: ['docs/'], ignore_code_scope: [] })
    })

    it('prefers delfini-config.json over a legacy doc-scope.json when both exist', async () => {
      await writeRaw(repoRoot, LEGACY_DOC_SCOPE_RELATIVE_PATH, {
        version: 1,
        doc_scope: ['legacy/'],
      })
      await writeRaw(repoRoot, DELFINI_CONFIG_RELATIVE_PATH, {
        version: 1,
        doc_scope: ['current/'],
        ignore_code_scope: ['gen/**'],
      })

      const result = await readConfig(repoRoot)
      expect(result).toEqual({
        version: 1,
        doc_scope: ['current/'],
        ignore_code_scope: ['gen/**'],
      })
    })
  })
})

describe('writeConfig', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('writes both scopes when supplied', async () => {
    await writeConfig({ doc_scope: ['docs/'], ignore_code_scope: ['src/generated/**'] }, { repoRoot })
    const written = await fs.readFile(path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH), 'utf8')
    expect(JSON.parse(written)).toEqual({
      version: 1,
      doc_scope: ['docs'],
      ignore_code_scope: ['src/generated/**'],
    })
  })

  it('omits ignore_code_scope from the file when empty (reads back as [])', async () => {
    await writeConfig({ doc_scope: ['docs/'], ignore_code_scope: [] }, { repoRoot })
    const written = await fs.readFile(path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH), 'utf8')
    expect(JSON.parse(written)).toEqual({ version: 1, doc_scope: ['docs'] })
    expect((await readConfig(repoRoot))?.ignore_code_scope).toEqual([])
  })

  it('preserves an existing ignore_code_scope when only doc_scope is updated', async () => {
    await writeConfig({ doc_scope: ['docs/'], ignore_code_scope: ['gen/**'] }, { repoRoot })
    await writeDocScope(['specs/'], { repoRoot })

    const result = await readConfig(repoRoot)
    expect(result).toEqual({
      version: 1,
      doc_scope: ['specs'],
      ignore_code_scope: ['gen/**'],
    })
  })

  it('preserves an existing doc_scope when only ignore_code_scope is updated', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    await writeConfig({ ignore_code_scope: ['gen/**'] }, { repoRoot })

    const result = await readConfig(repoRoot)
    expect(result).toEqual({
      version: 1,
      doc_scope: ['docs'],
      ignore_code_scope: ['gen/**'],
    })
  })

  it('normalises ignore_code_scope entries with the shared engine algebra', async () => {
    await writeConfig(
      { doc_scope: ['docs/'], ignore_code_scope: ['src//generated/', './build', 'build'] },
      { repoRoot },
    )
    const result = await readConfig(repoRoot)
    expect(result?.ignore_code_scope).toEqual(['src/generated', 'build'])
  })

  it('rejects an ignore_code_scope entry that escapes the repo root', async () => {
    await expect(
      writeConfig({ doc_scope: ['docs/'], ignore_code_scope: ['../outside/**'] }, { repoRoot }),
    ).rejects.toThrow(/escapes repo root/)
  })

  it('throws when the final config would have no doc_scope', async () => {
    await expect(writeConfig({ ignore_code_scope: ['gen/**'] }, { repoRoot })).rejects.toBeInstanceOf(
      ConfigValidationError,
    )
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
    const written = await fs.readFile(path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH), 'utf8')
    expect(written.endsWith('\n')).toBe(true)
    // P3.6.1 normalize strengthening: trailing slashes are stripped at write
    // time (not a regression — the engine's normalizeDocScope makes the
    // persisted form canonical so picomatch can match it consistently).
    expect(JSON.parse(written)).toEqual({ version: 1, doc_scope: ['docs'] })
  })

  it('P3.6.1 normalize strengthening: collapses //, ./ and .. segments at write time (not a regression)', async () => {
    await writeDocScope(['docs//api', './docs', 'docs/sub/../api/*.md'], { repoRoot })
    const written = await fs.readFile(path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH), 'utf8')
    expect(JSON.parse(written)).toEqual({
      version: 1,
      doc_scope: ['docs/api', 'docs', 'docs/api/*.md'],
    })
  })

  it('overwrites an existing doc_scope', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    await writeDocScope(['specs/architecture.md'], { repoRoot })

    const result = await readConfig(repoRoot)
    expect(result).toEqual({
      version: 1,
      doc_scope: ['specs/architecture.md'],
      ignore_code_scope: [],
    })
  })

  it('rejects an empty paths array with ConfigValidationError', async () => {
    await expect(writeDocScope([], { repoRoot })).rejects.toBeInstanceOf(ConfigValidationError)
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
      expect(err).toBeInstanceOf(ConfigValidationError)
      const msg = (err as Error).message
      expect(msg).toMatch(/\.\.\/escape1/)
      expect(msg).toMatch(/\/abs\/escape2/)
      // The valid entry must NOT appear in the error message
      expect(msg.includes('docs/\n')).toBe(false)
    }
  })

  it('rejects empty-string entries', async () => {
    await expect(writeDocScope([''], { repoRoot })).rejects.toBeInstanceOf(ConfigValidationError)
  })

  it('rejects a glob whose normalised form escapes the repo root (P3.6.1 full-entry normalize)', async () => {
    await expect(
      writeDocScope(['**/../../escape/*.md'], { repoRoot }),
    ).rejects.toThrow(/escapes repo root/)
  })

  it('rejects entries containing ASCII control characters', async () => {
    await expect(writeDocScope(['docs/foo\nbar.md'], { repoRoot })).rejects.toThrow(/control characters/)
  })

  it('rejects when every entry collapses to an empty scope after normalisation', async () => {
    await expect(writeDocScope(['.'], { repoRoot })).rejects.toBeInstanceOf(ConfigValidationError)
    await expect(writeDocScope(['.'], { repoRoot })).rejects.toThrow(/empty scope/)
    await expect(writeDocScope(['./', 'docs/..'], { repoRoot })).rejects.toThrow(/empty scope/)
    // Confirm NOTHING was persisted (no silent empty config on disk).
    expect(await configExists(repoRoot)).toBe(false)
  })

  it('persists surviving entries when only SOME entries collapse (partial collapse is not an error)', async () => {
    await writeDocScope(['docs', '.'], { repoRoot })
    const result = await readConfig(repoRoot)
    expect(result).toEqual({ version: 1, doc_scope: ['docs'], ignore_code_scope: [] })
  })

  // Migration — writing emits the new file and removes the legacy one.
  it('migrates a legacy doc-scope.json: writes delfini-config.json and deletes the legacy file', async () => {
    await writeRaw(repoRoot, LEGACY_DOC_SCOPE_RELATIVE_PATH, { version: 1, doc_scope: ['old/'] })

    await writeDocScope(['docs/'], { repoRoot })

    const legacy = path.join(repoRoot, LEGACY_DOC_SCOPE_RELATIVE_PATH)
    await expect(fs.access(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await readConfig(repoRoot)
    expect(result?.doc_scope).toEqual(['docs'])
  })
})

describe('configExists', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('returns false for a fresh repo', async () => {
    expect(await configExists(repoRoot)).toBe(false)
  })

  it('returns true after writeDocScope', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    expect(await configExists(repoRoot)).toBe(true)
  })

  it('returns true when only a legacy doc-scope.json exists', async () => {
    await writeRaw(repoRoot, LEGACY_DOC_SCOPE_RELATIVE_PATH, { version: 1, doc_scope: ['docs/'] })
    expect(await configExists(repoRoot)).toBe(true)
  })

  it('returns true for a malformed file (presence-only check)', async () => {
    const target = path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'not json at all', 'utf8')
    expect(await configExists(repoRoot)).toBe(true)
  })

  it('returns false when a directory occupies the delfini-config.json path', async () => {
    const target = path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH)
    await fs.mkdir(target, { recursive: true })
    expect(await configExists(repoRoot)).toBe(false)
  })
})

describe('deleteConfig', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot()
  })

  afterEach(async () => {
    await cleanup(repoRoot)
  })

  it('removes the file when present', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    expect(await configExists(repoRoot)).toBe(true)
    await deleteConfig(repoRoot)
    expect(await configExists(repoRoot)).toBe(false)
  })

  it('removes a legacy doc-scope.json too', async () => {
    await writeRaw(repoRoot, LEGACY_DOC_SCOPE_RELATIVE_PATH, { version: 1, doc_scope: ['docs/'] })
    await deleteConfig(repoRoot)
    expect(await configExists(repoRoot)).toBe(false)
  })

  it('is idempotent — no error when file already absent', async () => {
    await expect(deleteConfig(repoRoot)).resolves.toBeUndefined()
  })

  it('does NOT delete the enclosing .claude/skills/delfini/ directory', async () => {
    await writeDocScope(['docs/'], { repoRoot })
    // Write a sibling file to simulate SKILL.md being present
    const siblingPath = path.join(repoRoot, '.claude', 'skills', 'delfini', 'SKILL.md')
    await fs.writeFile(siblingPath, '# SKILL.md placeholder\n', 'utf8')

    await deleteConfig(repoRoot)

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

  it('does NOT mutate delfini-config.json on disk when called with override paths', async () => {
    await writeDocScope(['original/path'], { repoRoot })
    const before = await fs.readFile(path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH), 'utf8')

    await expandDocScope(['some/other/override.md'], repoRoot)

    const after = await fs.readFile(path.join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH), 'utf8')
    expect(after).toBe(before)
  })

  it('handles Windows-style backslash separators in input entries (normalises before resolve)', async () => {
    await fs.mkdir(path.join(repoRoot, 'docs', 'nested'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'docs', 'nested', 'win.md'), '# w', 'utf8')

    const result = await expandDocScope(['docs\\nested\\win.md'], repoRoot)
    expect(result.files.map(toRepoRel.bind(null, repoRoot))).toEqual(['docs/nested/win.md'])
  })

  it('treats `../` escape entries as missing (does not walk outside repo root)', async () => {
    const parent = path.dirname(repoRoot)
    const sibling = path.join(parent, `delfini-cli-escape-${crypto.randomUUID()}`)
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
