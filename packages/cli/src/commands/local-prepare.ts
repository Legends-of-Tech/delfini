// `delfini local-prepare` — the input-assembly half of the skill protocol.
//
// Deterministic, never calls an LLM. Steps:
//   1. Resolve effective doc-scope + ignore_code_scope (--scope /
//      --ignore-code-scope overrides vs persisted delfini-config.json)
//   2. Expand each scope entry via expandDocScope() (P3.2.5 primitive)
//   3. Compute diff via simple-git against --base (default merge-base HEAD origin/main)
//   4. Read each in-scope doc from disk
//   5. Call buildPrompt() from @delfini/drift-engine (pure-logic)
//   6. estimatePromptTokens() — exit 4 with prompt_too_large JSON only when the
//      non-doc payload alone exceeds budget; otherwise ranked-fill (P3.7.3) trims
//      lowest-scoring retained sections and the run continues with a stderr header
//   7. Write three artefacts to .delfini-trace/ via writeTraceFile() (P3.2.6 primitive)
//   8. Return 0
//
// Consumer: SKILL.md protocol step 3 (Story P3.3.1). The host coding agent
// reads the three artefacts and dispatches a Claude subagent (FR145).
//
// ESLint already blocks @anthropic-ai/sdk / openai / @langchain/* imports in
// this file via the packages/cli/src/**/*.ts rule. The command is pure
// git + filesystem + drift-engine; no LLM client.

import { existsSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import simpleGit, { type SimpleGit } from 'simple-git'
import { z, type ZodTypeAny } from 'zod'

import {
  analysisSchema,
  buildPromptWithDrops,
  estimatePromptTokens,
  filterDiff,
} from '@delfini/drift-engine'
import type {
  AnalysisInput,
  DocFile,
  FilterDiffResult,
  PRMetadata,
} from '@delfini/drift-engine'

import { expandDocScope, readConfig } from '../config.js'
import type { DelfiniConfig } from '../config.js'
import { getRepoRoot, listUntrackedFiles, resolveBaseRef } from '../git.js'
import { ensureTraceDir, writeTraceFile } from '../trace.js'

const execFileAsync = promisify(execFile)

// `git diff --no-index` for a single untracked file is read into one string.
// `execFile`'s 1 MiB default truncates a large new file's diff (then rejects
// with ERR_CHILD_PROCESS_STDIO_MAXBUFFER); a generous cap lets the downstream
// prompt-budget gate (exit 4) be the authority on "too large" instead.
const UNTRACKED_DIFF_MAX_BUFFER = 64 * 1024 * 1024

/** The diff sources selectable via `--diff-source` (FR141a). */
export type DiffSource = 'local' | 'committed' | 'both'

// -- Constants ---------------------------------------------------------------

// Anthropic Sonnet ships a 1M-context model, but we stay well below the hard
// cap to leave room for the schema, the system prompt the host agent adds at
// dispatch time, and any retry-time corrective-feedback appendix. 150k tokens
// is roughly 600KB of prompt — well past any realistic local PR.
export const PROMPT_TOKEN_BUDGET = 150_000

// Default doc-relevance threshold for the `delfini local-prepare` CLI entry
// point (PRD v6.7 / NFR49 — token-efficient retrieval turned ON by default at
// the CLI call-site). The cli.ts `--relevance-threshold` flag uses this as its
// default value, so a real `delfini local-prepare` run renders only the doc
// SECTIONS a change could plausibly contradict (section retrieval + ranked-fill
// at PROMPT_TOKEN_BUDGET) instead of embedding every in-scope doc whole — a
// measured ~40%+ prompt-token reduction on doc-heavy runs. `--relevance-threshold 0`
// opts back out (embed all in-scope docs whole).
//
// IMPORTANT (Option A / NFR49(b) parity discipline): this default lives at the
// CLI layer only. `runLocalPrepare` itself stays a pure pass-through — an
// undefined `relevanceThreshold` means "retrieval off" — and the shared
// drift-engine `buildPrompt` default is UNCHANGED. That keeps all three NFR44
// parity gates byte-identical with no re-snapshot: only the CLI's user-facing
// default flips, not the shared canonical prompt the Action also renders.
//
// Value 5 is the canonical threshold documented across P3.7.1 / P3.7.3: it
// retains a section on a single Tier-2 file-path overlap (+10), two Tier-3
// identifier overlaps (+3 each), one Tier-4 heading overlap (+5), or any doc
// the diff touches directly (Tier-1 +20) — wide enough to never drop a
// plausibly-relevant section (the NFR49(a) retention gate guards recall).
export const DEFAULT_RELEVANCE_THRESHOLD = 5

// Exact stderr format for missing scope paths. NFR47 mode 6 — warn-and-
// continue; never fail the run on a missing path. Variant strings must NOT
// be introduced — the skill protocol test suite (when it lands in P3.3.x)
// pattern-matches this format.
function formatMissingPathWarning(path: string): string {
  return `⚠️ Skipped: \`${path}\` (no longer exists)\n`
}

// Resolve the canonical prompt template from drift-engine. drift-engine is
// pure-logic (no I/O); the CLI loads the template here and passes it into
// `buildPrompt(input, template)` — mirrors the Action's pattern in
// apps/action/src/adapters/single-call/orchestrator.ts L13-L30.
//
// Two runtime layouts must both resolve, and they put this module at DIFFERENT
// depths — so a single fixed relative path cannot serve both (the original
// `../../../drift-engine/src/prompt.md` was calibrated for the source layout
// and resolved one dir too high — outside `packages/` — from the bundle):
//
//   1. BUNDLED (`dist/cli.js`, monorepo OR published @delfini/cli tarball) —
//      `@delfini/drift-engine` is `private:true` and never on npm, so its
//      source tree is ABSENT from a published install. tsup copies the
//      template to `dist/prompt.md` at build (see tsup.config.ts onSuccess),
//      so the bundle's only — and authoritative — copy sits next to cli.js.
//   2. SOURCE (`src/commands/local-prepare.ts` via tsx / vitest) — no
//      `dist/prompt.md` exists; fall back to the monorepo drift-engine source
//      three dirs up.
//
// Exported for the layout-resolution regression test
// (__tests__/prompt-template-resolution.test.ts) — the bundled-adjacent path
// is otherwise unreachable from a source-run unit test (gate-C blind spot
// that let the original bug ship).
const PROMPT_TEMPLATE_CANDIDATES = [
  './prompt.md',
  '../../../drift-engine/src/prompt.md',
] as const

export function resolvePromptTemplatePath(baseUrl: string | URL): string {
  const tried: string[] = []
  for (const rel of PROMPT_TEMPLATE_CANDIDATES) {
    const candidate = fileURLToPath(new URL(rel, baseUrl))
    if (existsSync(candidate)) return candidate
    tried.push(candidate)
  }
  throw new Error(
    'Could not locate the drift-engine prompt template. Tried:\n' +
      tried.map((p) => `  - ${p}`).join('\n') +
      '\nIf running the bundled CLI, ensure `dist/prompt.md` was produced by the build ' +
      '(tsup onSuccess copies drift-engine/src/prompt.md). Re-run `pnpm --filter @delfini/cli build`.',
  )
}

let cachedTemplate: string | undefined
function loadTemplate(): string {
  if (cachedTemplate === undefined) {
    cachedTemplate = readFileSync(resolvePromptTemplatePath(import.meta.url), 'utf8')
  }
  return cachedTemplate
}

// -- Public options shape ----------------------------------------------------

export interface RunLocalPrepareOptions {
  /**
   * The `--scope <paths>` value. Accepts a comma-separated string OR a string[].
   * When provided, overrides the persisted `delfini-config.json` doc_scope
   * WITHOUT modifying that file (FR144 per-run override invariant).
   */
  scope?: string | string[]
  /**
   * The `--ignore-code-scope <paths>` value. Accepts a comma-separated string
   * OR a string[]. When provided, overrides the persisted `delfini-config.json`
   * `ignore_code_scope` WITHOUT modifying that file (per-run override). Changed
   * files matching any entry are dropped from the analysed diff. Empty/omitted
   * → use the persisted `ignore_code_scope` (or none).
   */
  ignoreCodeScope?: string | string[]
  /**
   * The `--base <ref>` value. When provided, used as the diff base directly.
   * When omitted, defaults to `git merge-base HEAD origin/main`.
   */
  base?: string
  /**
   * Override the repo root used for all operations. Test seam — production
   * callers omit this and let `getRepoRoot()` resolve via
   * `git rev-parse --show-toplevel`.
   */
  repoRoot?: string
  /**
   * Override the prompt-token budget. Test seam — production callers omit
   * this and the module-level `PROMPT_TOKEN_BUDGET` constant applies.
   */
  promptTokenBudget?: number
  /**
   * Stream sink for the warning + guidance output. Test seam — production
   * callers omit this and `process.stderr` is used.
   */
  stderr?: NodeJS.WritableStream
  /**
   * Stream sink for the `prompt_too_large` JSON payload. Test seam.
   */
  stdout?: NodeJS.WritableStream
  /**
   * Opt-in doc-relevance gate. When set to a positive integer, docs whose
   * relevance score (file-path overlap + identifier overlap + heading
   * overlap + doc-path-in-diff) is below this threshold are dropped from
   * the prompt before rendering. Default behaviour (undefined or 0) is
   * observably no-op.
   *
   * Exposed via the `--relevance-threshold <N>` flag on `local-prepare`.
   * Recommended starting value: 5 — covers Tier 1 (doc itself in diff) and
   * single Tier 2 (one file path overlap).
   */
  relevanceThreshold?: number
  /**
   * Opt-in deterministic diff pre-filter (Story P3.7.2 / FR151). When `true`,
   * drops lockfile / generated / vendored / fixture paths plus pure
   * whitespace-only and import-only hunks BEFORE prompt assembly. Default
   * (`false` / undefined) is observably no-op — `analysis-input.json` is
   * byte-identical and `buildPrompt` output is unchanged (NFR49(b) parity).
   *
   * When the gate runs the assembled `analysis-input.json` gains an additive
   * `_filterResult: { droppedPaths, droppedHunks }` top-level sibling so the
   * host agent and the maintainer can see what was dropped. Subagent
   * consumers read only `diff`/`docs`/`prMetadata` and ignore `_filterResult`.
   *
   * Exposed via the `--enable-diff-prefilter` boolean flag on `local-prepare`.
   */
  enableDiffPreFilter?: boolean
  /**
   * Which diff to analyse (FR141a). Default `local`:
   *   - `local`     — working tree vs `HEAD` (`git diff HEAD`) + untracked files
   *   - `committed` — `HEAD` vs `--base` (the feature branch's committed delta)
   *   - `both`      — working tree vs `--base` (what an opened PR contains) + untracked
   *
   * On the default branch `both`/`committed` collapse to `local` by
   * construction (base ≈ HEAD → empty committed range) — no special-casing.
   * Exposed via the `--diff-source <local|committed|both>` flag.
   */
  diffSource?: DiffSource
}

// -- Entry point -------------------------------------------------------------

/**
 * Returns an exit code (0 = success, 2 = no doc-scope, 4 = prompt-too-large).
 * Does NOT call `process.exit` — the cli.ts router (Story P3.2.4) is the
 * single owner of `process.exit`.
 */
export async function runLocalPrepare(options: RunLocalPrepareOptions = {}): Promise<number> {
  const stderr = options.stderr ?? process.stderr
  const stdout = options.stdout ?? process.stdout
  const budget = options.promptTokenBudget ?? PROMPT_TOKEN_BUDGET
  const diffSource = options.diffSource ?? 'local'
  if (diffSource !== 'local' && diffSource !== 'committed' && diffSource !== 'both') {
    throw new Error(
      `Invalid --diff-source "${String(diffSource)}". Valid values: local, committed, both.`,
    )
  }
  const repoRoot = options.repoRoot ?? (await getRepoRoot())

  // Read the persisted config once (delfini-config.json, or legacy
  // doc-scope.json fallback). Both doc_scope and ignore_code_scope come from
  // here unless the per-run override flags are supplied.
  const config = await readConfig(repoRoot)

  // 1. Resolve effective doc scope: --scope override OR persisted doc_scope.
  const scopePaths = resolveScopePaths(options.scope, config)
  if (scopePaths === null) {
    stderr.write(
      'No doc-scope configured. Pass `--scope <paths>` or run the skill\n' +
        'first-run setup to create `.claude/skills/delfini/delfini-config.json`.\n',
    )
    return 2
  }

  // 1a. Resolve effective ignore_code_scope: --ignore-code-scope override OR
  //     persisted ignore_code_scope (empty when neither is set).
  const ignoreCodeScope = resolveIgnoreCodeScope(options.ignoreCodeScope, config)

  // 2. Expand scope entries (directories → recursive .md, files → file,
  //    globs → tinyglobby). Warn-and-continue on missing paths (NFR47 mode 6).
  const expansion = await expandDocScope(scopePaths, repoRoot)
  for (const missing of expansion.missingPaths) {
    stderr.write(formatMissingPathWarning(missing))
  }

  // 3. Compute the diff against the resolved base ref, per --diff-source.
  const git = simpleGit({ baseDir: repoRoot })
  const baseRef = await resolveBaseRef(git, options.base, stderr)
  const rawDiff = await computeDiff(git, repoRoot, baseRef, diffSource)

  // 3a. Story P3.7.2 / FR151 — deterministic diff pre-filter + user
  //     ignore_code_scope. Gated so the default path (no prefilter, no ignore)
  //     keeps the assembled `analysis-input.json` / `analysis-prompt.md` bytes
  //     identical (NFR49(b) parity). The filter runs when EITHER the built-in
  //     prefilter is on OR an ignore_code_scope is configured; the
  //     dropped-paths / dropped-hunks record (including any `ignored` drops) is
  //     stashed for the trace write.
  let diff = rawDiff
  let filterResult: FilterDiffResult | null = null
  const enableBuiltins = options.enableDiffPreFilter === true
  if (enableBuiltins || ignoreCodeScope.length > 0) {
    filterResult = filterDiff(rawDiff, {
      builtins: enableBuiltins,
      ignorePaths: ignoreCodeScope,
    })
    diff = filterResult.keptDiff
  }

  // 4. Read each in-scope doc from disk. frontMatterLineCount: 0 is the V1
  //    decision — the YAML-front-matter parser is action-only; the local
  //    Skill path does not need `.delfini`-style ignore semantics.
  const docs = await readDocs(expansion.files, repoRoot, stderr)

  // 5. Synthesise prMetadata (no real PR exists for a local /delfini run)
  //    and assemble the AnalysisInput.
  const prMetadata = await buildPRMetadata(git, repoRoot, baseRef)
  const input: AnalysisInput = { diff, docs, prMetadata }

  // 6. Build the prompt + budget gate.
  //
  // Story P3.7.3 / FR152 amends FR141 + NFR47 mode #4: when retrieval is on
  // (--relevance-threshold > 0) we thread the budget through `buildPromptWithDrops`
  // so ranked-fill packs the most-relevant sections under budget first. Exit 4
  // is reserved for the residual case where the non-doc payload alone (filtered
  // diff + schema + template) exceeds budget, or where no candidate section
  // fits. When ranked-fill drops sections successfully the run continues
  // with the dropped-N stderr header and the trace gains `_rankedFillResult`.
  //
  // Default path (no --relevance-threshold) → ranked-fill is inactive (no
  // candidates to rank), `buildPromptWithDrops` returns an empty
  // `droppedSections` array, and the exit-4 path fires verbatim for any
  // oversized prompt — today's behaviour preserved (AC8 / NFR44 parity).
  const useRankedFill =
    typeof options.relevanceThreshold === 'number' &&
    Number.isFinite(options.relevanceThreshold) &&
    options.relevanceThreshold > 0
  const buildResult = buildPromptWithDrops(input, loadTemplate(), {
    relevanceThreshold: options.relevanceThreshold,
    // Pass the budget ONLY when retrieval is on; otherwise omit so the
    // default code path stays observably unchanged (AC5).
    promptTokenBudget: useRankedFill ? budget : undefined,
  })
  const prompt = buildResult.prompt
  const droppedSections = buildResult.droppedSections
  const estimatedTokens = estimatePromptTokens(prompt)
  if (estimatedTokens > budget) {
    // Residual exit-4: the assembled prompt is over budget even after ranked-
    // fill (when retrieval is on). With the conservative section-cost measure
    // (drift-engine never under-counts the per-doc wrapper) this means either
    // the non-doc payload alone (diff + schema + instructions) exceeds budget,
    // or no candidate section fits in the residual budget — narrowing scope
    // alone may not help, so the suggestion covers diff-shrinking too.
    const payload = {
      error: 'prompt_too_large',
      estimatedTokens,
      suggestion:
        "Narrow your doc-scope (try '/delfini --scope <fewer-paths>'), split the PR, or shrink the diff — the prompt is over budget even before any doc sections fit.",
    }
    stdout.write(`${JSON.stringify(payload)}\n`)
    return 4
  }
  // Success-with-drops: ranked-fill dropped at least one section but the
  // assembled prompt fits. Single human-readable stderr header — no per-
  // section enumeration (the trace JSON carries the structured list).
  if (droppedSections.length > 0) {
    // AC4 wording is "dropped N section(s) — over prompt budget" — the (s)
    // parenthetical is intentional (matches the story spec verbatim).
    stderr.write(`dropped ${droppedSections.length} section(s) — over prompt budget\n`)
  }

  // 7. Write the three trace artefacts. ensureTraceDir is idempotent
  //    (P3.2.6); writeTraceFile validates the basename has no separators.
  ensureTraceDir(repoRoot)
  const schemaJson = zodToJsonSchema(analysisSchema)
  // Compose the trace artefact additively (P3.7.2 + P3.7.3):
  //   - `_filterResult` (P3.7.2 / FR151) — diff pre-filter dropped record,
  //     present when the diff pre-filter ran.
  //   - `_rankedFillResult` (P3.7.3 / FR152) — ranked-fill dropped sections,
  //     present when ranked-fill dropped at least one section.
  // Both siblings are additive, leading-underscore metadata. The subagent
  // prompt reads only `diff` / `docs` / `prMetadata`. Absent key === gate
  // did not fire (per AC6 — never `{ droppedSections: [] }` falsely
  // implying ranked-fill ran and found nothing).
  const traceJson: Record<string, unknown> = { ...input }
  if (filterResult !== null) {
    traceJson._filterResult = {
      droppedPaths: filterResult.droppedPaths,
      droppedHunks: filterResult.droppedHunks,
    }
  }
  if (droppedSections.length > 0) {
    traceJson._rankedFillResult = { droppedSections }
  }
  writeTraceFile(repoRoot, 'analysis-input.json', `${JSON.stringify(traceJson, null, 2)}\n`)
  writeTraceFile(repoRoot, 'analysis-prompt.md', prompt)
  writeTraceFile(repoRoot, 'schema.json', `${JSON.stringify(schemaJson, null, 2)}\n`)

  return 0
}

// -- Scope resolution --------------------------------------------------------

/**
 * Returns the effective doc-scope-paths array, or null if no scope is
 * configured (signals exit 2 — NFR47 mode 5). `config` is the already-read
 * persisted config (null when none exists).
 */
function resolveScopePaths(
  scopeOption: RunLocalPrepareOptions['scope'],
  config: DelfiniConfig | null,
): string[] | null {
  if (scopeOption !== undefined) {
    const normalised = normaliseScopeOption(scopeOption)
    // Defensive: `--scope ""` or `--scope ", , "` reduce to an empty array
    // after normalisation. That is almost certainly a user mistake (the
    // intent is "no scope at all", which is what exit 2 + NFR47 mode 5
    // already cover). Treat this as "no scope configured" rather than
    // silently proceeding with zero docs.
    if (normalised.length === 0) {
      return null
    }
    return normalised
  }

  if (config === null) {
    return null
  }
  // Defensive: the config primitive guarantees non-empty entries via its Zod
  // schema (z.string().min(1)), but treat an empty array as "configured but
  // empty" — still proceed (yields zero docs, may yield zero findings — that's
  // the user's choice).
  return config.doc_scope
}

/**
 * Returns the effective `ignore_code_scope` array: the `--ignore-code-scope`
 * override when supplied, else the persisted `ignore_code_scope`, else empty.
 * Empty means "ignore nothing" — the observable no-op default.
 */
function resolveIgnoreCodeScope(
  ignoreOption: RunLocalPrepareOptions['ignoreCodeScope'],
  config: DelfiniConfig | null,
): string[] {
  if (ignoreOption !== undefined) {
    return normaliseScopeOption(ignoreOption)
  }
  return config?.ignore_code_scope ?? []
}

function normaliseScopeOption(scope: string | string[]): string[] {
  const raw = Array.isArray(scope) ? scope : scope.split(',')
  return raw.map((s) => s.trim()).filter((s) => s.length > 0)
}

// -- Diff computation (--diff-source) ----------------------------------------

/**
 * Assembles the analysed diff per `--diff-source` (FR141a):
 *   - `committed` — `git diff <base> HEAD` (committed delta; no untracked)
 *   - `local`     — `git diff HEAD` + untracked files
 *   - `both`      — `git diff <base>` (working tree vs base) + untracked files
 *
 * No default-branch special-casing: on the default branch base ≈ HEAD, so
 * `committed` yields an empty range and `both` collapses to `local` naturally.
 */
async function computeDiff(
  git: SimpleGit,
  repoRoot: string,
  baseRef: string,
  diffSource: DiffSource,
): Promise<string> {
  switch (diffSource) {
    case 'committed':
      // Two-dot range — commit-to-commit, matching the Action's behaviour.
      return git.diff([baseRef, 'HEAD'])
    case 'local': {
      const tracked = await git.diff(['HEAD'])
      const untracked = await computeUntrackedDiff(git, repoRoot)
      return concatDiff(tracked, untracked)
    }
    case 'both': {
      const tracked = await git.diff([baseRef])
      const untracked = await computeUntrackedDiff(git, repoRoot)
      return concatDiff(tracked, untracked)
    }
  }
}

/**
 * Renders every untracked, non-ignored file as an added-file diff and
 * concatenates them. `git diff HEAD` / `git diff <base>` omit untracked files;
 * a brand-new doc-relevant module must still reach the prompt (FR141a).
 *
 * Non-mutating by construction — never stages, adds, or stashes. We enumerate
 * via `git ls-files --others --exclude-standard` and render each file through
 * `git diff --no-index` against the null path.
 */
async function computeUntrackedDiff(git: SimpleGit, repoRoot: string): Promise<string> {
  const untracked = await listUntrackedFiles(git)
  if (untracked.length === 0) {
    return ''
  }
  const parts: string[] = []
  for (const rel of untracked) {
    const fileDiff = await diffUntrackedFile(repoRoot, rel)
    if (fileDiff.length > 0) {
      parts.push(fileDiff)
    }
  }
  return parts.join('')
}

/**
 * Returns the new-file diff for a single untracked path via
 * `git diff --no-index -- /dev/null <file>`.
 *
 * `git diff --no-index` exits `1` when the inputs differ (which they always
 * do here — one side is the empty null path), and `simple-git` rejects on a
 * non-zero exit, discarding the diff body. We shell out via `execFile`
 * instead, where Node attaches the captured stdout to the exit-1 error so we
 * can read the diff off it. `/dev/null` is a git-internal token honoured on
 * all platforms (including Windows) in `--no-index` mode.
 */
async function diffUntrackedFile(repoRoot: string, relPath: string): Promise<string> {
  const args = ['-C', repoRoot, 'diff', '--no-index', '--no-color', '--', '/dev/null', relPath]
  try {
    const { stdout } = await execFileAsync('git', args, { maxBuffer: UNTRACKED_DIFF_MAX_BUFFER })
    // Exit 0 — inputs identical (e.g. an empty new file); no diff to emit.
    return stdout
  } catch (err) {
    // `git diff --no-index` exits 1 *only* when the inputs differ — the normal
    // case here (one side is the empty null path), with the diff body on stdout.
    // Any other failure (exit ≥2 fatal, ENOENT, maxBuffer overflow) carries an
    // empty/truncated stdout: rethrow rather than silently dropping the file
    // from the analysed diff, which would defeat FR141a's "brand-new file must
    // reach the prompt" guarantee.
    const e = err as { code?: number; stdout?: string }
    if (e.code === 1 && typeof e.stdout === 'string') {
      return e.stdout
    }
    throw err
  }
}

/** Concatenates two diff fragments, guaranteeing a separating newline. */
function concatDiff(tracked: string, untracked: string): string {
  if (tracked.length === 0) return untracked
  if (untracked.length === 0) return tracked
  return tracked.endsWith('\n') ? `${tracked}${untracked}` : `${tracked}\n${untracked}`
}

// -- Doc reading -------------------------------------------------------------

async function readDocs(
  absolutePaths: string[],
  repoRoot: string,
  stderr: NodeJS.WritableStream,
): Promise<DocFile[]> {
  const docs: DocFile[] = []
  for (const abs of absolutePaths) {
    const relative = path.relative(repoRoot, abs).split(path.sep).join('/')
    let content: string
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch (err) {
      // Race: file existed at expandDocScope() time (fs.stat / tinyglobby)
      // but is gone now (e.g. branch switch, editor save). Mirror the
      // NFR47 mode 6 "warn-and-continue" semantics rather than crashing.
      if (isNoEntError(err)) {
        stderr.write(formatMissingPathWarning(relative))
        continue
      }
      throw err
    }
    docs.push({
      path: relative,
      content,
      // V1 — no YAML front-matter parsing. See story Dev Notes §
      // "frontMatterLineCount deferral".
      frontMatterLineCount: 0,
    })
  }
  return docs
}

function isNoEntError(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

// -- Synthetic PRMetadata for local runs ------------------------------------

async function buildPRMetadata(
  git: SimpleGit,
  repoRoot: string,
  baseRef: string,
): Promise<PRMetadata> {
  const headSha = await safeShortSha(git, 'HEAD')
  const baseSha = await safeShortSha(git, baseRef)
  return {
    owner: 'local',
    repo: path.basename(repoRoot),
    prNumber: 0,
    headSha,
    baseSha,
    title: 'Local /delfini run',
  }
}

async function safeShortSha(git: SimpleGit, ref: string): Promise<string> {
  try {
    const raw = await git.revparse(['--short', ref])
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : 'unknown'
  } catch {
    return 'unknown'
  }
}

// -- Zod → JSON Schema (inline, minimal walker) ------------------------------
//
// Handles the constructs used by `analysisSchema` only: ZodObject, ZodArray,
// ZodString (with min-length), ZodNumber (with min/max + int), ZodEnum,
// ZodLiteral, ZodNullable. The schema is small and stable — a 50-line walker
// covers it. If `analysisSchema` ever grows a construct we don't handle, the
// recursive default branch throws and surfaces the gap loudly rather than
// emitting a silently-wrong schema.
//
// Rationale (see story Dev Notes): adding `zod-to-json-schema` as a runtime
// dep violates the Skill packages' minimum-viable-surface rule.

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: readonly (string | number)[]
  const?: unknown
  minLength?: number
  minimum?: number
  maximum?: number
  additionalProperties?: boolean
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  return walk(schema)
}

function walk(schema: ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName?: string } & Record<string, unknown>
  const typeName = def.typeName

  switch (typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, child] of Object.entries(shape)) {
        const childSchema = child as ZodTypeAny
        properties[key] = walk(childSchema)
        const childTypeName = (childSchema._def as { typeName?: string }).typeName
        // ZodOptional / ZodDefault → not required; everything else → required.
        // analysisSchema has no optionals, but defending the walker for future.
        if (childTypeName !== 'ZodOptional' && childTypeName !== 'ZodDefault') {
          required.push(key)
        }
      }
      const result: JsonSchema = { type: 'object', properties, additionalProperties: false }
      if (required.length > 0) {
        result.required = required
      }
      return result
    }
    case 'ZodArray': {
      const inner = (def as { type: ZodTypeAny }).type
      return { type: 'array', items: walk(inner) }
    }
    case 'ZodString': {
      const result: JsonSchema = { type: 'string' }
      const checks = (def as { checks?: Array<{ kind: string; value?: number }> }).checks ?? []
      for (const check of checks) {
        if (check.kind === 'min' && typeof check.value === 'number') {
          result.minLength = check.value
        }
      }
      return result
    }
    case 'ZodNumber': {
      const result: JsonSchema = { type: 'number' }
      const checks = (def as { checks?: Array<{ kind: string; value?: number }> }).checks ?? []
      for (const check of checks) {
        if (check.kind === 'min' && typeof check.value === 'number') {
          result.minimum = check.value
        }
        if (check.kind === 'max' && typeof check.value === 'number') {
          result.maximum = check.value
        }
        if (check.kind === 'int') {
          result.type = 'integer'
        }
      }
      return result
    }
    case 'ZodEnum': {
      const values = (def as { values: readonly string[] }).values
      return { type: 'string', enum: values }
    }
    case 'ZodLiteral': {
      const value = (def as { value: unknown }).value
      const literal: JsonSchema = { const: value }
      if (typeof value === 'string') literal.type = 'string'
      else if (typeof value === 'number') literal.type = 'number'
      else if (typeof value === 'boolean') literal.type = 'boolean'
      return literal
    }
    case 'ZodNullable': {
      const inner = (def as { innerType: ZodTypeAny }).innerType
      const innerSchema = walk(inner)
      // JSON Schema draft-7 idiom for nullable: type as array of [original, "null"].
      if (typeof innerSchema.type === 'string') {
        return { ...innerSchema, type: [innerSchema.type, 'null'] }
      }
      return { ...innerSchema, type: Array.isArray(innerSchema.type) ? [...innerSchema.type, 'null'] : ['null'] }
    }
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = (def as { innerType: ZodTypeAny }).innerType
      return walk(inner)
    }
    default:
      throw new Error(
        `zodToJsonSchema: unsupported Zod type "${typeName ?? 'unknown'}" — extend the walker.`,
      )
  }
}
