import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { filterDiff } from '../src/diff-filter'

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'diff-filter',
)

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
}

describe('filterDiff', () => {
  describe('path-level drops', () => {
    it('drops pnpm-lock.yaml as a lockfile', () => {
      const diff = loadFixture('lockfile-pnpm.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([{ path: 'pnpm-lock.yaml', reason: 'lockfile' }])
      // src/foo.ts survives.
      expect(result.keptDiff).toContain('diff --git a/src/foo.ts b/src/foo.ts')
      expect(result.keptDiff).not.toContain('pnpm-lock.yaml')
    })

    it('drops package-lock.json / yarn.lock / cargo.lock / go.sum (basename)', () => {
      const diff = [
        'diff --git a/package-lock.json b/package-lock.json',
        '--- a/package-lock.json',
        '+++ b/package-lock.json',
        '@@ -1 +1 @@',
        '-{"v":1}',
        '+{"v":2}',
        'diff --git a/yarn.lock b/yarn.lock',
        '--- a/yarn.lock',
        '+++ b/yarn.lock',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/Cargo.lock b/Cargo.lock',
        '--- a/Cargo.lock',
        '+++ b/Cargo.lock',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        'diff --git a/go.sum b/go.sum',
        '--- a/go.sum',
        '+++ b/go.sum',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n')
      const result = filterDiff(diff)
      expect(result.droppedPaths.map((d) => d.reason)).toEqual([
        'lockfile',
        'lockfile',
        'lockfile',
        'lockfile',
      ])
      expect(result.keptDiff).toBe('')
    })

    it('drops generated files: routeTree.gen.ts and dist/ paths', () => {
      const diff = loadFixture('generated-route-tree.diff')
      const result = filterDiff(diff)
      const droppedReasons = result.droppedPaths.map((d) => `${d.path}|${d.reason}`)
      expect(droppedReasons).toContain('apps/web/src/routeTree.gen.ts|generated')
      expect(droppedReasons).toContain('apps/web/dist/index.js|generated')
      // src/keep.ts survives.
      expect(result.keptDiff).toContain('diff --git a/src/keep.ts b/src/keep.ts')
    })

    it('drops vendored paths: third_party/ and vendor/', () => {
      const diff = loadFixture('vendored-thirdparty.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([
        { path: 'third_party/lib/a.go', reason: 'vendored' },
        { path: 'vendor/x/y.rs', reason: 'vendored' },
      ])
      expect(result.keptDiff).toBe('')
    })

    it('drops fixture paths: __snapshots__/*.snap and __fixtures__/', () => {
      const diff = loadFixture('fixture-snap.diff')
      const result = filterDiff(diff)
      const dropped = result.droppedPaths.map((d) => `${d.path}|${d.reason}`).sort()
      expect(dropped).toEqual([
        'src/__fixtures__/data.json|fixture',
        'src/__tests__/__snapshots__/foo.test.ts.snap|fixture',
      ])
    })
  })

  describe('hunk-level drops', () => {
    it('drops a whitespace-only re-indentation hunk and promotes the file to droppedPaths', () => {
      // Single-hunk file where every hunk is whitespace-only — promoted to droppedPaths.
      const diff = loadFixture('whitespace-only-reindent.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([
        { path: 'src/format.ts', reason: 'whitespace-only' },
      ])
      // No orphan preamble in keptDiff.
      expect(result.keptDiff).toBe('')
    })

    it('drops an import-only reorder (TypeScript) and promotes the file', () => {
      const diff = loadFixture('import-only-reorder-ts.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([
        { path: 'src/imports.ts', reason: 'import-only' },
      ])
      expect(result.keptDiff).toBe('')
    })

    it('drops an import-only reorder (Python) and promotes the file', () => {
      const diff = loadFixture('import-only-reorder-py.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([
        { path: 'src/x.py', reason: 'import-only' },
      ])
    })

    it('does NOT drop a hunk that genuinely adds a new import', () => {
      const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,2 @@',
        " import { a } from './a'",
        "+import { c } from './c'",
        '',
      ].join('\n')
      const result = filterDiff(diff)
      expect(result.droppedHunks).toEqual([])
      expect(result.droppedPaths).toEqual([])
      expect(result.keptDiff).toBe(diff)
    })
  })

  describe('hunk-level preservation (AC4)', () => {
    it('keeps code-bearing hunks adjacent to a whitespace-only hunk in the same file', () => {
      const diff = loadFixture('mixed-hunks-kept-dropped.diff')
      const result = filterDiff(diff)
      // The middle hunk (whitespace re-indentation of `return 1`) is dropped.
      // Outer two hunks survive.
      expect(result.droppedPaths).toEqual([])
      expect(result.droppedHunks).toHaveLength(1)
      expect(result.droppedHunks[0]).toMatchObject({
        path: 'src/mixed.ts',
        reason: 'whitespace-only',
      })
      // The kept diff preserves the file's preamble + the two code-bearing hunks.
      expect(result.keptDiff).toContain('diff --git a/src/mixed.ts b/src/mixed.ts')
      expect(result.keptDiff).toContain("-  return 'a'")
      expect(result.keptDiff).toContain("+  return 'b'")
      expect(result.keptDiff).toContain('-  return true')
      expect(result.keptDiff).toContain('+  return false')
      // The whitespace-only hunk's body is gone.
      expect(result.keptDiff).not.toContain('+    return 1')
    })
  })

  describe('no-noise byte-equality (AC1 reconstruction invariant)', () => {
    it('returns the input verbatim when nothing is filterable', () => {
      const diff = loadFixture('no-noise.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([])
      expect(result.droppedHunks).toEqual([])
      expect(result.keptDiff).toBe(diff)
    })

    it('handles an empty diff', () => {
      const result = filterDiff('')
      expect(result.keptDiff).toBe('')
      expect(result.droppedPaths).toEqual([])
      expect(result.droppedHunks).toEqual([])
    })
  })

  describe('determinism', () => {
    it('produces identical output for identical input across many invocations', () => {
      const diff = loadFixture('mixed-hunks-kept-dropped.diff')
      const first = filterDiff(diff)
      for (let i = 0; i < 5; i++) {
        const next = filterDiff(diff)
        expect(next.keptDiff).toBe(first.keptDiff)
        expect(next.droppedPaths).toEqual(first.droppedPaths)
        expect(next.droppedHunks).toEqual(first.droppedHunks)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Code-review regression guards (P3.7.2 /bmad-code-review, 2026-06-05)
  // -------------------------------------------------------------------------

  describe('review P1 — import-only never drops a binding change', () => {
    it('keeps a same-source binding addition (import { foo } → import { foo, bar })', () => {
      const diff = loadFixture('import-binding-change.diff')
      const result = filterDiff(diff)
      // Same source `./a` on both sides, but the LINES differ → real new
      // dependency on `bar`; must NOT be classified import-only.
      expect(result.droppedPaths).toEqual([])
      expect(result.droppedHunks).toEqual([])
      expect(result.keptDiff).toBe(diff)
    })

    it('still drops a genuine pure re-order of identical import lines', () => {
      const diff = loadFixture('import-only-reorder-ts.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([{ path: 'src/imports.ts', reason: 'import-only' }])
    })
  })

  describe('review P2 — whitespace-only is language-aware', () => {
    it('does NOT drop an indentation change in a Python file (dedent changes control flow)', () => {
      const diff = loadFixture('python-dedent.diff')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([])
      expect(result.droppedHunks).toEqual([])
      expect(result.keptDiff).toBe(diff)
    })

    it('still drops the same kind of re-indentation in a brace-language (.ts) file', () => {
      // Identical dedent shape, but .ts → indentation is cosmetic → dropped.
      const diff = [
        'diff --git a/src/flow.ts b/src/flow.ts',
        '--- a/src/flow.ts',
        '+++ b/src/flow.ts',
        '@@ -1,3 +1,3 @@',
        ' function f() {',
        '-        return compute()',
        '+    return compute()',
        ' }',
        '',
      ].join('\n')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([{ path: 'src/flow.ts', reason: 'whitespace-only' }])
    })

    it('does NOT drop a whitespace-looking change in a YAML file', () => {
      const diff = [
        'diff --git a/config.yaml b/config.yaml',
        '--- a/config.yaml',
        '+++ b/config.yaml',
        '@@ -1,2 +1,2 @@',
        ' parent:',
        '-  child: 1',
        '+    child: 1',
        '',
      ].join('\n')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([])
      expect(result.keptDiff).toBe(diff)
    })
  })

  describe('review P3 — quoted/spaced-path headers are recognised (no silent data loss)', () => {
    it('keeps a real code change in a space-containing path that follows a dropped lockfile', () => {
      const diff = [
        'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
        '--- a/pnpm-lock.yaml',
        '+++ b/pnpm-lock.yaml',
        '@@ -1 +1 @@',
        "-lockfileVersion: '9.0'",
        "+lockfileVersion: '9.1'",
        'diff --git "a/my file.ts" "b/my file.ts"',
        '--- "a/my file.ts"',
        '+++ "b/my file.ts"',
        '@@ -1 +1 @@',
        '-export const real = 1',
        '+export const real = 2',
        '',
      ].join('\n')
      const result = filterDiff(diff)
      // Only the lockfile is dropped; the spaced-path file is NOT absorbed.
      expect(result.droppedPaths).toEqual([{ path: 'pnpm-lock.yaml', reason: 'lockfile' }])
      expect(result.keptDiff).toContain('export const real = 2')
      expect(result.keptDiff).toContain('my file.ts')
    })

    it('classifies a quoted lockfile path correctly (drops it)', () => {
      const diff = [
        'diff --git "a/pnpm-lock.yaml" "b/pnpm-lock.yaml"',
        '--- "a/pnpm-lock.yaml"',
        '+++ "b/pnpm-lock.yaml"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([{ path: 'pnpm-lock.yaml', reason: 'lockfile' }])
      expect(result.keptDiff).toBe('')
    })
  })

  describe('review P7 — __snapshots__ directory is a fixture path', () => {
    it('drops a non-.snap file under a __snapshots__/ directory', () => {
      const diff = [
        'diff --git a/src/__snapshots__/data.json b/src/__snapshots__/data.json',
        '--- a/src/__snapshots__/data.json',
        '+++ b/src/__snapshots__/data.json',
        '@@ -1 +1 @@',
        '-{"v":1}',
        '+{"v":2}',
        '',
      ].join('\n')
      const result = filterDiff(diff)
      expect(result.droppedPaths).toEqual([
        { path: 'src/__snapshots__/data.json', reason: 'fixture' },
      ])
      expect(result.keptDiff).toBe('')
    })
  })

  // ignore_code_scope — user-configurable path dropping via the shared
  // picomatch@4 predicate. New `filterDiff(diff, options)` arg.
  describe('ignore_code_scope (options.ignorePaths)', () => {
    const multiFileDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-const a = 1',
      '+const a = 2',
      'diff --git a/src/generated/client.ts b/src/generated/client.ts',
      '--- a/src/generated/client.ts',
      '+++ b/src/generated/client.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/db/migrations/0001.sql b/db/migrations/0001.sql',
      '--- a/db/migrations/0001.sql',
      '+++ b/db/migrations/0001.sql',
      '@@ -1 +1 @@',
      '-create',
      '+create2',
      '',
    ].join('\n')

    it('default options are byte-identical to the legacy single-arg call', () => {
      const diff = loadFixture('lockfile-pnpm.diff')
      const legacy = filterDiff(diff)
      expect(filterDiff(diff, {})).toEqual(legacy)
      expect(filterDiff(diff, { builtins: true })).toEqual(legacy)
      expect(filterDiff(diff, { builtins: true, ignorePaths: [] })).toEqual(legacy)
    })

    it('drops a file matched by a directory ignore entry (subtree semantics)', () => {
      // `builtins: false` so only the ignore pass runs — proves the drop is
      // the ignore predicate, not a built-in classifier.
      const result = filterDiff(multiFileDiff, {
        builtins: false,
        ignorePaths: ['src/generated'],
      })
      expect(result.droppedPaths).toEqual([
        { path: 'src/generated/client.ts', reason: 'ignored' },
      ])
      expect(result.keptDiff).toContain('diff --git a/src/app.ts b/src/app.ts')
      expect(result.keptDiff).toContain('diff --git a/db/migrations/0001.sql b/db/migrations/0001.sql')
      expect(result.keptDiff).not.toContain('src/generated/client.ts')
    })

    it('drops a file matched by a glob ignore entry', () => {
      const result = filterDiff(multiFileDiff, {
        builtins: false,
        ignorePaths: ['**/migrations/**'],
      })
      expect(result.droppedPaths).toEqual([{ path: 'db/migrations/0001.sql', reason: 'ignored' }])
      expect(result.keptDiff).not.toContain('db/migrations/0001.sql')
    })

    it('drops a file matched by an exact-file ignore entry', () => {
      const result = filterDiff(multiFileDiff, {
        builtins: false,
        ignorePaths: ['src/app.ts'],
      })
      expect(result.droppedPaths).toEqual([{ path: 'src/app.ts', reason: 'ignored' }])
      expect(result.keptDiff).not.toContain('diff --git a/src/app.ts')
    })

    it('with builtins:false and empty ignorePaths is an observable no-op (all verbatim)', () => {
      const result = filterDiff(multiFileDiff, { builtins: false, ignorePaths: [] })
      expect(result.droppedPaths).toEqual([])
      expect(result.droppedHunks).toEqual([])
      expect(result.keptDiff).toBe(multiFileDiff)
    })

    it('ignore is classified BEFORE the built-ins — an ignored vendored path reports "ignored"', () => {
      const diff = [
        'diff --git a/vendor/x.ts b/vendor/x.ts',
        '--- a/vendor/x.ts',
        '+++ b/vendor/x.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n')
      // Built-ins alone would call this 'vendored'; with an ignore match the
      // user's intent wins and the reason is 'ignored'.
      expect(filterDiff(diff).droppedPaths).toEqual([{ path: 'vendor/x.ts', reason: 'vendored' }])
      const result = filterDiff(diff, { builtins: true, ignorePaths: ['vendor/'] })
      expect(result.droppedPaths).toEqual([{ path: 'vendor/x.ts', reason: 'ignored' }])
    })

    it('composes with the built-ins — both reasons appear in one pass', () => {
      const diff = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-const a = 1',
        '+const a = 2',
        'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
        '--- a/pnpm-lock.yaml',
        '+++ b/pnpm-lock.yaml',
        '@@ -1 +1 @@',
        '-v1',
        '+v2',
        'diff --git a/db/migrations/0001.sql b/db/migrations/0001.sql',
        '--- a/db/migrations/0001.sql',
        '+++ b/db/migrations/0001.sql',
        '@@ -1 +1 @@',
        '-create',
        '+create2',
        '',
      ].join('\n')
      const result = filterDiff(diff, { builtins: true, ignorePaths: ['db/migrations'] })
      const dropped = result.droppedPaths.map((d) => `${d.path}|${d.reason}`).sort()
      expect(dropped).toEqual(['db/migrations/0001.sql|ignored', 'pnpm-lock.yaml|lockfile'])
      expect(result.keptDiff).toContain('diff --git a/src/app.ts b/src/app.ts')
    })
  })
})
