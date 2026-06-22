// Delfini config persistence primitives for the @delfini/cli skill.
//
// File location: `<repo-root>/.claude/skills/delfini/delfini-config.json`.
// Schema (v1): `{ version: 1, doc_scope: string[], ignore_code_scope?: string[] }`.
//
//   - `doc_scope`        — the source-of-truth docs Delfini analyses. Each entry
//                          is a directory (recursive .md scan), a single file, or
//                          a glob (expanded via tinyglobby (picomatch@4)).
//   - `ignore_code_scope`— OPTIONAL. Code paths whose CHANGES Delfini ignores:
//                          a changed file matching any entry is dropped from the
//                          analysed diff before prompt assembly. Same path
//                          algebra/dialect as `doc_scope` (dir/file/glob).
//
// The file is committed to git — there is no per-machine state (FR144).
//
// Migration (config-file rename): this module reads `delfini-config.json` and,
// when absent, falls back to a legacy `doc-scope.json` (the pre-rename file,
// shape `{ version, doc_scope }`). Any `writeConfig` emits the new file and
// deletes the legacy one — a transparent one-time rename on the next config
// write. `deleteConfig` removes both. No committed repo breaks across the rename.
//
// Story P3.6.2: doc-scope normalization / validation / classification are
// delegated to the shared drift-engine algebra (P3.6.1), and the glob
// expander runs on tinyglobby (picomatch@4) — the SAME dialect the engine's
// `isFileInDocScope` predicate uses. The CLI's effective matching and the
// engine predicate cannot silently disagree (ADR-2026-06-01).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { glob } from 'tinyglobby'
import { z } from 'zod'

import {
  classifyEntry,
  normalizeDocScope,
  validateDocScopeEntry,
} from '@delfini/drift-engine'

import { getRepoRoot } from './git.js'

// -- Constants ---------------------------------------------------------------

export const DELFINI_CONFIG_RELATIVE_PATH = '.claude/skills/delfini/delfini-config.json'
// Pre-rename file. Read as a fallback and removed on the next `writeConfig`.
export const LEGACY_DOC_SCOPE_RELATIVE_PATH = '.claude/skills/delfini/doc-scope.json'
export const DELFINI_CONFIG_VERSION = 1 as const

const CONFIG_VERSION_MISMATCH_MESSAGE =
  'your delfini-config.json is for a newer @delfini/cli; please upgrade.'

// Canonical relative-root marker passed to validateDocScopeEntry. The engine
// validator is pure and works on path strings — it never touches the real
// filesystem — so we feed it `.` rather than an absolute repo path.
const REPO_ROOT_REL = '.'

// -- Public types ------------------------------------------------------------

export interface DelfiniConfig {
  version: 1
  doc_scope: string[]
  /** Always present after `readConfig` (defaulted to `[]` when absent on disk). */
  ignore_code_scope: string[]
}

export interface ConfigWriteOptions {
  repoRoot?: string
}

/** Partial update applied on top of any existing config by `writeConfig`. */
export interface ConfigUpdate {
  /** Replace `doc_scope`. Must be non-empty after normalisation. */
  doc_scope?: string[]
  /** Replace `ignore_code_scope`. May be empty (means "ignore nothing"). */
  ignore_code_scope?: string[]
}

export interface DocScopeExpansionResult {
  /** Absolute paths to files matched by the scope entries. Sorted, deduped. */
  files: string[]
  /** Original entries from `paths` that resolved to nothing on disk. */
  missingPaths: string[]
}

// -- Public errors -----------------------------------------------------------

export class ConfigVersionMismatchError extends Error {
  readonly code = 'CONFIG_VERSION_MISMATCH' as const
  constructor(message: string = CONFIG_VERSION_MISMATCH_MESSAGE) {
    super(message)
    this.name = 'ConfigVersionMismatchError'
  }
}

export class ConfigCorruptError extends Error {
  readonly code = 'CONFIG_CORRUPT' as const
  constructor(message: string) {
    super(message)
    this.name = 'ConfigCorruptError'
  }
}

export class ConfigValidationError extends Error {
  readonly code = 'CONFIG_VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

// -- Internal schemas --------------------------------------------------------

// Read-time validation: shape only (version + array-of-strings). Content
// validation (per-path repo-root scoping) happens at WRITE time via the
// shared `validateDocScopeEntry`. This asymmetry is intentional — see Dev
// Notes in the story file. `ignore_code_scope` is optional (absent === []).
const configSchemaV1 = z.object({
  version: z.literal(1),
  doc_scope: z.array(z.string().min(1)),
  ignore_code_scope: z.array(z.string().min(1)).optional(),
})

// Permissive top-level schema used to discriminate version mismatches BEFORE
// running the v1 shape check. If `version` is a known integer > 1, throw
// ConfigVersionMismatchError; otherwise fall through to v1 validation.
const versionProbeSchema = z.object({
  version: z.number().int().positive(),
})

// -- Read --------------------------------------------------------------------

/**
 * Read the effective Delfini config, or null if none is configured.
 *
 * Resolution order: `delfini-config.json` first, then a legacy
 * `doc-scope.json` fallback (read-only — migration to the new filename happens
 * on the next `writeConfig`). `ignore_code_scope` is defaulted to `[]` when
 * absent so callers never branch on undefined.
 */
export async function readConfig(repoRoot?: string): Promise<DelfiniConfig | null> {
  const root = repoRoot ?? (await getRepoRoot())

  const primary = await readConfigFile(path.join(root, DELFINI_CONFIG_RELATIVE_PATH))
  if (primary !== null) return primary

  // Legacy fallback — same v1 shape (just without `ignore_code_scope`).
  return readConfigFile(path.join(root, LEGACY_DOC_SCOPE_RELATIVE_PATH))
}

async function readConfigFile(target: string): Promise<DelfiniConfig | null> {
  let raw: string
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch (err) {
    if (isNoEntError(err)) return null
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigCorruptError(
      `${path.basename(target)} is malformed: ${(err as Error).message}`,
    )
  }

  // Version probe first — gives a tailored message for forward-compat.
  const probe = versionProbeSchema.safeParse(parsed)
  if (probe.success && probe.data.version > DELFINI_CONFIG_VERSION) {
    throw new ConfigVersionMismatchError()
  }

  const result = configSchemaV1.safeParse(parsed)
  if (!result.success) {
    throw new ConfigCorruptError(
      `${path.basename(target)} is malformed: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }

  return {
    version: DELFINI_CONFIG_VERSION,
    doc_scope: result.data.doc_scope,
    ignore_code_scope: result.data.ignore_code_scope ?? [],
  }
}

// -- Write -------------------------------------------------------------------

/**
 * Persist a partial config update, merging over any existing config and
 * preserving the scope not being edited. Writes `delfini-config.json` and
 * removes a legacy `doc-scope.json` if present (one-time rename migration).
 *
 * `doc_scope` is required to be non-empty in the final config (a Delfini run
 * with no docs is meaningless); `ignore_code_scope` may be empty.
 */
export async function writeConfig(
  update: ConfigUpdate,
  options?: ConfigWriteOptions,
): Promise<void> {
  const root = options?.repoRoot ?? (await getRepoRoot())

  const existing = await readConfig(root)
  let docScope = existing?.doc_scope ?? []
  let ignoreCodeScope = existing?.ignore_code_scope ?? []

  if (update.doc_scope !== undefined) {
    docScope = validateAndNormalize(update.doc_scope, 'doc_scope', { requireNonEmpty: true })
  }
  if (update.ignore_code_scope !== undefined) {
    ignoreCodeScope = validateAndNormalize(update.ignore_code_scope, 'ignore_code_scope', {
      requireNonEmpty: false,
    })
  }

  if (docScope.length === 0) {
    throw new ConfigValidationError(
      `${DELFINI_CONFIG_RELATIVE_PATH}: doc_scope requires at least one path`,
    )
  }

  const payload: { version: 1; doc_scope: string[]; ignore_code_scope?: string[] } = {
    version: DELFINI_CONFIG_VERSION,
    doc_scope: docScope,
  }
  // Omit `ignore_code_scope` when empty — keep doc-only configs clean; an
  // absent key reads back as `[]` (ignore nothing).
  if (ignoreCodeScope.length > 0) {
    payload.ignore_code_scope = ignoreCodeScope
  }

  const target = path.join(root, DELFINI_CONFIG_RELATIVE_PATH)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  await removeLegacyDocScope(root)
}

/**
 * Persist the doc scope, preserving any existing `ignore_code_scope`. Thin
 * wrapper over `writeConfig` kept for the first-run / `--scope` callers whose
 * only job is to seed the docs Delfini tracks.
 */
export async function writeDocScope(
  paths: string[],
  options?: ConfigWriteOptions,
): Promise<void> {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ConfigValidationError('at least one path is required')
  }
  await writeConfig({ doc_scope: paths }, options)
}

/**
 * Write the install-time scaffold config. ALWAYS emits BOTH `doc_scope` and
 * `ignore_code_scope` fields, and permits empty arrays — so `delfini install`
 * leaves a committed, hand-editable template with both knobs visible even when
 * the user skips every prompt. Validates / normalises any supplied entries via
 * the shared engine algebra; unlike `writeConfig` it neither requires a
 * non-empty `doc_scope` nor omits an empty `ignore_code_scope`. Replaces any
 * existing config (callers gate on `configExists` to avoid clobbering) and
 * migrates away a legacy `doc-scope.json`.
 */
export async function writeConfigScaffold(
  update: { doc_scope: string[]; ignore_code_scope: string[] },
  options?: ConfigWriteOptions,
): Promise<void> {
  const root = options?.repoRoot ?? (await getRepoRoot())
  const docScope = validateAndNormalize(update.doc_scope, 'doc_scope', { requireNonEmpty: false })
  const ignoreCodeScope = validateAndNormalize(update.ignore_code_scope, 'ignore_code_scope', {
    requireNonEmpty: false,
  })

  const payload = {
    version: DELFINI_CONFIG_VERSION,
    doc_scope: docScope,
    ignore_code_scope: ignoreCodeScope,
  }

  const target = path.join(root, DELFINI_CONFIG_RELATIVE_PATH)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  await removeLegacyDocScope(root)
}

/**
 * Validate + normalise a scope entry list via the shared engine algebra.
 * Aggregates ALL per-entry failures into one thrown error. Guards the
 * all-collapse case (`.`, `./`, `docs/..`) when `requireNonEmpty`.
 */
function validateAndNormalize(
  paths: string[],
  field: 'doc_scope' | 'ignore_code_scope',
  opts: { requireNonEmpty: boolean },
): string[] {
  const errors: string[] = []
  for (const entry of paths) {
    const err = validateDocScopeEntry(entry, REPO_ROOT_REL)
    if (err !== null) errors.push(err)
  }
  if (errors.length > 0) {
    throw new ConfigValidationError(
      `${DELFINI_CONFIG_RELATIVE_PATH}: invalid ${field} path(s):\n${errors
        .map((e) => `  - ${e}`)
        .join('\n')}`,
    )
  }

  // P3.6.1 strengthening: normalizeDocScope runs a real POSIX path
  // normalisation per entry (so `'docs//api'`, `'./docs'`, and
  // `'docs/sub/../api/*.md'` persist canonical and picomatch can match them),
  // dedupes (first-occurrence order), and strips trailing slashes.
  const normalised = normalizeDocScope(paths)

  if (opts.requireNonEmpty && normalised.length === 0) {
    // `validateDocScopeEntry` passes repo-root tautologies (`.`, `./`,
    // `docs/..`) but `normalizeDocScope` drops them (they match nothing). For
    // a required field, a silent empty result is a user mistake, not a valid
    // "no scope".
    throw new ConfigValidationError(
      `${DELFINI_CONFIG_RELATIVE_PATH}: every ${field} entry collapses to an empty scope after ` +
        `normalisation (e.g. '.', './', 'docs/..') — provide at least one concrete path`,
    )
  }

  return normalised
}

async function removeLegacyDocScope(root: string): Promise<void> {
  const legacy = path.join(root, LEGACY_DOC_SCOPE_RELATIVE_PATH)
  try {
    await fs.unlink(legacy)
  } catch (err) {
    // Absent legacy file is the common case — nothing to migrate.
    if (!isNoEntError(err)) throw err
  }
}

// -- Existence + delete ------------------------------------------------------

/**
 * True iff a Delfini config exists — the new `delfini-config.json` OR a legacy
 * `doc-scope.json`. Used by `delfini install` to avoid clobbering an existing
 * committed, team-shared config.
 */
export async function configExists(repoRoot?: string): Promise<boolean> {
  const root = repoRoot ?? (await getRepoRoot())
  return (
    (await isFile(path.join(root, DELFINI_CONFIG_RELATIVE_PATH))) ||
    (await isFile(path.join(root, LEGACY_DOC_SCOPE_RELATIVE_PATH)))
  )
}

async function isFile(target: string): Promise<boolean> {
  try {
    // stat + isFile() rather than fs.access — a directory at the JSON path
    // would otherwise report "exists" and the follow-up read would throw an
    // opaque EISDIR. False is the truthful answer in that degenerate case.
    const st = await fs.stat(target)
    return st.isFile()
  } catch {
    return false
  }
}

/**
 * Delete the Delfini config — both the new `delfini-config.json` and any legacy
 * `doc-scope.json` (`delfini --reset-scope`). Idempotent: absent files are a
 * silent no-op.
 */
export async function deleteConfig(repoRoot?: string): Promise<void> {
  const root = repoRoot ?? (await getRepoRoot())
  for (const rel of [DELFINI_CONFIG_RELATIVE_PATH, LEGACY_DOC_SCOPE_RELATIVE_PATH]) {
    try {
      await fs.unlink(path.join(root, rel))
    } catch (err) {
      // ENOENT is fine — idempotent reset. Anything else bubbles up so the
      // caller can surface "tried to reset but couldn't delete".
      if (!isNoEntError(err)) throw err
    }
  }
  // Deliberately do NOT remove `.claude/skills/delfini/` — it also holds
  // SKILL.md (scaffolded by `delfini install`), which `--reset-scope` must
  // not touch.
}

// -- Expand ------------------------------------------------------------------

export async function expandDocScope(
  paths: string[],
  repoRoot?: string,
): Promise<DocScopeExpansionResult> {
  const root = repoRoot ?? (await getRepoRoot())
  const normalisedRoot = path.resolve(root)

  const found = new Set<string>()
  const missing: string[] = []

  for (const rawEntry of paths) {
    if (typeof rawEntry !== 'string') continue

    // Per-entry normalisation via the shared engine algebra. May collapse
    // an entry to nothing (`''`, `'.'`, `'./'`, `'docs/..'`).
    const normalised = normalizeDocScope([rawEntry])
    if (normalised.length === 0) {
      // A genuinely empty / whitespace-only entry is skipped silently (matches
      // the old `entry.length === 0` behaviour). A NON-empty entry that
      // collapses to nothing (`.`, `./`, `docs/..`) is surfaced as missing so
      // the caller emits a normal "Skipped" warning instead of dropping a path
      // the user explicitly listed.
      if (rawEntry.trim().length > 0) missing.push(rawEntry)
      continue
    }
    const entry = normalised[0]!

    // Re-validate at expand time. `writeConfig` rejects escape paths on
    // write, but `delfini-config.json` is committed to git and may be hand-
    // edited; a corrupted entry must NOT walk outside the repo root. Any
    // entry that fails validation is treated as missing so the caller can
    // surface a normal "Skipped" warning rather than a hard failure (which
    // would block the whole skill run on one bad entry).
    if (validateDocScopeEntry(entry, REPO_ROOT_REL) !== null) {
      missing.push(rawEntry)
      continue
    }

    if (classifyEntry(entry) === 'glob') {
      const matches = await glob(entry, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        dot: false,
        // Case-folding parity with the engine predicate (`nocase: true`).
        caseSensitiveMatch: false,
        // Migrating from fast-glob — disable tinyglobby's directory-pattern
        // auto-expansion so a glob like `packages/*/README.md` keeps exact
        // fast-glob semantics.
        expandDirectories: false,
      })
      // Defence-in-depth: an absolute-result glob match could in principle
      // land outside `root` (e.g. via a symlink). Filter to in-root matches.
      const inRoot = matches.filter((m) => isInsideRoot(m, normalisedRoot))
      if (inRoot.length === 0) {
        missing.push(rawEntry)
      } else {
        for (const m of inRoot) found.add(m)
      }
      continue
    }

    // Non-glob entry — resolve against repo root, stat to decide directory
    // vs. file vs. missing.
    const absolute = path.resolve(root, entry)
    let stat
    try {
      stat = await fs.stat(absolute)
    } catch (err) {
      if (isNoEntError(err)) {
        missing.push(rawEntry)
        continue
      }
      throw err
    }

    if (stat.isDirectory()) {
      // Recursive `.md` scan (case-insensitive — macOS may surface .MD).
      const children = await glob('**/*.md', {
        cwd: absolute,
        absolute: true,
        onlyFiles: true,
        caseSensitiveMatch: false,
        dot: false,
        expandDirectories: false,
      })
      for (const c of children) {
        if (isInsideRoot(c, normalisedRoot)) found.add(c)
      }
    } else if (stat.isFile()) {
      if (isInsideRoot(absolute, normalisedRoot)) found.add(absolute)
    } else {
      // Symlinks to non-existent targets, sockets, etc. — treat as missing.
      missing.push(rawEntry)
    }
  }

  const files = Array.from(found).sort()
  return { files, missingPaths: missing }
}

// -- Internal helpers --------------------------------------------------------

function isNoEntError(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/**
 * True iff `absolute` resolves to a path under (or equal to) `normalisedRoot`.
 * Used as defence-in-depth in `expandDocScope` to drop any match that lands
 * outside the repo root — even if a glob, symlink, or hand-edited entry
 * could in principle escape.
 */
function isInsideRoot(absolute: string, normalisedRoot: string): boolean {
  const resolved = path.resolve(absolute)
  return resolved === normalisedRoot || resolved.startsWith(normalisedRoot + path.sep)
}
