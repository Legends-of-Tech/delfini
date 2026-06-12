// Story P3.7.5 / NFR49(a) — local-iteration token-efficiency measurement.
//
// Runs `estimatePromptTokens(buildPrompt(fixture, opts))` retrieval-off vs
// retrieval-on across the committed `__tests__/fixtures/token-efficiency/`
// corpus and prints a single line per case to stdout. It performs the same
// math as the `token-efficiency.test.ts` vitest, so for the committed corpus
// the live numbers match the CI gate's. The per-fixture "filter the diff
// first?" decision is encoded in `FILTER_FIRST_SLUGS` below, which MUST stay
// in sync with the test's `cases` table (`filterFirst` flags) — adding a
// fixture that needs `filterDiff` means adding its slug there too.
//
// Invocation:
//   node --import tsx packages/drift-engine/scripts/measure-tokens.ts
//   node --import tsx packages/drift-engine/scripts/measure-tokens.ts \
//        packages/drift-engine/__tests__/fixtures/token-efficiency/case-01-doc-heavy/analysis-input.json
//
// Not wired into CI; not exposed as a npm script. The script ships in the
// git tree only — `packages/drift-engine/package.json` `"files"` lists
// `["dist", "src/prompt.md", "README.md"]`, so `scripts/` is excluded
// from the published tarball (and never reaches the bundled CLI).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, basename } from 'node:path'
import { buildPrompt, estimatePromptTokens, filterDiff } from '../src/index.js'
import type { AnalysisInput } from '../src/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const RELEVANCE_THRESHOLD = 5
const PROMPT_TOKEN_BUDGET = 150_000

// Slugs whose diff is pre-filtered via `filterDiff` before measurement —
// mirrors the `filterFirst: true` rows in `token-efficiency.test.ts`'s `cases`
// table. Keep the two in sync: an inferred substring heuristic (e.g.
// `slug.includes('noisy')`) would silently mis-measure a future filtered
// fixture whose slug doesn't happen to contain that token.
const FILTER_FIRST_SLUGS = new Set<string>(['case-02-noisy-diff'])

function loadPromptTemplate(): string {
  return readFileSync(resolve(__dirname, '../src/prompt.md'), 'utf8')
}

function loadInput(path: string): AnalysisInput {
  return JSON.parse(readFileSync(path, 'utf8')) as AnalysisInput
}

function measureCase(inputPath: string, template: string): void {
  const input = loadInput(inputPath)
  const slug = basename(dirname(inputPath))
  const filterFirst = FILTER_FIRST_SLUGS.has(slug)

  const tokensOff = estimatePromptTokens(buildPrompt(input, template))
  const filtered = filterFirst ? filterDiff(input.diff) : null
  const onInput = filtered ? { ...input, diff: filtered.keptDiff } : input
  const tokensOn = estimatePromptTokens(
    buildPrompt(onInput, template, {
      relevanceThreshold: RELEVANCE_THRESHOLD,
      promptTokenBudget: PROMPT_TOKEN_BUDGET,
    }),
  )
  const ratio = tokensOn / tokensOff
  const deltaPct = ((1 - ratio) * 100).toFixed(1)
  process.stdout.write(
    `${slug}: tokens off=${tokensOff} on=${tokensOn} ratio=${ratio.toFixed(4)} Δ=${deltaPct}%\n`,
  )
}

function listCorpusFixtures(): string[] {
  const corpusRoot = resolve(__dirname, '../__tests__/fixtures/token-efficiency')
  const dirs = readdirSync(corpusRoot)
  return dirs
    .filter((d) => statSync(resolve(corpusRoot, d)).isDirectory())
    .sort()
    .map((d) => resolve(corpusRoot, d, 'analysis-input.json'))
}

function main(): void {
  const template = loadPromptTemplate()
  const argPath = process.argv[2]
  const paths = argPath ? [resolve(argPath)] : listCorpusFixtures()
  for (const p of paths) {
    try {
      measureCase(p, template)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${p}: ${message}\n`)
      process.exitCode = 1
    }
  }
}

main()
