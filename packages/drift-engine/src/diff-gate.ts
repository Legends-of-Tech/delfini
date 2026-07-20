// packages/drift-engine/src/diff-gate.ts
//
// Always-on diff-side relevance gating (design + spec:
// docs/ideas/token-diet-symmetric-retrieval.md). The doc side has had
// default-on retrieval since NFR49; the diff side only ever shrank in the
// over-budget `planPrompts` path. This module is the symmetric completion:
// route every hunk to the retained doc sections with the SAME scorer the
// planner uses, drop hunks linked to no section, and trim context on weakly
// linked ones — BEFORE prompt assembly, at any prompt size.
//
// Pure-logic — no I/O, no LLM, no env, no new runtime dep (FR139). Like
// `filterDiff` (FR151) and `planPrompts`, the gate lives at the CONSUMER call
// sites (CLI `runLocalPrepare`, Action `SingleCallOrchestrator`): the default
// `buildPrompt` path never calls it, so the NFR44 snapshot gates stay
// byte-identical and the default flip happens only at the consumer layer
// (NFR49(b) parity discipline).
//
// The recall bet this module makes is the one `planPrompts` already made for
// over-budget runs — a hunk that contradicts a section while sharing no
// identifiers/paths with it is invisible to the scorer and gets dropped. The
// bet is now pinned by a labelled fixture
// (`__tests__/fixtures/lexically-invisible/`) instead of remaining unmeasured,
// and every drop is REPORTED (never silent) so consumers can surface it.

import type { DocFile } from './types.js'
import {
  scoreSectionAgainstHunk,
  selectRelevantSections,
  type DocSection,
} from './relevance.js'
import { parseDiffHunks, renderHunksAsDiff, type DiffHunk } from './diff-hunks.js'

export interface DiffGateOptions {
  /**
   * Defines the retained-section universe hunks are scored against — the same
   * signal as `BuildPromptOptions.relevanceThreshold` / the planner's
   * `relevanceThreshold`. Must be positive; otherwise there is no routing
   * signal and the gate stands down (`no-threshold`).
   */
  sectionThreshold: number
  /**
   * Per-hunk keep bar: a hunk is kept when its max score against any retained
   * section is at/above this (or a structural keep reason applies). `<= 0`
   * disables the gate — the consumer-facing escape hatch
   * (`--diff-keep-threshold 0`).
   */
  keepThreshold: number
  /**
   * Hunks scoring at/above `keepThreshold * strongMultiplier` keep their full
   * context (they are the likely finding carriers); weaker linked hunks get
   * the context trim. Default 4 — at the canonical thresholds (5/5) that is
   * 20, aligned with the Tier-1 `docPathInDiff` weight and just below the
   * true-link scores observed in the multi-prompt routing spike (25–40).
   */
  strongMultiplier?: number
  /** Context lines kept on each side of a weak hunk's changes. Default 1. */
  contextRadius?: number
}

export type GateKeepReason =
  | 'linked-strong'
  | 'linked-weak'
  | 'doc-in-scope'
  | 'new-file'
  | 'dependency-manifest'

export type GateInactiveReason =
  | 'no-threshold'
  | 'no-docs'
  | 'no-hunks'
  | 'no-sections'
  | 'all-dropped'

export interface DroppedGateHunk {
  filePath: string
  /** The `@@ … @@` header line, trimmed — same identity `hunkKey` uses. */
  hunkHeader: string
  /** The hunk's best score against any retained section (what fell short). */
  maxScore: number
}

export interface DiffGateResult {
  /** The gated diff. `=== diff` verbatim whenever `active` is false. */
  keptDiff: string
  /**
   * `false` → the gate stood down and `keptDiff` is the input diff untouched
   * (see `inactiveReason`). Consumers MUST key their reporting/trace on this,
   * not on `droppedHunks.length` — the `all-dropped` stand-down carries a
   * populated `droppedHunks` record describing the decision it declined to
   * apply.
   */
  active: boolean
  inactiveReason?: GateInactiveReason
  /** Kept-hunk counts by keep reason (all zero when the gate is inactive). */
  keptByReason: Record<GateKeepReason, number>
  droppedHunks: DroppedGateHunk[]
  /** Number of weak hunks whose context was actually trimmed. */
  trimmedHunkCount: number
  /** Total context lines removed across all trimmed hunks. */
  contextLinesRemoved: number
}

const DEFAULT_STRONG_MULTIPLIER = 4
const DEFAULT_CONTEXT_RADIUS = 1

// Structural keep-list: dependency manifests are where additive findings
// (FR88 `additions[]` — e.g. a new runtime dependency with a natural doc home)
// originate even when they share no identifier with any section. Deliberately
// small and basename-exact; lockfiles are NOT here (they are analysis noise —
// `filterDiff`'s builtins drop them when enabled).
const DEPENDENCY_MANIFEST_BASENAMES = new Set([
  'package.json',
  'deno.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
])

/**
 * Gate a unified diff by per-hunk relevance to the retained doc sections.
 *
 * Decision order per hunk (first match wins):
 *   1. `doc-in-scope`        — the hunk edits an in-scope doc. The prompt
 *      contract requires doc edits visible in the diff (the model evaluates
 *      the post-PR doc text WITH its edits in view), so these are
 *      unconditional keeps.
 *   2. `new-file`            — brand-new files are where additive findings
 *      live (a new module lexically matches no existing section).
 *   3. `dependency-manifest` — see `DEPENDENCY_MANIFEST_BASENAMES`.
 *   4. `linked-strong`       — full context retained.
 *   5. `linked-weak`         — kept with leading/trailing context trimmed to
 *      `contextRadius` (interior context runs untouched — v1 never splits a
 *      hunk; changed lines are never trimmed).
 *   6. otherwise dropped     — reported in `droppedHunks`, never silent.
 *
 * The gate NEVER produces an empty diff: if the decision would keep zero
 * hunks it stands down (`inactiveReason: 'all-dropped'`) and returns the
 * input verbatim — mirroring `planPrompts`' degenerate-case safety. Identical
 * input → identical output (no clock, no randomness).
 */
export function gateDiffByRelevance(
  diff: string,
  docs: DocFile[],
  options: DiffGateOptions,
): DiffGateResult {
  const strongMultiplier = options.strongMultiplier ?? DEFAULT_STRONG_MULTIPLIER
  const contextRadius = options.contextRadius ?? DEFAULT_CONTEXT_RADIUS

  if (
    !(Number.isFinite(options.keepThreshold) && options.keepThreshold > 0) ||
    !(Number.isFinite(options.sectionThreshold) && options.sectionThreshold > 0)
  ) {
    return inactiveResult(diff, 'no-threshold')
  }
  if (docs.length === 0) return inactiveResult(diff, 'no-docs')

  const hunks = parseDiffHunks(diff)
  if (hunks.length === 0) return inactiveResult(diff, 'no-hunks')

  // Retained-section universe, scored against the FULL pre-gate diff — the
  // same universe `planPrompts` routes against, so gate and planner agree.
  const universe: { doc: DocFile; section: DocSection }[] = []
  for (const doc of docs) {
    const { kept } = selectRelevantSections(doc, diff, options.sectionThreshold)
    for (const section of kept) universe.push({ doc, section })
  }
  if (universe.length === 0) return inactiveResult(diff, 'no-sections')

  const docPaths = new Set(docs.map((d) => d.path))
  const keptByReason = emptyReasonCounts()
  const droppedHunks: DroppedGateHunk[] = []
  const keptHunks: DiffHunk[] = []
  let trimmedHunkCount = 0
  let contextLinesRemoved = 0

  for (const hunk of hunks) {
    // Structural keeps skip scoring entirely — their retention does not
    // depend on lexical linkage, and skipping the O(sections) scan keeps the
    // gate cheap on large diffs.
    const structural = structuralKeepReason(hunk, docPaths)
    if (structural !== null) {
      keptByReason[structural] += 1
      keptHunks.push(hunk)
      continue
    }

    let maxScore = 0
    for (const { doc, section } of universe) {
      const score = scoreSectionAgainstHunk(doc, section, hunk)
      if (score > maxScore) maxScore = score
    }

    if (maxScore >= options.keepThreshold * strongMultiplier) {
      keptByReason['linked-strong'] += 1
      keptHunks.push(hunk)
    } else if (maxScore >= options.keepThreshold) {
      keptByReason['linked-weak'] += 1
      const trimmed = trimHunkContext(hunk, contextRadius)
      if (trimmed.removed > 0) {
        trimmedHunkCount += 1
        contextLinesRemoved += trimmed.removed
      }
      keptHunks.push(trimmed.hunk)
    } else {
      droppedHunks.push({
        filePath: hunk.filePath,
        hunkHeader: hunk.header.trim(),
        maxScore,
      })
    }
  }

  // Never emit an empty diff — an all-dropped decision means the scorer found
  // nothing relevant, and standing down (analysing the original diff) is the
  // recall-preserving choice. The drop record is still returned so a caller
  // can see WHY the gate stood down.
  if (keptHunks.length === 0) {
    return { ...inactiveResult(diff, 'all-dropped'), droppedHunks }
  }

  return {
    keptDiff: renderHunksAsDiff(keptHunks),
    active: true,
    keptByReason,
    droppedHunks,
    trimmedHunkCount,
    contextLinesRemoved,
  }
}

function inactiveResult(diff: string, reason: GateInactiveReason): DiffGateResult {
  return {
    keptDiff: diff,
    active: false,
    inactiveReason: reason,
    keptByReason: emptyReasonCounts(),
    droppedHunks: [],
    trimmedHunkCount: 0,
    contextLinesRemoved: 0,
  }
}

function emptyReasonCounts(): Record<GateKeepReason, number> {
  return {
    'linked-strong': 0,
    'linked-weak': 0,
    'doc-in-scope': 0,
    'new-file': 0,
    'dependency-manifest': 0,
  }
}

function structuralKeepReason(
  hunk: DiffHunk,
  docPaths: Set<string>,
): GateKeepReason | null {
  if (docPaths.has(hunk.filePath)) return 'doc-in-scope'
  // `new file mode …` marks tracked new files; `--- /dev/null` covers the
  // `git diff --no-index` rendering of untracked files (FR141a) — both mean
  // "brand-new file", the primary home of additive findings.
  if (/^new file mode /m.test(hunk.fileHeader) || /^--- \/dev\/null/m.test(hunk.fileHeader)) {
    return 'new-file'
  }
  if (DEPENDENCY_MANIFEST_BASENAMES.has(basename(hunk.filePath))) {
    return 'dependency-manifest'
  }
  return null
}

function basename(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] ?? filePath
}

// --- Context trimming --------------------------------------------------------

// `@@ -oldStart[,oldCount] +newStart[,newCount] @@ trailing`. Counts default
// to 1 when omitted (unified-diff spec).
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

interface TrimHunkResult {
  hunk: DiffHunk
  /** Context lines removed (0 → `hunk` is the input object, untouched). */
  removed: number
}

// Trim a weak hunk's LEADING and TRAILING context lines down to `radius`,
// recomputing the `@@` header so the emitted diff stays self-consistent
// (parseable by `parseDiffHunks` / the planner downstream). Invariants:
//   - changed (`+`/`-`) lines are never touched;
//   - interior context runs are never touched (trimming one would break the
//     hunk's line contiguity — splitting into sub-hunks is out of scope v1);
//   - a trailing `\ No newline at end of file` marker pins the hunk's tail:
//     the marker annotates the hunk's LAST line, and every line before it
//     must stay contiguous, so no trailing trim happens at all in that case;
//   - a hunk with no changed lines (defensive) or an unparseable header is
//     returned untouched.
function trimHunkContext(hunk: DiffHunk, radius: number): TrimHunkResult {
  const headerMatch = HUNK_HEADER.exec(hunk.header.replace(/\r?\n$/, ''))
  if (headerMatch === null) return { hunk, removed: 0 }

  const hadTrailingNewline = hunk.body.endsWith('\n')
  const rawLines = hunk.body.split('\n')
  // A trailing '\n' yields a final '' element that is an artefact of the
  // split, not a body line — strip it for processing, restore on re-join.
  if (hadTrailingNewline) rawLines.pop()
  if (rawLines.length === 0) return { hunk, removed: 0 }

  const isChanged = (line: string): boolean =>
    line.startsWith('+') || line.startsWith('-')

  let firstChanged = -1
  let lastChanged = -1
  rawLines.forEach((line, i) => {
    if (isChanged(line)) {
      if (firstChanged === -1) firstChanged = i
      lastChanged = i
    }
  })
  if (firstChanged === -1) return { hunk, removed: 0 }

  // Leading context: everything before the first changed line. Keep the
  // `radius` lines adjacent to the change; drop the rest from the front.
  const droppedLead = Math.max(0, firstChanged - radius)

  // Trailing context: everything after the last changed line. A `\` marker as
  // the final line pins the tail (contiguity) — no trailing trim then.
  const tail = rawLines.slice(lastChanged + 1)
  const tailPinned = tail.length > 0 && tail[tail.length - 1].startsWith('\\')
  const droppedTail = tailPinned ? 0 : Math.max(0, tail.length - radius)

  const removed = droppedLead + droppedTail
  if (removed === 0) return { hunk, removed: 0 }

  const keptLines = rawLines.slice(droppedLead, rawLines.length - droppedTail)

  // Header arithmetic: leading context advances both sides' start; context
  // lines count on both sides, so both counts shrink by the full trim.
  const oldStart = Number.parseInt(headerMatch[1], 10) + droppedLead
  const oldCount = (headerMatch[2] === undefined ? 1 : Number.parseInt(headerMatch[2], 10)) - removed
  const newStart = Number.parseInt(headerMatch[3], 10) + droppedLead
  const newCount = (headerMatch[4] === undefined ? 1 : Number.parseInt(headerMatch[4], 10)) - removed
  const trailing = headerMatch[5]
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${trailing}\n`

  const body = keptLines.join('\n') + (hadTrailingNewline ? '\n' : '')
  return {
    hunk: { filePath: hunk.filePath, fileHeader: hunk.fileHeader, header, body },
    removed,
  }
}
