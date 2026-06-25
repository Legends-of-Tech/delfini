// `delfini local-finalize <findings.json>` — the result-handling half of the
// skill protocol.
//
// Deterministic, never calls an LLM. Steps:
//   1. Read findings.json (resolved against repoRoot if relative)
//   2. JSON.parse — exit 3 on malformed JSON (NFR47 mode 1)
//   3. Read .delfini-trace/analysis-input.json to recover the docs array
//   4. Extract optional `clarifyingQuestions` from raw JSON (Zod strips them
//      inside validateAndReconcile because analysisSchema does not include
//      them in V1; the orchestrator-side clarification synthesis is future
//      work — see packages/drift-engine/src/reconcile.ts:1–13).
//   5. validateAndReconcile(rawJson, docs) — exit 3 on Zod failure
//   6. Render report.md (drift + additive in apply-eligible section;
//      clarifications in "Manual review required") with deterministic
//      ordering and NO timestamps (NFR46)
//   7. Write to .delfini-trace/report.md AND print same content to stdout
//   8. Exit 1 if any drift or additive finding exists; exit 0 otherwise
//
// Consumer: SKILL.md protocol step 6 (Story P3.3.1). The host coding agent
// reads stdout / .delfini-trace/report.md to render the result to the user
// and branches on the exit code for the apply UX (FR146).
//
// ESLint already blocks @anthropic-ai/sdk / openai / @langchain/* imports in
// this file via the packages/cli/src/**/*.ts rule. The command is pure
// filesystem + drift-engine; no LLM client.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { z, ZodError } from 'zod'

import { mergeAnalysisResults, validateAndReconcile } from '@delfini/drift-engine'
import type {
  Addition,
  AnalysisResult,
  ClarifyingQuestion,
  Contradiction,
  DocFile,
  Severity,
} from '@delfini/drift-engine'

import { getRepoRoot } from '../git.js'
import { writeTraceFile } from '../trace.js'
import { CHUNKS_MANIFEST_FILENAME } from './local-prepare.js'

// ---------------------------------------------------------------------------
// Constants — match the AC4 / AC5 / AC6 / AC7 contract exactly.
// ---------------------------------------------------------------------------

const TRACE_DIR_RELATIVE = '.delfini-trace'
const ANALYSIS_INPUT_FILENAME = 'analysis-input.json'
const REPORT_FILENAME = 'report.md'

const SEVERITY_ICON: Record<Severity, string> = {
  High: '[H]',
  Medium: '[M]',
  Low: '[L]',
}

// ---------------------------------------------------------------------------
// Clarification schema — local-only.
//
// `analysisSchema` (drift-engine) does NOT currently include
// clarifyingQuestions; the orchestrator-side synthesis is future work. We
// validate clarifications independently so a malformed `clarifyingQuestions`
// entry still surfaces the AC2 exit-3 payload.
// ---------------------------------------------------------------------------

const ClarifyingQuestionSchema: z.ZodType<ClarifyingQuestion> = z.object({
  whatChanged: z.string().min(1),
  naturalHomeDoc: z.string().min(1),
  naturalHomeSection: z.string().min(1),
  question: z.string().min(1),
  proposedReplacement: z.string().nullable(),
})

const ClarifyingQuestionsArraySchema = z.array(ClarifyingQuestionSchema)

// ---------------------------------------------------------------------------
// Public options shape
// ---------------------------------------------------------------------------

export interface RunLocalFinalizeOptions {
  /** Positional argument — path to findings.json. Relative paths resolve against repoRoot. */
  findingsPath: string
  /** Override the repo root. Test seam — production callers omit and let `getRepoRoot()` resolve via `git rev-parse --show-toplevel`. */
  repoRoot?: string
  /** Stream sink for the rendered report. Test seam — production uses process.stdout. */
  stdout?: NodeJS.WritableStream
  /** Stream sink for the schema_validation JSON payload. Test seam — production uses process.stderr. */
  stderr?: NodeJS.WritableStream
}

// ---------------------------------------------------------------------------
// Error payload shape (AC2)
// ---------------------------------------------------------------------------

interface SchemaValidationIssue {
  path: string
  message: string
}

interface SchemaValidationPayload {
  error: 'schema_validation'
  issues: SchemaValidationIssue[]
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Returns an exit code (0 / 1 / 3 per AC3). Does NOT call `process.exit` —
 * the cli.ts router is the single owner of `process.exit` (matches the
 * pattern from `runLocalPrepare`).
 */
export async function runLocalFinalize(
  options: RunLocalFinalizeOptions,
): Promise<number> {
  const stderr = options.stderr ?? process.stderr
  const stdout = options.stdout ?? process.stdout
  const repoRoot = options.repoRoot ?? (await getRepoRoot())

  // -- Step 1: Resolve findings path --------------------------------------
  const findingsPath = path.isAbsolute(options.findingsPath)
    ? options.findingsPath
    : path.join(repoRoot, options.findingsPath)

  // -- Multi-prompt mode: a DIRECTORY argument means "the trace dir of a split
  //    run" (over-budget diff → `local-prepare` wrote `chunks.json` + N
  //    findings files). Loop the chunks, reconcile each against the full docs,
  //    and merge. A plain findings.json FILE keeps the single-prompt path below.
  let findingsIsDir = false
  try {
    findingsIsDir = (await fs.stat(findingsPath)).isDirectory()
  } catch {
    findingsIsDir = false
  }
  if (findingsIsDir) {
    return runMultiFinalize(findingsPath, repoRoot, stdout, stderr)
  }

  // -- Step 2: Read + parse findings.json ----------------------------------
  let findingsContent: string
  try {
    findingsContent = await fs.readFile(findingsPath, 'utf8')
  } catch (err) {
    return emitSchemaValidationError(stderr, [
      {
        path: 'findings.json',
        message: `Failed to read findings file at "${findingsPath}": ${formatErrorMessage(err)}`,
      },
    ])
  }

  let rawJson: unknown
  try {
    rawJson = JSON.parse(findingsContent)
  } catch (err) {
    return emitSchemaValidationError(stderr, [
      {
        path: 'findings.json',
        message: `Failed to parse findings.json as JSON: ${formatErrorMessage(err)}`,
      },
    ])
  }

  // -- Step 3: Read .delfini-trace/analysis-input.json --------------------
  const analysisInputPath = path.join(repoRoot, TRACE_DIR_RELATIVE, ANALYSIS_INPUT_FILENAME)
  let docs: DocFile[]
  try {
    const raw = await fs.readFile(analysisInputPath, 'utf8')
    const parsed = JSON.parse(raw) as { docs?: unknown }
    if (!Array.isArray(parsed.docs)) {
      return emitSchemaValidationError(stderr, [
        {
          path: 'analysis-input.json',
          message: `analysis-input.json is missing the "docs" array. Re-run \`delfini local-prepare\`.`,
        },
      ])
    }
    docs = parsed.docs as DocFile[]
  } catch (err) {
    return emitSchemaValidationError(stderr, [
      {
        path: 'analysis-input.json',
        message: `Failed to read analysis-input.json at "${analysisInputPath}": ${formatErrorMessage(err)}. Run \`delfini local-prepare\` first.`,
      },
    ])
  }

  // -- Step 4: Extract clarifications from raw JSON BEFORE Zod strips them.
  let clarifications: ClarifyingQuestion[]
  try {
    const clarifyingQuestionsRaw = extractClarifyingQuestionsField(rawJson)
    clarifications = ClarifyingQuestionsArraySchema.parse(clarifyingQuestionsRaw)
  } catch (err) {
    if (err instanceof ZodError) {
      return emitSchemaValidationError(stderr, formatZodIssues(err, 'clarifyingQuestions'))
    }
    throw err
  }

  // -- Step 5: validateAndReconcile (Zod parse + reconciliation chain) ----
  //
  // Surface drift-engine reconciliation warnings to stderr — these flag
  // silently dropped findings (ungrounded quotes, no-op replacements,
  // overlap losers, missing additive anchors). Without this wiring the
  // user has no signal when an LLM-emitted finding silently vanishes from
  // the report (code-review B5 / E14). Each warning is prefixed so it
  // can't be mistaken for the schema_validation JSON payload (which is the
  // only thing the skill protocol parses from stderr).
  let result: AnalysisResult
  try {
    result = validateAndReconcile(rawJson, docs, (message) => {
      stderr.write(`⚠️  ${message}\n`)
    })
  } catch (err) {
    if (err instanceof ZodError) {
      return emitSchemaValidationError(stderr, formatZodIssues(err))
    }
    throw err
  }

  // -- Step 6: Render report.md -------------------------------------------
  const report = renderReport(result, clarifications)

  // -- Step 7: Write trace file + mirror to stdout ------------------------
  writeTraceFile(repoRoot, REPORT_FILENAME, report)
  // Single trailing newline if report doesn't end in one — keeps shell
  // prompts clean. Determinism (NFR46) is preserved because the same input
  // produces the same `report` (which ends in `\n` per our renderer).
  stdout.write(report.endsWith('\n') ? report : `${report}\n`)

  // -- Step 8: Decide exit code -------------------------------------------
  //
  // Exit 1 fires whenever the user has something to act on — apply-eligible
  // drift/additive findings OR narrative-only drifts (which require manual
  // doc/code triage). Clarifications alone stay at exit 0 (existing contract
  // — they are informational and the host agent's Step-6 "No drift detected"
  // message is acceptable when only clarifications surface, since the
  // clarification path requires a human-only resolution and the trace
  // artefacts remain on disk for the user to inspect).
  return decideExitCode(result)
}

// Exit 1 fires whenever the user has something to act on — apply-eligible
// drift/additive findings OR narrative-only drifts (manual triage). Shared by
// the single-prompt and multi-prompt paths.
function decideExitCode(result: AnalysisResult): number {
  const hasApplyEligible = result.contradictions.length > 0 || result.additions.length > 0
  const hasNarrativeOnly = (result.narrativeOnlyContradictions ?? []).length > 0
  return hasApplyEligible || hasNarrativeOnly ? 1 : 0
}

// ---------------------------------------------------------------------------
// Multi-prompt finalize — fold N per-chunk findings into one merged report.
//
// Triggered when `local-finalize` is given the trace DIRECTORY (a split run
// wrote `chunks.json`). Each `findings-<k>.json` is reconciled against the full
// doc set (line numbers are absolute, so grounding is chunk-independent) and the
// per-chunk results are merged via `mergeAnalysisResults`. Chunks that fail
// schema validation are collected and reported together as `failedChunks` so
// the SKILL can re-dispatch only the broken ones (per-chunk retry).
// ---------------------------------------------------------------------------

async function runMultiFinalize(
  traceDir: string,
  repoRoot: string,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  // -- Read the manifest (chunk count) written by `local-prepare`.
  let chunkCount: number
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(traceDir, CHUNKS_MANIFEST_FILENAME), 'utf8'),
    ) as { chunkCount?: unknown }
    if (
      typeof parsed.chunkCount !== 'number' ||
      !Number.isInteger(parsed.chunkCount) ||
      parsed.chunkCount < 1
    ) {
      return emitSchemaValidationError(stderr, [
        {
          path: CHUNKS_MANIFEST_FILENAME,
          message: 'chunks.json is missing a valid "chunkCount". Re-run `delfini local-prepare`.',
        },
      ])
    }
    chunkCount = parsed.chunkCount
  } catch (err) {
    return emitSchemaValidationError(stderr, [
      {
        path: CHUNKS_MANIFEST_FILENAME,
        message: `Failed to read chunks.json in "${traceDir}": ${formatErrorMessage(err)}. Run \`delfini local-prepare\` first.`,
      },
    ])
  }

  // -- Recover the full doc set for grounding.
  let docs: DocFile[]
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(traceDir, ANALYSIS_INPUT_FILENAME), 'utf8'),
    ) as { docs?: unknown }
    if (!Array.isArray(parsed.docs)) {
      return emitSchemaValidationError(stderr, [
        {
          path: ANALYSIS_INPUT_FILENAME,
          message: 'analysis-input.json is missing the "docs" array. Re-run `delfini local-prepare`.',
        },
      ])
    }
    docs = parsed.docs as DocFile[]
  } catch (err) {
    return emitSchemaValidationError(stderr, [
      {
        path: ANALYSIS_INPUT_FILENAME,
        message: `Failed to read analysis-input.json in "${traceDir}": ${formatErrorMessage(err)}.`,
      },
    ])
  }

  // -- Reconcile each chunk; collect schema failures for per-chunk retry.
  const results: AnalysisResult[] = []
  const clarifications: ClarifyingQuestion[] = []
  const failedChunks: { chunk: number; issues: SchemaValidationIssue[] }[] = []

  for (let k = 0; k < chunkCount; k++) {
    const file = path.join(traceDir, `findings-${k}.json`)
    let rawJson: unknown
    try {
      rawJson = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (err) {
      failedChunks.push({
        chunk: k,
        issues: [{ path: `findings-${k}.json`, message: `Failed to read/parse: ${formatErrorMessage(err)}` }],
      })
      continue
    }
    try {
      clarifications.push(
        ...ClarifyingQuestionsArraySchema.parse(extractClarifyingQuestionsField(rawJson)),
      )
    } catch (err) {
      if (err instanceof ZodError) {
        failedChunks.push({ chunk: k, issues: formatZodIssues(err, 'clarifyingQuestions') })
        continue
      }
      throw err
    }
    try {
      results.push(
        validateAndReconcile(rawJson, docs, (message) => {
          stderr.write(`⚠️  [chunk ${k}] ${message}\n`)
        }),
      )
    } catch (err) {
      if (err instanceof ZodError) {
        failedChunks.push({ chunk: k, issues: formatZodIssues(err) })
        continue
      }
      throw err
    }
  }

  if (failedChunks.length > 0) {
    // Distinct payload shape from the single-mode `{ error, issues }` — the
    // SKILL keys off `failedChunks[].chunk` to re-dispatch only the broken
    // prompts (analysis-prompt-<chunk>.md) rather than the whole batch.
    stderr.write(`${JSON.stringify({ error: 'schema_validation', failedChunks }, null, 2)}\n`)
    return 3
  }

  const merged = mergeAnalysisResults(results, (message) => stderr.write(`⚠️  ${message}\n`))
  const report = renderReport(merged, clarifications)
  writeTraceFile(repoRoot, REPORT_FILENAME, report)
  stdout.write(report.endsWith('\n') ? report : `${report}\n`)
  return decideExitCode(merged)
}

// ---------------------------------------------------------------------------
// Helpers — error path
// ---------------------------------------------------------------------------

function emitSchemaValidationError(
  stderr: NodeJS.WritableStream,
  issues: SchemaValidationIssue[],
): number {
  const payload: SchemaValidationPayload = { error: 'schema_validation', issues }
  stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
  return 3
}

function formatZodIssues(err: ZodError, prefix?: string): SchemaValidationIssue[] {
  return err.issues.map((issue) => ({
    path: [prefix, ...issue.path].filter((p) => p !== undefined && p !== '').map(String).join('.'),
    message: issue.message,
  }))
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function extractClarifyingQuestionsField(rawJson: unknown): unknown {
  if (typeof rawJson !== 'object' || rawJson === null) {
    return []
  }
  if (!('clarifyingQuestions' in rawJson)) {
    return []
  }
  const value = (rawJson as { clarifyingQuestions: unknown }).clarifyingQuestions
  return value ?? []
}

// ---------------------------------------------------------------------------
// Renderer — pure, deterministic, no timestamps
// ---------------------------------------------------------------------------

function renderReport(
  result: AnalysisResult,
  clarifications: ClarifyingQuestion[],
): string {
  const narrativeOnly = result.narrativeOnlyContradictions ?? []
  // The summary "drift" count is the TOTAL drift count — apply-eligible
  // contradictions PLUS narrative-only contradictions. Both kinds are
  // "drift" conceptually; they differ only in whether the LLM had a concrete
  // doc patch to suggest. Splitting them in the count line would mislead the
  // user about how much drift was detected.
  const applyEligibleDriftCount = result.contradictions.length
  const narrativeOnlyCount = narrativeOnly.length
  const driftCount = applyEligibleDriftCount + narrativeOnlyCount
  const additiveCount = result.additions.length
  const clarificationCount = clarifications.length

  const parts: string[] = []
  parts.push('# Delfini drift analysis')
  parts.push('')
  parts.push(
    `${driftCount} drift, ${additiveCount} additive, ${clarificationCount} clarification finding(s).`,
  )
  parts.push('')

  // Apply-eligible section. AC4 — omit the heading entirely when empty;
  // surface a single "No apply-eligible findings." line instead.
  if (applyEligibleDriftCount === 0 && additiveCount === 0) {
    parts.push('No apply-eligible findings.')
    parts.push('')
  } else {
    parts.push('## Apply-eligible findings')
    parts.push('')
    let index = 1
    for (const drift of result.contradictions) {
      parts.push(renderDriftFinding(drift, index))
      parts.push('')
      index += 1
    }
    for (const additive of result.additions) {
      parts.push(renderAdditiveFinding(additive, index))
      parts.push('')
      index += 1
    }
  }

  // Manual review required (narrative-only drifts AND clarifications).
  // Omit the heading entirely when both are empty (mirrors apply-eligible).
  // Narrative-only drifts render FIRST (more concrete: an evidenced
  // contradiction the user needs to triage), clarifications second
  // (open-ended questions). Neither carries a numeric prefix — that
  // signals to the apply UX (FR146 / FR147) that these are not selectable.
  if (narrativeOnlyCount > 0 || clarificationCount > 0) {
    parts.push('## Manual review required')
    parts.push('')
    for (const drift of narrativeOnly) {
      parts.push(renderNarrativeOnlyDrift(drift))
      parts.push('')
    }
    for (const clarification of clarifications) {
      parts.push(renderClarification(clarification))
      parts.push('')
    }
  }

  // Single trailing newline — `parts.push('')` followed by `.join('\n')`
  // produces a trailing `\n` naturally because the last `''` joins with the
  // preceding non-empty entry via the separator.
  return parts.join('\n')
}

function renderDriftFinding(c: Contradiction, index: number): string {
  const lines: string[] = []
  const icon = SEVERITY_ICON[c.severity]
  lines.push(
    `### [${index}] ${icon} drift: ${c.targetDocPath}:${c.targetLineStart}-${c.targetLineEnd}`,
  )
  lines.push('')
  lines.push(`**Section:** ${c.targetSection}`)
  lines.push(`**Severity:** ${c.severity}  **Confidence:** ${c.confidence}/5`)
  lines.push('')
  lines.push(`**What changed:** ${c.whatChanged}`)
  lines.push(`**What contradicts:** ${c.whatContradicts}`)
  lines.push('')
  lines.push('**Proposed change:**')
  lines.push('```diff')
  for (const line of c.quotedDocText.replace(/\r\n/g, '\n').split('\n')) {
    lines.push(`- ${line}`)
  }
  // filterActionableContradictions drops null/empty replacements; defence-
  // in-depth in case a future change relaxes that.
  const replacement = c.proposedReplacement ?? '<empty>'
  for (const line of replacement.replace(/\r\n/g, '\n').split('\n')) {
    lines.push(`+ ${line}`)
  }
  lines.push('```')
  return lines.join('\n')
}

function renderAdditiveFinding(a: Addition, index: number): string {
  const lines: string[] = []
  const icon = SEVERITY_ICON[a.severity]
  lines.push(
    `### [${index}] ${icon} additive: ${a.targetDocPath} — insert ${a.insertionMode} line ${a.anchorLine}`,
  )
  lines.push('')
  lines.push(`**Anchor section:** ${a.anchorSection}`)
  lines.push(`**Severity:** ${a.severity}  **Confidence:** ${a.confidence}/5`)
  lines.push('')
  lines.push(`**What changed:** ${a.whatChanged}`)
  lines.push(`**Rationale:** ${a.rationaleForAddition}`)
  lines.push('')
  lines.push(`**Proposed addition (insert ${a.insertionMode} line ${a.anchorLine}):**`)
  lines.push('```diff')
  for (const line of a.proposedContent.replace(/\r\n/g, '\n').split('\n')) {
    lines.push(`+ ${line}`)
  }
  lines.push('```')
  return lines.join('\n')
}

function renderNarrativeOnlyDrift(c: Contradiction): string {
  const lines: string[] = []
  const icon = SEVERITY_ICON[c.severity]
  // No numeric prefix — mirrors the clarification heading pattern (L367-369)
  // so the apply UX visually distinguishes "Apply-eligible" entries
  // (numbered) from "Manual review required" entries (un-numbered).
  // The "narrative-only drift" label disambiguates from apply-eligible
  // drift findings rendered above with the same `[index] [icon] drift:`
  // prefix.
  lines.push(
    `### ${icon} narrative-only drift: ${c.targetDocPath}:${c.targetLineStart}-${c.targetLineEnd}`,
  )
  lines.push('')
  lines.push(`**Section:** ${c.targetSection}`)
  lines.push(`**Severity:** ${c.severity}  **Confidence:** ${c.confidence}/5`)
  lines.push('')
  lines.push(`**What changed:** ${c.whatChanged}`)
  lines.push(`**What contradicts:** ${c.whatContradicts}`)
  lines.push('')
  lines.push('**Quoted doc text:**')
  lines.push('```')
  lines.push(c.quotedDocText)
  lines.push('```')
  lines.push('')
  // No "Proposed replacement" block: the LLM emitted null because the doc
  // rule is correct and the code is the violation. Resolution is to fix
  // code (not docs) — there is nothing to splice. The user reads the
  // evidence above and acts manually.
  lines.push(
    '**Resolution:** The doc rule above is correct; the PR code violates it. Fix the code (or hand-edit the doc if the rule itself needs to change) — no auto-apply available.',
  )
  return lines.join('\n')
}

function renderClarification(q: ClarifyingQuestion): string {
  const lines: string[] = []
  // AC7 — no numeric prefix; the index-free heading is the visual signal
  // that the apply UX (P3.3.3) will refuse to auto-apply this entry.
  lines.push(`### Clarification: ${q.naturalHomeDoc} — ${q.naturalHomeSection}`)
  lines.push('')
  lines.push(`**What changed:** ${q.whatChanged}`)
  lines.push(`**Question:** ${q.question}`)
  if (q.proposedReplacement !== null) {
    lines.push('')
    lines.push('**Suggested replacement (optional):**')
    lines.push('```')
    lines.push(q.proposedReplacement)
    lines.push('```')
  }
  return lines.join('\n')
}
