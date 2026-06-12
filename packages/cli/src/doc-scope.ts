// Doc-scope persistence primitives for the @delfini/cli skill.
//
// File location: `<repo-root>/.claude/skills/delfini/doc-scope.json`.
// Schema (v1): `{ version: 1, doc_scope: string[] }`.
//
// Each entry is a directory (recursive .md scan), a single file, or a glob
// (expanded via tinyglobby (picomatch@4)). The file is committed to git —
// there is no per-machine state (FR144).
//
// Public API consumed by:
//   - `delfini local-prepare` (Story P3.2.2)        — readDocScope + expandDocScope
//   - SKILL.md protocol step 2 (Story P3.3.1)       — docScopeExists + writeDocScope
//   - `delfini --reset-scope` subcommand (P3.2.4)   — deleteDocScope
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

export const DOC_SCOPE_RELATIVE_PATH = '.claude/skills/delfini/doc-scope.json'
export const DOC_SCOPE_VERSION = 1 as const

const DOC_SCOPE_VERSION_MISMATCH_MESSAGE =
  'your doc-scope.json is for a newer @delfini/cli; please upgrade.'

// Canonical relative-root marker passed to validateDocScopeEntry. The engine
// validator is pure and works on path strings — it never touches the real
// filesystem — so we feed it `.` rather than an absolute repo path.
const REPO_ROOT_REL = '.'

// -- Public types ------------------------------------------------------------

export interface DocScope {
  version: 1
  doc_scope: string[]
}

export interface DocScopeWriteOptions {
  repoRoot?: string
}

export interface DocScopeExpansionResult {
  /** Absolute paths to files matched by the scope entries. Sorted, deduped. */
  files: string[]
  /** Original entries from `paths` that resolved to nothing on disk. */
  missingPaths: string[]
}

// -- Public errors -----------------------------------------------------------

export class DocScopeVersionMismatchError extends Error {
  readonly code = 'DOC_SCOPE_VERSION_MISMATCH' as const
  constructor(message: string = DOC_SCOPE_VERSION_MISMATCH_MESSAGE) {
    super(message)
    this.name = 'DocScopeVersionMismatchError'
  }
}

export class DocScopeCorruptError extends Error {
  readonly code = 'DOC_SCOPE_CORRUPT' as const
  constructor(message: string) {
    super(message)
    this.name = 'DocScopeCorruptError'
  }
}

export class DocScopeValidationError extends Error {
  readonly code = 'DOC_SCOPE_VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'DocScopeValidationError'
  }
}

// -- Internal schemas --------------------------------------------------------

// Read-time validation: shape only (version + array-of-strings). Content
// validation (per-path repo-root scoping) happens at WRITE time via the
// shared `validateDocScopeEntry`. This asymmetry is intentional — see Dev
// Notes in the story file.
const docScopeSchemaV1 = z.object({
  version: z.literal(1),
  doc_scope: z.array(z.string().min(1)),
})

// Permissive top-level schema used to discriminate version mismatches BEFORE
// running the v1 shape check. If `version` is a known integer > 1, throw
// DocScopeVersionMismatchError; otherwise fall through to v1 validation.
const versionProbeSchema = z.object({
  version: z.number().int().positive(),
})

// -- Read --------------------------------------------------------------------

export async function readDocScope(repoRoot?: string): Promise<DocScope | null> {
  const root = repoRoot ?? (await getRepoRoot())
  const target = path.join(root, DOC_SCOPE_RELATIVE_PATH)

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
    throw new DocScopeCorruptError(
      `${DOC_SCOPE_RELATIVE_PATH} is malformed: ${(err as Error).message}`,
    )
  }

  // Version probe first — gives a tailored message for forward-compat.
  const probe = versionProbeSchema.safeParse(parsed)
  if (probe.success && probe.data.version > DOC_SCOPE_VERSION) {
    throw new DocScopeVersionMismatchError()
  }

  const result = docScopeSchemaV1.safeParse(parsed)
  if (!result.success) {
    throw new DocScopeCorruptError(
      `${DOC_SCOPE_RELATIVE_PATH} is malformed: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }

  return result.data
}

// -- Write -------------------------------------------------------------------

export async function writeDocScope(
  paths: string[],
  options?: DocScopeWriteOptions,
): Promise<void> {
  const root = options?.repoRoot ?? (await getRepoRoot())

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new DocScopeValidationError('at least one path is required')
  }

  // Per-entry validation via the shared engine algebra. Aggregate ALL failures
  // into a single thrown error (still better DX than throw-on-first).
  const errors: string[] = []
  for (const entry of paths) {
    const err = validateDocScopeEntry(entry as string, REPO_ROOT_REL)
    if (err !== null) errors.push(err)
  }

  if (errors.length > 0) {
    throw new DocScopeValidationError(
      `${DOC_SCOPE_RELATIVE_PATH}: invalid path(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    )
  }

  // P3.6.1 strengthening: the engine's normalizeDocScope runs a real POSIX
  // path normalisation per entry, so `'docs//api'`, `'./docs'`, and
  // `'docs/sub/../api/*.md'` persist in their canonical form — picomatch can
  // actually match them. Also dedupes (preserves first-occurrence order) and
  // strips trailing slashes.
  const normalised = normalizeDocScope(paths)

  // Guard the all-collapse case. `validateDocScopeEntry` passes repo-root
  // tautologies like `.`, `./`, and `docs/..`, but `normalizeDocScope` drops
  // them (they match nothing under the shared dialect — `isFileInDocScope`
  // treats `.` as match-nothing). Without this guard, `writeDocScope(['.'])`
  // would silently persist `{doc_scope: []}` — an empty, meaningless scope
  // with no error. Mirror the empty-array rejection above. A PARTIAL collapse
  // (at least one surviving entry) is fine — that is the documented dedupe
  // behaviour, not an error.
  if (normalised.length === 0) {
    throw new DocScopeValidationError(
      `${DOC_SCOPE_RELATIVE_PATH}: every entry collapses to an empty scope after ` +
        `normalisation (e.g. '.', './', 'docs/..') — provide at least one concrete path`,
    )
  }

  const target = path.join(root, DOC_SCOPE_RELATIVE_PATH)
  await fs.mkdir(path.dirname(target), { recursive: true })

  const payload: DocScope = { version: DOC_SCOPE_VERSION, doc_scope: normalised }
  const json = `${JSON.stringify(payload, null, 2)}\n`
  await fs.writeFile(target, json, 'utf8')
}

// -- Existence + delete ------------------------------------------------------

export async function docScopeExists(repoRoot?: string): Promise<boolean> {
  const root = repoRoot ?? (await getRepoRoot())
  const target = path.join(root, DOC_SCOPE_RELATIVE_PATH)
  try {
    // Use stat + isFile() rather than fs.access. A directory at the JSON
    // path (`<root>/.claude/skills/delfini/doc-scope.json/`) would otherwise
    // be reported as "exists" — the follow-up readDocScope would then throw
    // an opaque EISDIR. False from this primitive is the truthful answer in
    // that degenerate case.
    const st = await fs.stat(target)
    return st.isFile()
  } catch {
    return false
  }
}

export async function deleteDocScope(repoRoot?: string): Promise<void> {
  const root = repoRoot ?? (await getRepoRoot())
  const target = path.join(root, DOC_SCOPE_RELATIVE_PATH)
  try {
    await fs.unlink(target)
  } catch (err) {
    // ENOENT is fine — idempotent reset. Anything else bubbles up so the
    // caller can surface "tried to reset but couldn't delete" rather than
    // silently succeeding.
    if (!isNoEntError(err)) throw err
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

    // Re-validate at expand time. `writeDocScope` rejects escape paths on
    // write, but `doc-scope.json` is committed to git and may be hand-
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
