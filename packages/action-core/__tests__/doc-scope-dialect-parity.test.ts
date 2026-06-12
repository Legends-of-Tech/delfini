import { describe, expect, it, vi } from 'vitest'

// Story P2.6 / ADR-2026-06-01 — dialect-parity assertion.
//
// Single-dialect invariant: smart-skip's predicate and the Lite reader's
// matcher both route through `isFileInDocScope` from `@delfini/drift-engine`
// (picomatch@4) against the SAME 23-row fixture. If they ever disagree, this
// test fails — and the entire ADR's "what smart-skip skips" vs "what the
// reader ingests" bug class survives in production.
//
// The fixture file is committed in `packages/drift-engine/__tests__/fixtures/
// doc-scope-dialect.json` as self-contained JSON precisely so consumers (this
// test + the CLI's parity test from P3.6.2) can import it without dragging in
// the engine's test code. Loaded via a relative path that mirrors the CLI's
// approach.
//
// Predicate vs. reader semantic split (documented in P3.6.1 AC5):
//   - The predicate (`isFileInDocScope`) is path-shape-only.
//   - The reader applies an additional `.md` / `.markdown` extension filter
//     AFTER the predicate. So non-`.md` rows are skipped on the reader side;
//     their predicate-side parity is still asserted via the smart-skip leg.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readDocsViaGitTrees } from '../src/doc-reader.js'
import { classifyPr } from '../src/smart-skip.js'

interface DialectFixtureRow {
  name: string
  scope: string[]
  filePath: string
  expected: boolean
}

interface DialectFixture {
  _comment?: string
  cases: DialectFixtureRow[]
}

const FIXTURE_PATH = resolve(
  __dirname,
  '../../drift-engine/__tests__/fixtures/doc-scope-dialect.json',
)

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as DialectFixture

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

// Minimal Octokit stub for `readDocsViaGitTrees`. The tree contains exactly
// one blob — the row's filePath. The blob fetch returns trivial content
// (front-matter parsing accepts any non-front-matter body unchanged).
function makeOctokitForRow(filePath: string): unknown {
  return {
    rest: {
      git: {
        getTree: vi.fn().mockResolvedValue({
          data: {
            tree: [{ path: filePath, type: 'blob', sha: 'fake-sha' }],
            truncated: false,
          },
        }),
      },
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            type: 'file',
            name: filePath.split('/').pop(),
            path: filePath,
            content: Buffer.from('# Doc body', 'utf-8').toString('base64'),
          },
        }),
      },
    },
  }
}

describe('doc-scope dialect parity (Story P2.6 / ADR-2026-06-01)', () => {
  describe('smart-skip side — `classifyPr` agrees with `isFileInDocScope` on every row', () => {
    for (const row of fixture.cases) {
      it(row.name, () => {
        // Skip empty-scope rows: smart-skip's `classifyPr` short-circuits on
        // empty docScope by treating no file as in-scope (the predicate
        // returns false), which IS the expected behaviour. Still asserted on
        // the predicate via the reader side below where applicable.
        if (row.scope.length === 0) {
          // With an empty scope, no file is in scope — smart-skip routes a
          // non-doc, non-structural change to "Business-logic changes
          // detected" (shouldSkip: false) and a single-file PR to the same.
          const result = classifyPr([row.filePath], { docScope: row.scope })
          expect(result.shouldSkip).toBe(false)
          return
        }

        const result = classifyPr([row.filePath], { docScope: row.scope })
        // The predicate's TRUTHY answer manifests as either (a) FR57(b) all-
        // files-in-doc-scope fires → `shouldSkip: true, reason: "1 doc-only
        // change in doc scope"`, OR (b) the file is structurally
        // uninteresting AND in scope (rare for our fixture rows). The
        // predicate's FALSY answer manifests as either (a) shouldSkip:false
        // (business-logic detected) OR (b) shouldSkip:true with a non-doc-
        // scope reason (structurally uninteresting). For the dialect-parity
        // fixture we crisply distinguish via the reason text.
        if (row.expected) {
          // In-scope → smart-skip's FR57(b) fires (single file, no
          // structurally-uninteresting siblings).
          expect(result.shouldSkip).toBe(true)
          expect(result.reason).toContain('doc-only')
        } else {
          // Out-of-scope → smart-skip treats the file as a business-logic
          // change (no doc-in-scope count) and analysis runs. The fixture
          // doesn't include structurally-uninteresting paths so this is the
          // only valid "predicate said false" shape.
          expect(result.shouldSkip).toBe(false)
        }
      })
    }
  })

  describe('reader side — `readDocsViaGitTrees` matches the predicate for .md rows', () => {
    for (const row of fixture.cases) {
      // The reader's `.md` filter is an expander concern (P3.6.1 AC5);
      // non-`.md` rows are predicate-only by design. Document and skip.
      if (!isMarkdownPath(row.filePath)) continue
      if (row.scope.length === 0) continue

      it(row.name, async () => {
        const octokit = makeOctokitForRow(row.filePath)
        const { included } = await readDocsViaGitTrees(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          octokit as any,
          'acme',
          'widgets',
          row.scope,
          'head-sha',
        )
        const wasIngested = included.some((doc) => doc.path === row.filePath)
        expect(wasIngested).toBe(row.expected)
      })
    }
  })
})
