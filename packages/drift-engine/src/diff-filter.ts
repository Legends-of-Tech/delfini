// packages/drift-engine/src/diff-filter.ts
//
// Deterministic unified-diff pre-filter (Story P3.7.2 / FR151). Drops hunks
// that cannot carry doc-claim signal before prompt assembly: lockfile churn,
// generated output, vendored code, test fixtures (path-level), plus pure
// whitespace and import-ordering hunks (hunk-level).
//
// Pure-logic — no I/O, no clock, no randomness, no new runtime dep. ESLint
// `no-restricted-imports` on packages/drift-engine/src/**/*.ts forbids fs /
// child_process / http / https / @anthropic-ai/sdk / openai / @langchain/* /
// process.env. Path classification uses hand-written predicates — NO
// `picomatch` (Story Dev Notes §"Path classification predicates").
//
// Exposed via `index.ts` (unlike the P3.7.1 relevance internals, which run
// INSIDE `buildPrompt`). The gate for this filter lives at the CONSUMER —
// the CLI's `runLocalPrepare` and the Action's `buildAnalysisInput` call
// `filterDiff` directly at input-assembly time and must reach it through the
// package's public surface (the package `exports` map blocks deep
// `@delfini/drift-engine/src/...` imports). The default consumer path never
// invokes this module, so `buildPrompt` output stays byte-identical and the
// NFR44 snapshot gate stays green (NFR49(b) parity discipline).

/** Why a path or hunk was dropped. */
export type DropReason =
  | 'lockfile'
  | 'generated'
  | 'vendored'
  | 'fixture'
  | 'whitespace-only'
  | 'import-only'

export interface DroppedPath {
  path: string
  reason: DropReason
}

export interface DroppedHunk {
  path: string
  hunkHeader: string
  reason: DropReason
}

export interface FilterDiffResult {
  /** The diff after dropping path-level and hunk-level noise. */
  keptDiff: string
  /** Files dropped in their entirety. */
  droppedPaths: DroppedPath[]
  /** Individual hunks dropped from otherwise-kept files. */
  droppedHunks: DroppedHunk[]
}

// -- Public entry point ------------------------------------------------------

/**
 * Filter a unified-diff string deterministically.
 *
 * The input shape is the same one `buildPrompt`'s `AnalysisInput.diff`
 * consumes: a sequence of `diff --git a/<path> b/<path>` blocks, each with a
 * `--- a/...` / `+++ b/...` preamble followed by one or more `@@ ... @@`
 * hunks. Content before the first `diff --git` header (rare in practice — git
 * does not emit any) is preserved as a leading "noise" segment so callers do
 * not lose surrounding context.
 *
 * Identical input → identical output (NFR46 reproducibility carries forward).
 */
export function filterDiff(diff: string): FilterDiffResult {
  const droppedPaths: DroppedPath[] = []
  const droppedHunks: DroppedHunk[] = []

  const files = parseDiffIntoFiles(diff)
  const keptParts: string[] = []
  if (files.preamble.length > 0) {
    keptParts.push(files.preamble)
  }

  for (const file of files.files) {
    // Path-level drops — classified first, in priority order. Lockfiles win
    // over generated/vendored/fixture since the canonical lockfile names
    // never overlap those patterns in practice.
    const pathReason = classifyPath(file.path)
    if (pathReason !== null) {
      droppedPaths.push({ path: file.path, reason: pathReason })
      continue
    }

    // Hunk-level drops — re-emit the preamble verbatim, then per hunk decide
    // keep/drop, then if EVERY hunk was dropped promote the file itself to
    // droppedPaths (no orphan preamble in keptDiff; see Story Dev Notes
    // §"File whose every hunk is dropped").
    const keptHunks: ParsedHunk[] = []
    const fileDroppedHunks: DroppedHunk[] = []
    for (const hunk of file.hunks) {
      const hunkReason = classifyHunk(hunk, file.path)
      if (hunkReason !== null) {
        fileDroppedHunks.push({
          path: file.path,
          hunkHeader: hunk.header,
          reason: hunkReason,
        })
        continue
      }
      keptHunks.push(hunk)
    }

    if (keptHunks.length === 0 && fileDroppedHunks.length > 0) {
      // Every hunk dropped — collapse to a path-level drop. Pick the most
      // common reason across the file's dropped hunks (deterministic
      // tie-break: first reason encountered wins on ties). This keeps
      // `keptDiff` parseable as a valid unified diff (no orphan preamble).
      const reason = mostCommonHunkReason(fileDroppedHunks)
      droppedPaths.push({ path: file.path, reason })
      continue
    }

    droppedHunks.push(...fileDroppedHunks)
    keptParts.push(emitFile(file, keptHunks))
  }

  return {
    keptDiff: keptParts.join(''),
    droppedPaths,
    droppedHunks,
  }
}

// -- Diff parsing ------------------------------------------------------------

interface ParsedFile {
  /**
   * The "a/<path>" path from the `diff --git` header. For added or removed
   * files the matching b/ or a/ side is `/dev/null`; we always extract the
   * non-null path. Renames (`a/old b/new`) are surfaced under the new (b/)
   * path; this is rare in our consumer's diff and matches the wider engine's
   * convention.
   */
  path: string
  /** The verbatim file slice (preamble + every hunk), bytes preserved. */
  rawSlice: string
  /**
   * Preamble bytes: from the `diff --git` line up to (but not including) the
   * first `@@` line. Re-emitted verbatim. Trailing newline state preserved.
   */
  preamble: string
  hunks: ParsedHunk[]
}

interface ParsedHunk {
  /** Header line `@@ -L,N +L,N @@ optional-section\n` — bytes preserved. */
  header: string
  /** Body bytes following the header up to the next `@@ ` line or EOF. */
  body: string
}

interface ParsedDiff {
  /** Any bytes before the first `diff --git` line. Usually empty. */
  preamble: string
  files: ParsedFile[]
}

function parseDiffIntoFiles(diff: string): ParsedDiff {
  if (diff.length === 0) {
    return { preamble: '', files: [] }
  }

  // Locate every `diff --git ` header. We treat the string position of each
  // match as a file boundary; everything between two consecutive boundaries
  // (or the last boundary and end-of-string) is one file's slice.
  //
  // Two header dialects must be recognised, or a file is silently absorbed
  // into its predecessor's slice (and dropped with it if the predecessor is
  // path-dropped — a silent-data-loss bug):
  //   1. unquoted: `diff --git a/path b/path`
  //   2. C-quoted: `diff --git "a/pa th" "b/pa th"` — git quotes paths
  //      containing spaces / control bytes / non-ASCII when core.quotePath
  //      is on (the default).
  // We anchor on the literal `diff --git ` prefix and split the remainder
  // into the a-side and b-side tokens (quoted or not), then unquote.
  const headerRegex = /^diff --git (.+)$/gm
  const boundaries: { index: number; aPath: string; bPath: string }[] = []
  let m: RegExpExecArray | null
  while ((m = headerRegex.exec(diff)) !== null) {
    const paths = parseHeaderPaths(m[1])
    if (paths === null) continue
    boundaries.push({ index: m.index, aPath: paths.aPath, bPath: paths.bPath })
  }

  if (boundaries.length === 0) {
    return { preamble: diff, files: [] }
  }

  const preamble = diff.slice(0, boundaries[0].index)
  const files: ParsedFile[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].index
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : diff.length
    const fileSlice = diff.slice(start, end)
    const path = pickPrimaryPath(boundaries[i].aPath, boundaries[i].bPath)
    files.push(parseFileSlice(path, fileSlice))
  }

  return { preamble, files }
}

function pickPrimaryPath(aPath: string, bPath: string): string {
  if (bPath && bPath !== '/dev/null') return bPath
  return aPath
}

/**
 * Parse the `<a-side> <b-side>` remainder of a `diff --git ` header into the
 * two repo-relative paths, stripping the `a/` / `b/` prefixes and unquoting
 * git's C-quoted form. Returns null if two path tokens cannot be read.
 *
 * Handles:
 *   - unquoted: `a/path b/path` (no spaces inside either token)
 *   - C-quoted: `"a/pa th" "b/pa th"` and mixed (`a/x "b/pa th"`)
 */
function parseHeaderPaths(rest: string): { aPath: string; bPath: string } | null {
  const tokens = tokenizeTwoPaths(rest)
  if (tokens === null) return null
  return {
    aPath: stripSidePrefix(unquoteGitPath(tokens[0]), 'a/'),
    bPath: stripSidePrefix(unquoteGitPath(tokens[1]), 'b/'),
  }
}

/** Read exactly two whitespace- or quote-delimited tokens from `rest`. */
function tokenizeTwoPaths(rest: string): [string, string] | null {
  const tokens: string[] = []
  let i = 0
  while (i < rest.length && tokens.length < 2) {
    while (i < rest.length && rest[i] === ' ') i++
    if (i >= rest.length) break
    if (rest[i] === '"') {
      // Quoted token — consume to the matching unescaped closing quote.
      let j = i + 1
      while (j < rest.length) {
        if (rest[j] === '\\') {
          j += 2
          continue
        }
        if (rest[j] === '"') break
        j++
      }
      if (j >= rest.length) return null // unterminated quote
      tokens.push(rest.slice(i, j + 1))
      i = j + 1
    } else {
      // Bare token — consume to the next space.
      let j = i
      while (j < rest.length && rest[j] !== ' ') j++
      tokens.push(rest.slice(i, j))
      i = j
    }
  }
  return tokens.length === 2 ? [tokens[0], tokens[1]] : null
}

/** Strip a leading `a/` or `b/` (post-unquote). */
function stripSidePrefix(p: string, prefix: 'a/' | 'b/'): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p
}

/**
 * Unquote a git C-quoted path token. Handles the named escapes and octal
 * byte escapes git emits; the dominant real case (a space in the path) carries
 * no escapes at all, so this is mostly a quote-strip. Best-effort for exotic
 * byte sequences — the load-bearing win is that the header is recognised as a
 * boundary so the file is never silently absorbed into a neighbour's slice.
 */
function unquoteGitPath(token: string): string {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') {
    return token
  }
  const inner = token.slice(1, -1)
  if (!inner.includes('\\')) return inner
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      out += inner[i]
      continue
    }
    const next = inner[i + 1]
    if (next === undefined) {
      out += '\\'
      break
    }
    if (next >= '0' && next <= '7') {
      // Octal byte escape \NNN (1–3 octal digits).
      let oct = ''
      let k = i + 1
      while (k < inner.length && oct.length < 3 && inner[k] >= '0' && inner[k] <= '7') {
        oct += inner[k]
        k++
      }
      out += String.fromCharCode(parseInt(oct, 8))
      i = k - 1
      continue
    }
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'r':
        out += '\r'
        break
      case '"':
        out += '"'
        break
      case '\\':
        out += '\\'
        break
      default:
        out += next
    }
    i++
  }
  return out
}

function parseFileSlice(path: string, slice: string): ParsedFile {
  // Find every `@@ ` hunk-header start position INSIDE the slice. Hunk headers
  // always appear at column 0 — we use a line-start anchored regex with `m`
  // flag so the byte offsets it reports are usable for re-slicing.
  const hunkRegex = /^@@ /gm
  const hunkStarts: number[] = []
  let m: RegExpExecArray | null
  while ((m = hunkRegex.exec(slice)) !== null) {
    hunkStarts.push(m.index)
  }

  if (hunkStarts.length === 0) {
    // No hunks — e.g. binary marker, rename-only, mode-only diff. Whole slice
    // is preamble; the filter will keep it verbatim.
    return { path, rawSlice: slice, preamble: slice, hunks: [] }
  }

  const preamble = slice.slice(0, hunkStarts[0])
  const hunks: ParsedHunk[] = []
  for (let i = 0; i < hunkStarts.length; i++) {
    const start = hunkStarts[i]
    const end = i + 1 < hunkStarts.length ? hunkStarts[i + 1] : slice.length
    const hunkSlice = slice.slice(start, end)
    // Split the hunk into header line + body. The header line runs from `@@`
    // up to and including its trailing newline. If there's no newline (last
    // line of file, malformed), the entire hunkSlice is the header.
    const newlineIdx = hunkSlice.indexOf('\n')
    if (newlineIdx === -1) {
      hunks.push({ header: hunkSlice, body: '' })
    } else {
      hunks.push({
        header: hunkSlice.slice(0, newlineIdx + 1),
        body: hunkSlice.slice(newlineIdx + 1),
      })
    }
  }

  return { path, rawSlice: slice, preamble, hunks }
}

function emitFile(file: ParsedFile, keptHunks: ParsedHunk[]): string {
  // Fast path: every hunk kept → re-emit the original slice verbatim. This
  // guarantees byte-equality for files that were not touched at hunk level.
  if (keptHunks.length === file.hunks.length) {
    return file.rawSlice
  }
  if (keptHunks.length === 0) {
    return file.preamble
  }
  let out = file.preamble
  for (const hunk of keptHunks) {
    out += hunk.header + hunk.body
  }
  return out
}

// -- Path classification (hand-written, no globs) ----------------------------

function classifyPath(filePath: string): DropReason | null {
  if (isLockfile(filePath)) return 'lockfile'
  if (isGenerated(filePath)) return 'generated'
  if (isVendored(filePath)) return 'vendored'
  if (isFixture(filePath)) return 'fixture'
  return null
}

const LOCKFILE_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'go.sum',
  'composer.lock',
  'uv.lock',
])

function isLockfile(filePath: string): boolean {
  const base = basename(filePath).toLowerCase()
  return LOCKFILE_BASENAMES.has(base)
}

function isGenerated(filePath: string): boolean {
  const segments = filePath.split('/')
  // Directory-segment matches — `dist/` / `build/` anywhere in the path.
  for (const seg of segments) {
    if (seg === 'dist' || seg === 'build') return true
  }
  // Filename suffix matches.
  const base = basename(filePath)
  if (/\.(generated|gen)\.[a-zA-Z0-9]+$/.test(base)) return true
  if (/\.min\.(js|css)$/i.test(base)) return true
  // TanStack Router generated route-tree, sqlc/protoc output.
  if (base === 'routeTree.gen.ts') return true
  if (/^schema\.generated\.(ts|sql)$/.test(base)) return true
  return false
}

function isVendored(filePath: string): boolean {
  const segments = filePath.split('/')
  for (const seg of segments) {
    if (seg === 'vendor') return true
    if (seg === 'third_party') return true
    if (seg === 'node_modules') return true
    if (seg === '.pnpm') return true
  }
  return false
}

function isFixture(filePath: string): boolean {
  const segments = filePath.split('/')
  for (const seg of segments) {
    if (seg === '__fixtures__') return true
    if (seg === 'test-fixtures') return true
    // `__snapshots__/` is the canonical Jest/Vitest generated-snapshot dir —
    // always a test artefact, never source-of-truth docs.
    if (seg === '__snapshots__') return true
  }
  const base = basename(filePath)
  if (/\.snap$/.test(base)) return true
  if (/\.snapshot$/.test(base)) return true
  return false
}

function basename(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/')
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
}

// -- Hunk classification -----------------------------------------------------

function classifyHunk(hunk: ParsedHunk, filePath: string): DropReason | null {
  const lines = hunk.body.split('\n')
  const adds: string[] = []
  const dels: string[] = []
  for (const line of lines) {
    if (line.length === 0) continue
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) adds.push(line.slice(1))
    else if (line.startsWith('-')) dels.push(line.slice(1))
  }

  if (adds.length === 0 && dels.length === 0) {
    // Context-only hunk — no change at all. Should not appear in a real
    // unified diff but treat as kept (not noise) to be safe.
    return null
  }

  // Whitespace-only dropping is UNSAFE for indentation-significant languages:
  // a Python/YAML dedent (`-    return x` / `+return x`) trims-equal but
  // changes control flow / structure. Dropping it would lose real drift
  // signal (violating the epic's "no loss of recall" invariant), so we only
  // treat whitespace changes as noise in languages where indentation is
  // purely cosmetic (braces / explicit terminators).
  if (!isIndentationSensitive(filePath) && isWhitespaceOnly(adds, dels)) {
    return 'whitespace-only'
  }
  if (isImportOnly(adds, dels)) return 'import-only'
  return null
}

// Extensions / filenames where leading indentation is load-bearing. For these
// a "whitespace-only" hunk can still be a real semantic change, so it is never
// dropped. Conservative list — when unsure, keep the hunk.
const INDENTATION_SENSITIVE_EXTS = new Set([
  'py',
  'pyi',
  'yaml',
  'yml',
  'hs',
  'fs',
  'fsx',
  'nim',
  'coffee',
  'sass',
  'styl',
  'pug',
  'jade',
  'haml',
  'slim',
])

const INDENTATION_SENSITIVE_BASENAMES = new Set([
  'makefile',
  'gnumakefile',
])

function isIndentationSensitive(filePath: string): boolean {
  const base = basename(filePath).toLowerCase()
  if (INDENTATION_SENSITIVE_BASENAMES.has(base)) return true
  // `.mk` makefiles and `*.mk`-style fragments are also tab-significant.
  if (base.endsWith('.mk')) return true
  const dot = base.lastIndexOf('.')
  if (dot === -1) return false
  const ext = base.slice(dot + 1)
  return INDENTATION_SENSITIVE_EXTS.has(ext)
}

/**
 * A hunk is whitespace-only when, positionally paired, each `+` line and its
 * corresponding `-` line are equal after trimming leading/trailing whitespace.
 * Catches re-indentation, trailing-whitespace cleanup, CRLF/LF normalisation
 * — but explicitly NOT a pure re-ordering of non-whitespace content (which
 * has identical trimmed multisets but would survive an import-only classifier
 * downstream — the right place for it).
 */
function isWhitespaceOnly(adds: string[], dels: string[]): boolean {
  if (adds.length === 0 || dels.length === 0) return false
  if (adds.length !== dels.length) return false
  for (let i = 0; i < adds.length; i++) {
    if (adds[i].trim() !== dels[i].trim()) return false
  }
  return true
}

/**
 * A hunk is import-only when:
 *   1. every `+` and every `-` line is an ES (TS/JS) or Python import
 *      statement (so the hunk is ENTIRELY imports — a mixed hunk is kept), AND
 *   2. the multiset of NORMALISED import lines is identical on both sides —
 *      i.e. the change is a pure re-ordering of the same import statements.
 *
 * Comparing the normalised LINES (not just the source paths) is what keeps a
 * genuine binding change from being dropped: `import { foo } from './a'` →
 * `import { foo, bar } from './a'` shares the source `./a` but the lines
 * differ, so it is NOT import-only and is retained (it adds a real
 * dependency on `bar` that could contradict docs).
 */
function isImportOnly(adds: string[], dels: string[]): boolean {
  if (adds.length === 0 || dels.length === 0) return false
  const addNorm = normaliseImportLines(adds)
  if (addNorm === null) return false
  const delNorm = normaliseImportLines(dels)
  if (delNorm === null) return false
  if (addNorm.length !== delNorm.length) return false
  return multisetsEqual(addNorm, delNorm)
}

/**
 * Returns the normalised text of every line (leading whitespace + trailing
 * `;` stripped) when EVERY non-empty line is an import statement; null if any
 * line is not an import.
 */
function normaliseImportLines(lines: string[]): string[] | null {
  const out: string[] = []
  for (const raw of lines) {
    const trimmed = raw.replace(/^\s+/, '').replace(/;\s*$/, '')
    if (trimmed.length === 0) continue
    if (extractImportSource(trimmed) === null) return null
    out.push(trimmed)
  }
  return out
}

function multisetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const counts = new Map<string, number>()
  for (const s of a) counts.set(s, (counts.get(s) ?? 0) + 1)
  for (const s of b) {
    const c = counts.get(s)
    if (c === undefined) return false
    if (c === 1) counts.delete(s)
    else counts.set(s, c - 1)
  }
  return counts.size === 0
}

function extractImportSource(line: string): string | null {
  // ES import: `import ... from 'x'` or `import 'x'` or `import type ... from 'x'`.
  const esFrom = /^import\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/
  const esMatch = esFrom.exec(line)
  if (esMatch !== null) return esMatch[1]
  // Python: `from X import Y` or `from X.Y import Z` or `import X` / `import X as Y`.
  const pyFromImport = /^from\s+(\S+)\s+import\s+/
  const pyMatch = pyFromImport.exec(line)
  if (pyMatch !== null) return pyMatch[1]
  const pyImport = /^import\s+(\S+)(?:\s+as\s+\S+)?\s*$/
  const pyImportMatch = pyImport.exec(line)
  if (pyImportMatch !== null) return pyImportMatch[1]
  return null
}

// -- File-wide hunk-drop promotion ------------------------------------------

function mostCommonHunkReason(droppedHunks: DroppedHunk[]): DropReason {
  // Deterministic tie-break: first reason encountered wins on equal counts.
  const counts = new Map<DropReason, number>()
  const firstSeen = new Map<DropReason, number>()
  for (let i = 0; i < droppedHunks.length; i++) {
    const r = droppedHunks[i].reason
    counts.set(r, (counts.get(r) ?? 0) + 1)
    if (!firstSeen.has(r)) firstSeen.set(r, i)
  }
  let bestReason: DropReason = droppedHunks[0].reason
  let bestCount = -1
  let bestFirstSeen = Number.POSITIVE_INFINITY
  for (const [reason, count] of counts) {
    const seen = firstSeen.get(reason) ?? 0
    if (count > bestCount || (count === bestCount && seen < bestFirstSeen)) {
      bestReason = reason
      bestCount = count
      bestFirstSeen = seen
    }
  }
  return bestReason
}
