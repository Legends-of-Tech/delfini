// `delfini install` — scaffolds the Delfini Skill into a target repo.
//
// Single-write surface, with an interactive auto-invoke opt-in toggle:
//   1. writes `.claude/skills/delfini/SKILL.md` (overwrite — the documented
//      upgrade path per architecture.md L1142)
//   2. interactively asks "Which docs should Delfini track?" then "Which code
//      paths should Delfini ignore?", and writes BOTH to
//      `.claude/skills/delfini/delfini-config.json`. The file is ALWAYS created
//      (when none exists) with both `doc_scope` and `ignore_code_scope` fields —
//      empty arrays when every prompt is skipped or on a non-TTY stdin — so the
//      team gets a committed, hand-editable template. Skips only when a config
//      already exists (never clobbers the committed, team-shared file). An empty
//      `doc_scope` is treated as "unconfigured": the first /delfini run prompts.
//   3. interactively asks "Auto-invoke /delfini on PR creation? (y/n)" — on
//      YES idempotently appends a marker-bounded block to `CLAUDE.md`
//      (creates the file if absent; never duplicates); on NO strips an
//      existing marked block (toggle off; no-op if absent). On a non-TTY
//      stdin with no explicit decision, the CLAUDE.md step is skipped
//      entirely (never blocks; never forces opt-in without consent).
//   4. appends `.delfini-trace/` to `.gitignore` (delegates to
//      `appendToGitignore` from `../trace.js` — do NOT reimplement)
//
// The auto-invoke decision is injectable via `confirmAutoInvoke` (the
// `--auto-invoke` / `--no-auto-invoke` CLI flags and the test seam); the
// doc-scope path list is injectable via `provideDocScope` (the `--scope` CLI
// flag and the test seam). When either is omitted the corresponding default
// interactive readline prompt runs.
//
// Failure modes:
//   - `--tool` not 'CLAUDE'     → throws InstallToolNotSupportedError (NG2)
//   - target path not in a git  → throws RepoRootNotFoundError (passed through
//     repo                         from getRepoRoot — do not catch / re-wrap)
//   - fs write failure          → underlying ENOSPC / EPERM / etc bubbles
//
// The CLI never calls an LLM (FR140). This command is pure local I/O + an
// interactive prompt.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import {
  DELFINI_CONFIG_RELATIVE_PATH,
  ConfigValidationError,
  configExists,
  readConfig,
  writeConfigScaffold,
} from '../config.js'
import { getRepoRoot } from '../git.js'
import { appendToGitignore } from '../trace.js'

// -- Public types ------------------------------------------------------------

export interface InstallLogger {
  log?: (...args: unknown[]) => void
}

export interface RunInstallOptions {
  /** Coding agent target. V1 accepts only 'CLAUDE' (design-spec NG2). */
  tool?: string
  /** Logger for INFO messages. Defaults to `console`. */
  logger?: InstallLogger
  /**
   * Resolves the auto-invoke opt-in. When provided, `runInstall` uses it
   * directly (true → append the CLAUDE.md block; false → strip an existing
   * block) and never prompts — this is the `--auto-invoke` / `--no-auto-invoke`
   * CLI-flag path and the test seam. When omitted, `runInstall` prompts
   * interactively on a TTY, or skips the CLAUDE.md mutation entirely on a
   * non-TTY stdin (never blocks, never forces opt-in without consent).
   */
  confirmAutoInvoke?: () => Promise<boolean>
  /**
   * Resolves the doc-scope path list. When provided, `runInstall` uses it
   * directly (the `--scope` CLI flag and the test seam) and never prompts —
   * a non-empty list is persisted to `delfini-config.json` doc_scope (overwriting any
   * existing file, since an explicit `--scope` is intent-to-overwrite); an
   * empty list is a no-op. When omitted, `runInstall` prompts interactively
   * on a TTY only if no config exists yet; on a non-TTY stdin, or
   * when a scope is already configured, it leaves the config untouched.
   * Invalid paths (rejected on write) warn-and-skip — the scaffold always
   * completes; the SKILL.md first-run prompt re-seeds the scope later.
   */
  provideDocScope?: () => Promise<string[]>
  /**
   * Resolves the `ignore_code_scope` path list (code paths whose changes
   * Delfini ignores). When provided, `runInstall` uses it directly (the
   * `--ignore-code-scope` CLI flag and the test seam) and never prompts. When
   * omitted, `runInstall` prompts interactively on a TTY (right after the
   * doc-scope prompt) only if no config exists yet. Either way the committed
   * `delfini-config.json` is created with both fields — empty when skipped.
   */
  provideIgnoreCodeScope?: () => Promise<string[]>
}

/** Resolved auto-invoke decision: append, strip, or leave CLAUDE.md untouched. */
type AutoInvokeDecision = 'yes' | 'no' | 'skip'

// -- Public errors -----------------------------------------------------------

export class InstallToolNotSupportedError extends Error {
  readonly code = 'INSTALL_TOOL_NOT_SUPPORTED' as const

  constructor(tool: string) {
    super(
      `delfini install: --tool '${tool}' is not supported. The Skill is Claude-only ` +
        `in V1 (design-spec NG2 / project-context "Skill — Out of Scope in V1 / V1.1: ` +
        `No multi-LLM-provider support — Claude-only by design"). Use --tool CLAUDE ` +
        `(the default).`,
    )
    this.name = 'InstallToolNotSupportedError'
  }
}

// -- Constants ---------------------------------------------------------------

// Marker pair is load-bearing — the idempotency mechanism. The `v1` suffix is
// the migration affordance for any future backwards-incompatible append-block
// change (see Dev Notes in the story file).
const CLAUDE_MD_OPEN_MARKER = '<!-- delfini:auto-invoke-block-v1 -->'
const CLAUDE_MD_CLOSE_MARKER = '<!-- /delfini:auto-invoke-block-v1 -->'

const SKILL_RELATIVE_PATH = '.claude/skills/delfini/SKILL.md'
const CLAUDE_MD_FILENAME = 'CLAUDE.md'

const SUPPORTED_TOOL = 'CLAUDE'

// Resolve `packages/cli/templates/` relative to this module via import.meta.url.
// The module depth DIFFERS by layout: source/vitest runs from
// `src/commands/install.ts` (templates two levels up), but the tsup BUNDLE
// inlines this file into `dist/cli.js` (templates ONE level up) — a fixed
// `../../` walked out of the package in the published tarball and broke
// `npx @delfini/cli install` in every release up to 0.1.1 (resolved
// `node_modules/@delfini/templates`). Walk upward until templates/SKILL.md
// exists instead of assuming a depth.
const TEMPLATES_DIR = resolveTemplatesDir()

function resolveTemplatesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, 'templates')
    if (existsSync(join(candidate, 'SKILL.md'))) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('templates/ directory not found relative to the CLI module')
}

// -- Public function ---------------------------------------------------------

export async function runInstall(
  targetPath: string,
  options?: RunInstallOptions,
): Promise<void> {
  const tool = options?.tool ?? SUPPORTED_TOOL
  const logger: InstallLogger = options?.logger ?? console

  // Cheap check first: --tool validation runs before git-root detection so a
  // user passing --tool CURSOR gets the tool-specific error even if they're
  // also outside a git repo.
  if (tool !== SUPPORTED_TOOL) {
    throw new InstallToolNotSupportedError(tool)
  }

  const resolvedTarget = resolve(process.cwd(), targetPath)
  const repoRoot = await getRepoRoot(resolvedTarget)

  writeSkillTemplate(repoRoot, logger)
  await applyConfig(repoRoot, logger, options?.provideDocScope, options?.provideIgnoreCodeScope)
  await applyAutoInvokeDecision(repoRoot, logger, options?.confirmAutoInvoke)
  appendGitignoreLine(repoRoot, logger)
}

// -- Config seeding (doc-scope + ignore-code-scope prompts) ------------------

/**
 * Split a free-text answer into a path list. Whitespace- and/or comma-
 * separated; trimmed; empties dropped. Exported for unit testing and reused
 * by the cli.ts `--scope` flag parser. NOT re-exported through the barrel.
 */
export function parseScopeInput(answer: string): string[] {
  return answer
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function sanitiseScope(paths: string[]): string[] {
  return paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

async function applyConfig(
  repoRoot: string,
  logger: InstallLogger,
  provideDocScope?: () => Promise<string[]>,
  provideIgnoreCodeScope?: () => Promise<string[]>,
): Promise<void> {
  const target = join(repoRoot, DELFINI_CONFIG_RELATIVE_PATH)
  const hasSeam = provideDocScope !== undefined || provideIgnoreCodeScope !== undefined

  // Pure-interactive install with a config already present: never clobber the
  // committed, team-shared file. Explicit `--scope` / `--ignore-code-scope`
  // flags ARE intent-to-set and fall through (preserving the field they don't
  // name).
  if (!hasSeam && (await configExists(repoRoot))) {
    log(logger, `delfini-config.json → ${target} (already configured, no change)`)
    return
  }

  // Read any existing config so a single-field flag run (or an empty flag
  // value) preserves the field it doesn't touch.
  const existing = await readConfig(repoRoot)

  const docPaths = await resolveSeedField(
    provideDocScope,
    existing?.doc_scope ?? [],
    promptDocScope,
    hasSeam,
  )
  const ignorePaths = await resolveSeedField(
    provideIgnoreCodeScope,
    existing?.ignore_code_scope ?? [],
    promptIgnoreCodeScope,
    hasSeam,
  )

  // ALWAYS write the scaffold — even when both lists are empty (every prompt
  // skipped, or a non-TTY shell), the committed `delfini-config.json` is
  // created with BOTH fields so the team gets a visible, hand-editable template.
  try {
    await writeConfigScaffold(
      { doc_scope: docPaths, ignore_code_scope: ignorePaths },
      { repoRoot },
    )
    log(
      logger,
      `delfini-config.json → ${target} (wrote ${docPaths.length} doc path(s), ${ignorePaths.length} ignore path(s))`,
    )
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      // Warn-and-skip: a bad path must not abort the rest of the scaffold.
      log(
        logger,
        `delfini-config.json → ${target} (skipped — ${err.message}). ` +
          `Fix the path(s) and re-run \`delfini install\`, edit the file directly, ` +
          `or set the scope on the first /delfini run.`,
      )
      return
    }
    // Real I/O failures (EACCES, ENOSPC, …) still bubble.
    throw err
  }
}

/**
 * Resolve one scope field's seed list:
 *   - a non-empty flag/seam value wins;
 *   - an empty flag value, or a flag run that named the OTHER field, preserves
 *     the existing value (never silently wipes a field);
 *   - a pure-interactive run prompts on a TTY, else yields `[]`.
 */
async function resolveSeedField(
  provide: (() => Promise<string[]>) | undefined,
  existingValue: string[],
  prompt: () => Promise<string[]>,
  hasSeam: boolean,
): Promise<string[]> {
  if (provide !== undefined) {
    const fromFlag = sanitiseScope(await provide())
    if (fromFlag.length > 0) return fromFlag
    return existingValue
  }
  if (hasSeam) {
    return existingValue
  }
  return process.stdin.isTTY ? await prompt() : []
}

async function promptDocScope(): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      'Which docs should Delfini track? Enter one or more paths — directories ' +
        '(recursive .md scan), files, or globs, space- or comma-separated ' +
        '(e.g. `docs/ specs/architecture.md packages/*/README.md`). Leave blank to skip: ',
    )
    return parseScopeInput(answer)
  } finally {
    // Closing the interface is load-bearing — leaving it open keeps stdin
    // referenced and the process never exits (mirrors promptAutoInvoke).
    rl.close()
  }
}

async function promptIgnoreCodeScope(): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      'Which code paths should Delfini IGNORE? Changes under these paths are ' +
        'skipped during analysis. Enter directories, files, or globs, space- or ' +
        'comma-separated (e.g. `src/generated/** db/migrations/`). Leave blank for none: ',
    )
    return parseScopeInput(answer)
  } finally {
    rl.close()
  }
}

// -- Auto-invoke opt-in (interactive toggle) ---------------------------------

/**
 * Parse a free-text y/n answer. Case-insensitive, trimmed. `y` / `yes` → true;
 * everything else (including `n`, empty, garbage) → false. Exported for unit
 * testing; NOT re-exported through the package barrel (internal helper).
 */
export function parseYesNo(answer: string): boolean {
  const normalised = answer.trim().toLowerCase()
  return normalised === 'y' || normalised === 'yes'
}

async function applyAutoInvokeDecision(
  repoRoot: string,
  logger: InstallLogger,
  confirmAutoInvoke?: () => Promise<boolean>,
): Promise<void> {
  const decision = await resolveAutoInvoke(confirmAutoInvoke)
  if (decision === 'yes') {
    appendClaudeMdBlock(repoRoot, logger)
  } else if (decision === 'no') {
    stripClaudeMdBlock(repoRoot, logger)
  } else {
    // Non-interactive stdin with no explicit decision: never block, never
    // force opt-in, never silently strip. Leave CLAUDE.md untouched.
    const target = join(repoRoot, CLAUDE_MD_FILENAME)
    log(logger, `CLAUDE.md → ${target} (non-interactive shell: auto-invoke prompt skipped, no change)`)
  }
}

async function resolveAutoInvoke(
  confirmAutoInvoke?: () => Promise<boolean>,
): Promise<AutoInvokeDecision> {
  if (confirmAutoInvoke) {
    return (await confirmAutoInvoke()) ? 'yes' : 'no'
  }
  if (!process.stdin.isTTY) {
    return 'skip'
  }
  return (await promptAutoInvoke()) ? 'yes' : 'no'
}

async function promptAutoInvoke(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('Auto-invoke /delfini on PR creation? (y/n) ')
    return parseYesNo(answer)
  } finally {
    // Closing the interface is load-bearing — leaving it open keeps stdin
    // referenced and the process never exits (AC11).
    rl.close()
  }
}

// -- Internal helpers --------------------------------------------------------

function writeSkillTemplate(repoRoot: string, logger: InstallLogger): void {
  const target = join(repoRoot, SKILL_RELATIVE_PATH)
  const templateSource = join(TEMPLATES_DIR, 'SKILL.md')

  // Preserve byte-for-byte (incl. any trailing newline the template ships).
  const content = readFileSync(templateSource)

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  log(logger, `SKILL.md → ${target}`)
}

function appendClaudeMdBlock(repoRoot: string, logger: InstallLogger): void {
  const target = join(repoRoot, CLAUDE_MD_FILENAME)
  const blockSource = join(TEMPLATES_DIR, 'claude-md-append-block.txt')

  // Trim trailing whitespace from the body so the marker pair sits flush
  // regardless of how the placeholder file ends (placeholder ships with a
  // trailing newline; P3.3.2 may or may not).
  const body = readFileSync(blockSource, 'utf8').replace(/\s+$/u, '')
  const block = `${CLAUDE_MD_OPEN_MARKER}\n${body}\n${CLAUDE_MD_CLOSE_MARKER}\n`

  if (!existsSync(target)) {
    writeFileSync(target, block)
    log(logger, `CLAUDE.md → ${target} (created)`)
    return
  }

  const existing = readFileSync(target, 'utf8')

  // Detection is purely by opening-marker substring match. See AC4 — we do
  // NOT parse the markdown, NOT compare hashes, NOT check for the closing
  // marker independently. Absent opening marker → append.
  if (existing.includes(CLAUDE_MD_OPEN_MARKER)) {
    log(logger, `CLAUDE.md → ${target} (block already present, no change)`)
    return
  }

  if (existing.length === 0) {
    // Empty file: treat as missing-content — no leading newline needed.
    writeFileSync(target, block)
    log(logger, `CLAUDE.md → ${target} (block appended)`)
    return
  }

  const needsLeadingNewline = !existing.endsWith('\n')
  const prefix = needsLeadingNewline ? '\n' : ''
  writeFileSync(target, `${existing}${prefix}${block}`)
  log(logger, `CLAUDE.md → ${target} (block appended)`)
}

function stripClaudeMdBlock(repoRoot: string, logger: InstallLogger): void {
  const target = join(repoRoot, CLAUDE_MD_FILENAME)

  if (!existsSync(target)) {
    // NO never creates CLAUDE.md.
    log(logger, `CLAUDE.md → ${target} (no block to remove, no change)`)
    return
  }

  const existing = readFileSync(target, 'utf8')
  const openIdx = existing.indexOf(CLAUDE_MD_OPEN_MARKER)
  if (openIdx === -1) {
    log(logger, `CLAUDE.md → ${target} (no block to remove, no change)`)
    return
  }

  // Find the closing marker after the opening one.
  const afterOpen = openIdx + CLAUDE_MD_OPEN_MARKER.length
  const closeIdx = existing.indexOf(CLAUDE_MD_CLOSE_MARKER, afterOpen)

  let endIdx: number
  if (closeIdx === -1) {
    // Malformed block (opening marker but no closing marker — user deleted the
    // close tag): strip from the opening marker to EOF so a later YES re-appends
    // a single clean block. Mirrors the AC6 "delete the whole block" recovery.
    endIdx = existing.length
  } else {
    endIdx = closeIdx + CLAUDE_MD_CLOSE_MARKER.length
    // Consume one trailing newline (LF or CRLF) immediately after the close
    // marker so removal does not leave a dangling blank line where the block
    // sat. This makes a YES→NO→YES cycle byte-stable.
    if (existing.startsWith('\r\n', endIdx)) {
      endIdx += 2
    } else if (existing[endIdx] === '\n') {
      endIdx += 1
    }
  }

  const result = existing.slice(0, openIdx) + existing.slice(endIdx)
  writeFileSync(target, result)
  log(logger, `CLAUDE.md → ${target} (block removed)`)
}

function appendGitignoreLine(repoRoot: string, logger: InstallLogger): void {
  const target = join(repoRoot, '.gitignore')
  // Reuse — `appendToGitignore` already handles CRLF, missing trailing
  // newline, file-not-present, idempotent re-run, exact-line matching.
  const { changed } = appendToGitignore(repoRoot)
  if (changed) {
    log(logger, `.gitignore → ${target} (appended .delfini-trace/)`)
  } else {
    log(logger, `.gitignore → ${target} (.delfini-trace/ already present, no change)`)
  }
}

function log(logger: InstallLogger, message: string): void {
  // Tolerate logger objects that don't define `.log` (e.g. a strict-shape stub
  // in a downstream consumer). console.log is always present.
  if (typeof logger.log === 'function') {
    logger.log(message)
  }
}
