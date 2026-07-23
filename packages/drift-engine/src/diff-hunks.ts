// packages/drift-engine/src/diff-hunks.ts
//
// Hunk-granularity unified-diff parsing + re-emission, for the multi-prompt
// planner (`prompt-planner.ts`). Pure-logic — no I/O, no clock, no new runtime
// dep; same charter as the rest of drift-engine (FR139).
//
// `diff-filter.ts` already parses a diff into files-then-hunks, but it keeps
// that parser PRIVATE and is shaped around byte-fidelity FILTERING (re-emitting
// a valid diff with noise removed). The planner needs a different cut: a flat
// list of hunks each tagged with its file's header, so it can (a) score each
// hunk against doc sections independently and (b) regroup an arbitrary SUBSET of
// hunks back into a valid sub-diff for one chunk. Rather than widen
// diff-filter's tested surface, this is a focused sibling parser. The two are
// deliberately independent: diff-filter guarantees byte-identical passthrough
// (it has snapshot-grade tests); this one only needs to preserve enough for
// scoring + chunk rendering, so it stays small.

/** One hunk of a unified diff, tagged with its file's identifying header. */
export interface DiffHunk {
  /** Repo-relative path (the `b/` side, or `a/` for deletions). */
  filePath: string
  /**
   * Everything from the file's `diff --git` line up to (not including) its first
   * `@@` hunk header — i.e. the `diff --git` / `index` / `--- ` / `+++ ` lines.
   * Re-emitted verbatim when this hunk is rendered back into a sub-diff so the
   * file path survives for the relevance scorer's file-overlap tier.
   */
  fileHeader: string
  /** The `@@ -a,b +c,d @@ …\n` header line (trailing newline included). */
  header: string
  /** Body bytes after the header up to the next hunk / next file / EOF. */
  body: string
}

// Boundary anchors. Both are line-start anchored (`m` flag) so the reported
// offsets are usable for re-slicing. `diff --git ` opens each file; `@@ ` opens
// each hunk (hunk headers always sit at column 0 in git's output).
const FILE_BOUNDARY = /^diff --git /gm
const HUNK_BOUNDARY = /^@@ /gm

/**
 * Parse a unified-diff string into a flat, file-tagged hunk list.
 *
 * Files with no `@@` hunk (binary markers, pure rename/mode-only diffs) yield
 * zero hunks — they carry no line-level change text to route, so the planner
 * simply has nothing to place for them. This is a deliberate v1 limitation: a
 * rename-only change that contradicts a doc is invisible to hunk routing (it is
 * equally invisible to today's relevance scorer, which keys on hunk identifiers).
 *
 * Identical input → identical output (no clock / randomness).
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  if (diff.length === 0) return []

  // 1. File boundaries.
  const fileStarts: number[] = []
  let fm: RegExpExecArray | null
  FILE_BOUNDARY.lastIndex = 0
  while ((fm = FILE_BOUNDARY.exec(diff)) !== null) fileStarts.push(fm.index)
  if (fileStarts.length === 0) return []

  const hunks: DiffHunk[] = []
  for (let i = 0; i < fileStarts.length; i++) {
    const start = fileStarts[i]
    const end = i + 1 < fileStarts.length ? fileStarts[i + 1] : diff.length
    const slice = diff.slice(start, end)
    const filePath = extractFilePath(slice)

    // 2. Hunk boundaries within this file slice.
    const hunkStarts: number[] = []
    let hm: RegExpExecArray | null
    HUNK_BOUNDARY.lastIndex = 0
    while ((hm = HUNK_BOUNDARY.exec(slice)) !== null) hunkStarts.push(hm.index)
    if (hunkStarts.length === 0) continue // no line-level change to route

    const fileHeader = slice.slice(0, hunkStarts[0])
    for (let j = 0; j < hunkStarts.length; j++) {
      const hStart = hunkStarts[j]
      const hEnd = j + 1 < hunkStarts.length ? hunkStarts[j + 1] : slice.length
      const hunkText = slice.slice(hStart, hEnd)
      const nl = hunkText.indexOf('\n')
      hunks.push({
        filePath,
        fileHeader,
        header: nl === -1 ? hunkText : hunkText.slice(0, nl + 1),
        body: nl === -1 ? '' : hunkText.slice(nl + 1),
      })
    }
  }
  return hunks
}

/**
 * Re-emit a SUBSET of hunks as a valid unified diff: hunks are grouped by file
 * in first-seen order, each file's `fileHeader` emitted once followed by its
 * selected hunks in input order. The result is parseable by the relevance
 * scorer (file paths + identifiers intact) and by `buildPrompt` (which splices
 * it whole into `{{diff}}`).
 *
 * Stable: same hunk list → same string. Empty list → empty string.
 */
export function renderHunksAsDiff(hunks: DiffHunk[]): string {
  if (hunks.length === 0) return ''
  // Group by file path, preserving first-seen order of both files and hunks.
  const order: string[] = []
  const byFile = new Map<string, { fileHeader: string; bodies: string[] }>()
  for (const h of hunks) {
    let entry = byFile.get(h.filePath)
    if (entry === undefined) {
      entry = { fileHeader: h.fileHeader, bodies: [] }
      byFile.set(h.filePath, entry)
      order.push(h.filePath)
    }
    entry.bodies.push(h.header + h.body)
  }
  let out = ''
  for (const path of order) {
    const entry = byFile.get(path)!
    out += entry.fileHeader + entry.bodies.join('')
  }
  return out
}

/** A stable identity for a hunk (file + header line), for dedup/set membership. */
export function hunkKey(h: DiffHunk): string {
  return `${h.filePath}\u0000${h.header.trim()}`
}

// Extract the repo-relative path from a single file's diff slice. Prefer the
// `+++ b/<path>` line (the post-change path; correct for renames + additions),
// fall back to `--- a/<path>` (deletions, where the `+++` side is /dev/null),
// and finally to the `diff --git a/<p> b/<p>` header. `/dev/null` is never
// returned as a path — the opposite side is used.
function extractFilePath(slice: string): string {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(slice)
  if (plus && plus[1] !== '/dev/null') return plus[1].replace(/\r$/, '')
  const minus = /^--- a\/(.+)$/m.exec(slice)
  if (minus && minus[1] !== '/dev/null') return minus[1].replace(/\r$/, '')
  const git = /^diff --git a\/(\S+) b\/(\S+)/m.exec(slice)
  if (git) return git[2] !== '/dev/null' ? git[2] : git[1]
  return '(unknown)'
}
