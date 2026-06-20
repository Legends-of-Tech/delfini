// Story P3.6.2 / AC4 — dialect-parity test.
//
// Loads the SAME 23-row fixture committed by Story P3.6.1 at
// packages/drift-engine/__tests__/fixtures/doc-scope-dialect.json and
// asserts that the CLI's effective doc-scope matching agrees with the
// drift-engine's `isFileInDocScope` predicate on every row. This is the
// single-dialect invariant the consolidation exists to establish:
// tinyglobby ↔ picomatch@4 ↔ isFileInDocScope are one cohesive dialect.
//
// Two parity dimensions are checked per row:
//
//   1. PREDICATE parity (always runs, no fs needed): the row's
//      isFileInDocScope(filePath, scope) result must equal row.expected.
//      This guards the fixture itself against drift between consumers.
//
//   2. EXPANDER parity (runs when structurally possible): materialise the
//      row's filePath under a temp repo root, call expandDocScope(scope),
//      and assert the row's filePath membership equals row.expected.
//
// Predicate-vs-expander semantic split (documented per AC4):
//   - The predicate is PATH-SHAPE-ONLY (P3.6.1 AC5). It does not filter by
//     `.md` extension.
//   - The CLI expander's DIRECTORY branch filters to `.md` files (an
//     intentional per-surface user-facing contract: "doc scope means
//     markdown docs"). So a row like {scope: ["docs"], filePath:
//     "docs/diagram.png", expected: true} matches by the dialect but the
//     expander would not return it. For these rows we assert PREDICATE
//     parity only and log the skip reason.
//   - The case-insensitive row (`Docs/architecture.md` matched by `docs`)
//     requires a case-insensitive filesystem on the expander side
//     (case-sensitive Linux cannot resolve `docs/` against a real `Docs/`
//     directory). We detect FS case-sensitivity at runtime and skip the
//     expander branch only — predicate parity still asserts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { isFileInDocScope } from '@delfini/drift-engine'

import { expandDocScope } from '../src/config.js'

interface DialectFixtureRow {
  name: string
  scope: string[]
  filePath: string
  expected: boolean
}

interface DialectFixture {
  cases: DialectFixtureRow[]
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../drift-engine/__tests__/fixtures/doc-scope-dialect.json',
)

async function loadFixture(): Promise<DialectFixture> {
  const raw = await fs.readFile(FIXTURE_PATH, 'utf8')
  return JSON.parse(raw) as DialectFixture
}

async function makeTempRepoRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `delfini-cli-dialect-parity-${crypto.randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  return root
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
}

async function materialiseFile(root: string, relPath: string): Promise<void> {
  // Normalise leading `./` and convert separators for fs ops.
  const cleaned = relPath.replace(/^\.\//, '').split('/').join(path.sep)
  const absolute = path.join(root, cleaned)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, '', 'utf8')
}

async function detectCaseSensitiveFs(root: string): Promise<boolean> {
  const lower = path.join(root, '.delfini-case-probe')
  await fs.writeFile(lower, '', 'utf8')
  try {
    await fs.access(path.join(root, '.DELFINI-CASE-PROBE'))
    return false
  } catch {
    return true
  } finally {
    await fs.unlink(lower).catch(() => {})
  }
}

function endsWithMd(p: string): boolean {
  return /\.md$/i.test(p)
}

/**
 * Decide whether the row can be tested through the expander, or whether the
 * predicate-vs-expander semantic split forces a predicate-only assertion.
 * Returns a `skipReason` string for the expander branch, or null when the
 * expander can answer the row faithfully.
 */
function expanderSkipReason(
  row: DialectFixtureRow,
  caseSensitiveFs: boolean,
): string | null {
  // The CLI expander's dir branch filters to `.md` files. If filePath isn't
  // `.md` AND the row expects a positive match (which would have to come
  // through a dir-classified entry), the expander cannot return it.
  if (!endsWithMd(row.filePath) && row.expected === true) {
    return 'expander dir branch filters to .md; predicate is path-shape-only'
  }

  // Case-folding row (`docs` ↔ `Docs/architecture.md`): on a case-sensitive
  // FS the expander cannot resolve `docs/` against a real `Docs/` directory.
  // Predicate parity still asserts.
  if (caseSensitiveFs) {
    const filePathLower = row.filePath.toLowerCase()
    const filePathOriginal = row.filePath
    if (filePathLower !== filePathOriginal) {
      return 'case-folding row on case-sensitive fs'
    }
    for (const entry of row.scope) {
      // If the file's directory casing differs from the entry's casing,
      // the FS stat in expander dir branch would not resolve.
      const segments = filePathOriginal.replace(/^\.\//, '').split('/')
      if (
        segments.length > 1 &&
        entry.toLowerCase() === segments[0]!.toLowerCase() &&
        entry !== segments[0]
      ) {
        return 'case-folding row on case-sensitive fs'
      }
    }
  }

  return null
}

describe('doc-scope dialect parity — CLI expander ↔ drift-engine predicate (AC4)', () => {
  let fixture: DialectFixture
  let caseSensitiveFs: boolean
  let probeRoot: string

  beforeEach(async () => {
    fixture = await loadFixture()
    probeRoot = await makeTempRepoRoot()
    caseSensitiveFs = await detectCaseSensitiveFs(probeRoot)
  })

  afterEach(async () => {
    await cleanup(probeRoot)
  })

  it('fixture is the committed 23-row dialect table', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(23)
    for (const row of fixture.cases) {
      expect(typeof row.name).toBe('string')
      expect(Array.isArray(row.scope)).toBe(true)
      expect(typeof row.filePath).toBe('string')
      expect(typeof row.expected).toBe('boolean')
    }
  })

  it('predicate parity holds on every row', () => {
    for (const row of fixture.cases) {
      const actual = isFileInDocScope(row.filePath, row.scope)
      expect(actual, `predicate row "${row.name}"`).toBe(row.expected)
    }
  })

  it('expander parity holds on every structurally testable row', async () => {
    const skipped: string[] = []
    for (const row of fixture.cases) {
      const reason = expanderSkipReason(row, caseSensitiveFs)
      if (reason !== null) {
        skipped.push(`  - "${row.name}": ${reason}`)
        continue
      }

      const root = await makeTempRepoRoot()
      try {
        // Materialise the row's filePath. For empty-scope and "lib/x.ts
        // not in scope" cases (membership=false), we still create the file
        // so the expander has a chance to mis-match it.
        await materialiseFile(root, row.filePath)

        const result = await expandDocScope(row.scope, root)

        // Membership: compare via repo-relative POSIX paths to avoid Windows
        // vs. POSIX absolute-path separator mismatches (tinyglobby emits
        // POSIX-style absolute paths even on Windows; path.resolve emits
        // platform-native ones). On a case-insensitive FS, the FS itself
        // conflates `Docs/` and `docs/`, so the membership check is also
        // case-insensitive (e.g. tinyglobby may echo the user-supplied
        // `cwd` casing rather than the on-disk casing).
        const expectedRel = row.filePath.replace(/^\.\//, '')
        const memberRels = result.files.map((f) =>
          path.relative(root, f).split(path.sep).join('/'),
        )
        const matched = caseSensitiveFs
          ? memberRels.includes(expectedRel)
          : memberRels.some((r) => r.toLowerCase() === expectedRel.toLowerCase())

        expect(matched, `expander row "${row.name}"`).toBe(row.expected)
      } finally {
        await cleanup(root)
      }
    }

    // Surface the skip list so a future maintainer can audit it. No silent
    // caps — every skip carries a documented reason.
    if (skipped.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[dialect-parity] expander branch skipped ${skipped.length} row(s):\n${skipped.join('\n')}`,
      )
    }
  })
})
