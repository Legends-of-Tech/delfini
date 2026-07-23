// Diff-gate savings measurement (docs/ideas/token-diet-symmetric-retrieval.md
// §5) — the deterministic go/no-go number for the design's Key Assumption 2
// ("big-branch hunks are mostly unlinked"). No LLM anywhere: it runs the real
// `gateDiffByRelevance` + `buildPrompt` over analysis-input.json files and
// prints kept/trimmed/dropped hunk counts and prompt-token estimates
// before/after gating (both sides rendered with retrieval ON, so the number
// isolates what the GATE adds on top of the already-default NFR49 retrieval).
//
// Invocation:
//   node --import tsx packages/drift-engine/scripts/measure-diff-gate.ts
//   node --import tsx packages/drift-engine/scripts/measure-diff-gate.ts \
//        path/to/analysis-input.json [more.json ...] [--keep-threshold 5] \
//        [--section-threshold 5]
//
// With no file arguments it sweeps the committed fixture corpus
// (token-efficiency + cross-file + lexically-invisible cases). To measure a
// REAL repo: run `delfini local-prepare --diff-keep-threshold 0` there and
// point this script at the resulting `.delfini-trace/analysis-input.json` —
// the trace artefact is exactly this input shape.
//
// Not wired into CI; not exposed as an npm script; excluded from the published
// tarball (package.json `"files"` omits scripts/) — same charter as
// measure-tokens.ts.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, basename } from 'node:path'
import {
  buildPrompt,
  estimatePromptTokens,
  gateDiffByRelevance,
} from '../src/index.js'
import type { AnalysisInput } from '../src/types.js'
import { parseDiffHunks } from '../src/diff-hunks.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TEMPLATE = readFileSync(resolve(__dirname, '../src/prompt.md'), 'utf8')

interface Cli {
  files: string[]
  keepThreshold: number
  sectionThreshold: number
}

function parseCli(argv: string[]): Cli {
  const files: string[] = []
  let keepThreshold = 5
  let sectionThreshold = 5
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--keep-threshold') keepThreshold = Number(argv[++i])
    else if (arg === '--section-threshold') sectionThreshold = Number(argv[++i])
    else files.push(arg)
  }
  return { files, keepThreshold, sectionThreshold }
}

// Default sweep: every committed fixture corpus that carries an
// analysis-input.json.
function defaultCorpus(): string[] {
  const roots = [
    resolve(__dirname, '../__tests__/fixtures/token-efficiency'),
    resolve(__dirname, '../__tests__/fixtures/cross-file'),
    resolve(__dirname, '../__tests__/fixtures/lexically-invisible'),
  ]
  const out: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      const candidate = resolve(root, entry, 'analysis-input.json')
      if (statSync(resolve(root, entry)).isDirectory() && existsSync(candidate)) {
        out.push(candidate)
      }
    }
  }
  return out
}

function k(n: number): string {
  return `${(n / 1000).toFixed(1)}k`
}

function pct(before: number, after: number): string {
  if (before === 0) return '0.0%'
  return `${(((before - after) / before) * 100).toFixed(1)}%`
}

function measure(file: string, cli: Cli): void {
  const input = JSON.parse(readFileSync(file, 'utf8')) as AnalysisInput
  const slug = basename(dirname(file))

  const gate = gateDiffByRelevance(input.diff, input.docs, {
    sectionThreshold: cli.sectionThreshold,
    keepThreshold: cli.keepThreshold,
  })

  const totalHunks = parseDiffHunks(input.diff).length
  const keptTotal = Object.values(gate.keptByReason).reduce((a, b) => a + b, 0)

  // Both renders retrieval-ON so the delta isolates the gate's contribution.
  const before = estimatePromptTokens(
    buildPrompt(input, TEMPLATE, { relevanceThreshold: cli.sectionThreshold }),
  )
  const after = estimatePromptTokens(
    buildPrompt({ ...input, diff: gate.keptDiff }, TEMPLATE, {
      relevanceThreshold: cli.sectionThreshold,
    }),
  )
  const diffBefore = estimatePromptTokens(input.diff)
  const diffAfter = estimatePromptTokens(gate.keptDiff)

  if (!gate.active) {
    console.log(
      `${slug.padEnd(28)} hunks ${totalHunks}: gate inactive (${gate.inactiveReason}) | ` +
        `prompt ${k(before)} (unchanged)`,
    )
    return
  }

  const reasons = gate.keptByReason
  console.log(
    `${slug.padEnd(28)} hunks ${totalHunks}: kept ${keptTotal} ` +
      `(strong ${reasons['linked-strong']}, weak ${reasons['linked-weak']}, ` +
      `doc ${reasons['doc-in-scope']}, new ${reasons['new-file']}, ` +
      `manifest ${reasons['dependency-manifest']}) ` +
      `trimmed ${gate.trimmedHunkCount} (-${gate.contextLinesRemoved} ctx) ` +
      `dropped ${gate.droppedHunks.length} | ` +
      `diff ${k(diffBefore)} -> ${k(diffAfter)} | ` +
      `prompt ${k(before)} -> ${k(after)} (-${pct(before, after)})`,
  )
}

const cli = parseCli(process.argv.slice(2))
const files = cli.files.length > 0 ? cli.files : defaultCorpus()
if (files.length === 0) {
  console.error('No analysis-input.json files found or supplied.')
  process.exitCode = 1
} else {
  console.log(
    `diff-gate measurement — sectionThreshold ${cli.sectionThreshold}, ` +
      `keepThreshold ${cli.keepThreshold}\n`,
  )
  for (const file of files) measure(file, cli)
}
