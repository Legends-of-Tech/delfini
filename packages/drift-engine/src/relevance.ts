// packages/drift-engine/src/relevance.ts
//
// Doc-relevance scoring + selection. Pure-logic — no I/O, no clock, no
// randomness. Consumed by `buildPrompt` when `BuildPromptOptions.relevanceThreshold`
// is set; bypassed entirely at default (NFR44 parity preserved).
//
// Internal helper — not exposed via `index.ts`. Tests reach it via the
// relative `../src/relevance.js` import, same convention as `reconcile`
// internal helpers.

import type { DocFile } from './types.js'

export interface DocRelevanceScore {
  path: string
  score: number
  breakdown: {
    docPathInDiff: number
    fileOverlap: number
    identifierOverlap: number
    headingOverlap: number
  }
}

export interface SelectRelevantDocsResult {
  kept: DocFile[]
  dropped: DocRelevanceScore[]
}

export function scoreDocRelevance(doc: DocFile, diff: string): DocRelevanceScore {
  const diffFilePaths = extractDiffFilePaths(diff)
  const diffIdentifiers = extractIdentifiers(diff)
  const breakdown = {
    docPathInDiff: scoreDocPathInDiff(doc.path, diff),
    fileOverlap: scoreFileOverlap(doc.content, diffFilePaths),
    identifierOverlap: scoreIdentifierOverlap(doc.content, diffIdentifiers),
    headingOverlap: scoreHeadingOverlap(doc.content, diffIdentifiers),
  }
  const score =
    breakdown.docPathInDiff +
    breakdown.fileOverlap +
    breakdown.identifierOverlap +
    breakdown.headingOverlap
  return { path: doc.path, score, breakdown }
}

function scoreHeadingOverlap(docContent: string, diffIdentifiers: Set<string>): number {
  let score = 0
  const lines = docContent.split(/\r?\n/)
  for (const line of lines) {
    if (!/^#{1,6}\s+/.test(line)) continue
    const headingIdents = extractIdentifiers(line)
    for (const ident of headingIdents) {
      if (diffIdentifiers.has(ident)) {
        score += 5
        break // count each heading at most once
      }
    }
  }
  return score
}

function scoreDocPathInDiff(docPath: string, diff: string): number {
  // `diff --git a/<path> b/<path>` is the canonical header. Match either side.
  const escaped = docPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`diff --git [ab]/${escaped} `, 'm')
  return pattern.test(diff) ? 20 : 0
}

// Extracts file paths from `diff --git a/<path> b/<path>` headers where both
// sides match. Known limitations (deliberate scope for Tier 2):
//   - Renames are NOT extracted (`a/old.ts b/new.ts` — sides differ)
//   - Binary-file headers ARE matched on the diff line (harmless — binary
//     paths rarely appear verbatim in .md docs)
//   - Paths containing whitespace (quoted in git's diff format) are truncated
//     at the first space; out of scope for Tier 2
function extractDiffFilePaths(diff: string): Set<string> {
  const paths = new Set<string>()
  const pattern = /^diff --git a\/(\S+) b\/\1/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(diff)) !== null) {
    paths.add(match[1])
  }
  return paths
}

// Common keywords we filter out to avoid false positives. Not an exhaustive
// list — just the highest-frequency offenders. The 3-char minimum already
// drops `if`, `do`, `or`, `is`, etc.
const COMMON_KEYWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'have',
  'has', 'are', 'was', 'were', 'will', 'can', 'not', 'but', 'all', 'any',
  'one', 'two', 'use', 'add', 'get', 'set', 'put', 'new', 'old', 'now',
  'let', 'var', 'const', 'function', 'return', 'import', 'export',
  'true', 'false', 'null', 'undefined', 'void', 'string', 'number',
  'boolean', 'object', 'array', 'type', 'interface',
])

function extractIdentifiers(text: string): Set<string> {
  // Match camelCase / PascalCase / snake_case / kebab-case tokens of length 3+.
  // The character class includes `-`, so kebab tokens like `some-token` are
  // captured whole (one identifier, not two). The token must START with a
  // letter or underscore — a leading `-` is rejected (so `-flag` is not an
  // identifier; the `-` is a boundary on the front but not in the middle).
  const pattern = /[a-zA-Z_][a-zA-Z0-9_-]{2,}/g
  const out = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0]
    if (!COMMON_KEYWORDS.has(token.toLowerCase())) {
      out.add(token)
    }
  }
  return out
}

function scoreIdentifierOverlap(docContent: string, diffIdentifiers: Set<string>): number {
  let count = 0
  // Substring match is intentional here (unlike `scoreFileOverlap` which is
  // boundary-aware). A doc mentioning `processPayment` is plausibly relevant
  // to a change touching `process`. The +30 cap bounds noise from this.
  for (const ident of diffIdentifiers) {
    if (docContent.includes(ident)) {
      count += 1
    }
  }
  return Math.min(count * 3, 30)
}

function scoreFileOverlap(docContent: string, diffFilePaths: Set<string>): number {
  let score = 0
  for (const filePath of diffFilePaths) {
    const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Boundary check: filePath must not be immediately followed by a word
    // character, `/`, `-`, or a `.` that itself continues into another word
    // character (extension continuation like `.map`). This prevents
    // `src/pay.ts` from spuriously matching `src/pay.ts.map`,
    // `src/payments`, or `src/pay.ts-old`, while still matching
    // `src/auth.ts.` at sentence end (period is not followed by `\w`).
    const pattern = new RegExp(`${escaped}(?![\\w/-])(?!\\.\\w)`)
    if (pattern.test(docContent)) {
      score += 10
    }
  }
  return score
}

// --- Section-granularity retrieval (FR150) ----------------------------------
//
// Section granularity is a STRICT REFINEMENT of whole-document scoring: a doc
// with no heading (or one leading section) is a single section whose score
// equals its whole-document score, so the section path reduces exactly to the
// whole-doc path for that doc. This is what keeps the default `buildPrompt`
// output byte-identical (the threshold-off fast-path keeps every section) and
// the existing single-section relevance tests green without change.

// A heading-delimited slice of a doc body. `startLineIndex` is the 0-indexed
// offset of this section's first line within `DocFile.content` (split on `\n`),
// so the renderer can recover the section's ABSOLUTE original-file line number
// as `frontMatterLineCount + startLineIndex + 1`.
export interface DocSection {
  lines: string[]
  startLineIndex: number
}

export interface DroppedSection {
  startLineIndex: number
  score: number
  /**
   * Set by `rankedFillSections` (Story P3.7.3) when the dropped record is
   * cross-doc (ranked-fill operates over a flat candidate list from any
   * number of docs). `selectRelevantSections` operates per-doc and leaves
   * this undefined — its caller already knows which doc the section came
   * from.
   */
  docPath?: string
}

export interface SelectRelevantSectionsResult {
  kept: DocSection[]
  dropped: DroppedSection[]
}

// Split a doc body into heading-delimited sections. Splitting on the single
// char `\n` (not `/\r?\n/`) is lossless — `sections.flatMap(s => s.lines)
// .join('\n')` reconstructs `content` byte-for-byte (a CRLF line keeps its
// trailing `\r` as the last char of its line element). Content before the
// first heading is a leading section; an all-body doc is one leading section;
// empty content is one empty section. Nothing is dropped on the floor.
export function splitIntoSections(content: string): DocSection[] {
  const lines = content.split('\n')
  const sections: DocSection[] = []
  let current: DocSection | null = null
  lines.forEach((line, i) => {
    if (/^#{1,6}\s+/.test(line)) {
      if (current) sections.push(current)
      current = { lines: [line], startLineIndex: i }
    } else {
      if (!current) current = { lines: [], startLineIndex: i }
      current.lines.push(line)
    }
  })
  if (current) sections.push(current)
  return sections
}

/**
 * Select the heading-delimited sections of a single doc whose relevance score
 * is at/above `threshold`. Mirrors `selectRelevantDocs`:
 *   - inclusive lower bound (`score >= threshold` keeps the section)
 *   - `threshold <= 0` / non-finite → keep every section (no-op fast-path)
 *
 * Each section reuses the same four signals as `scoreDocRelevance`, applied to
 * the section content — EXCEPT `docPathInDiff`, which is a whole-document
 * property (the doc itself was edited in the diff). It is computed once per doc
 * and added to every section's score, so a doc that appears in the diff header
 * is retained whole.
 */
export function selectRelevantSections(
  doc: DocFile,
  diff: string,
  threshold: number,
): SelectRelevantSectionsResult {
  const sections = splitIntoSections(doc.content)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { kept: sections, dropped: [] }
  }
  const diffFilePaths = extractDiffFilePaths(diff)
  const diffIdentifiers = extractIdentifiers(diff)
  const docPathScore = scoreDocPathInDiff(doc.path, diff)
  const kept: DocSection[] = []
  const dropped: DroppedSection[] = []
  for (const section of sections) {
    const sectionContent = section.lines.join('\n')
    const score =
      docPathScore +
      scoreFileOverlap(sectionContent, diffFilePaths) +
      scoreIdentifierOverlap(sectionContent, diffIdentifiers) +
      scoreHeadingOverlap(sectionContent, diffIdentifiers)
    if (score >= threshold) {
      kept.push(section)
    } else {
      dropped.push({ startLineIndex: section.startLineIndex, score })
    }
  }
  return { kept, dropped }
}

// --- Ranked-fill prompt budget (FR152, Story P3.7.3) ------------------------
//
// Cross-doc ranked-fill: given scored heading-delimited section candidates
// from any number of docs, return the prefix that fits within `budgetTokens`
// when ranked most-relevant-first. Used by `buildPromptWithDrops` when both
// `relevanceThreshold > 0` and `promptTokenBudget > 0` are supplied — the
// caller pre-scores each section (via `selectRelevantSections`) and passes a
// `measure` closure that knows the render cost per candidate.
//
// Determinism: sort is by `score` DESC, tie-break `(docPath ASC, startLineIndex
// ASC)` — total order, platform-independent, no `Array.prototype.sort` engine
// ambiguity. The fill is greedy: a candidate is included iff including it keeps
// the running cumulative cost at-or-below the budget. Candidates beyond the
// first one that would exceed the budget are placed in `dropped` in their
// ORIGINAL input order (so a report can list "dropped sections by doc/line"
// predictably). The input array is NOT mutated — the sort runs on a copy.

export interface RankedFillCandidate {
  doc: DocFile
  section: DocSection
  score: number
}

export interface RankedFillResult {
  included: RankedFillCandidate[]
  dropped: RankedFillCandidate[]
}

export function rankedFillSections(
  candidates: RankedFillCandidate[],
  budgetTokens: number,
  measure: (candidate: RankedFillCandidate) => number,
): RankedFillResult {
  // Non-positive / non-finite budget → no constraint expressed; include
  // everything (matches the threshold fast-path semantics elsewhere in this
  // module). A budget of 0 means "include nothing fits at non-zero cost" but
  // we still apply the inclusion rule per-candidate, so a measure() returning
  // 0 for every candidate would still keep them all — deliberate.
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return { included: [...candidates], dropped: [] }
  }

  // Tag with original index so we can restore input order on the dropped side.
  const indexed = candidates.map((candidate, originalIndex) => ({
    candidate,
    originalIndex,
  }))

  // Stable, deterministic ranking. Score DESC, then docPath ASC, then
  // startLineIndex ASC. Equal-score sections from the same doc sort by line.
  //
  // Path comparison is CODEPOINT-based (`<` / `>`), NOT `localeCompare`:
  // `localeCompare` with no locale argument uses the host's default ICU
  // collation, so identical inputs could rank differently across machines
  // (different `LANG` / ICU build) — a determinism violation in a pure-logic
  // engine whose charter (NFR44) is byte-for-byte reproducibility.
  const ranked = [...indexed].sort((a, b) => {
    if (b.candidate.score !== a.candidate.score) {
      return b.candidate.score - a.candidate.score
    }
    const pa = a.candidate.doc.path
    const pb = b.candidate.doc.path
    if (pa !== pb) return pa < pb ? -1 : 1
    return a.candidate.section.startLineIndex - b.candidate.section.startLineIndex
  })

  const includedFlags = new Array(candidates.length).fill(false) as boolean[]
  let runningTokens = 0
  for (const entry of ranked) {
    const cost = measure(entry.candidate)
    if (runningTokens + cost <= budgetTokens) {
      runningTokens += cost
      includedFlags[entry.originalIndex] = true
    }
    // Else: skip this candidate. Do NOT break — a smaller later candidate
    // may still fit ("first-fit decreasing"-style packing). Deterministic
    // and a strict improvement over "stop at first overflow."
  }

  const included: RankedFillCandidate[] = []
  const dropped: RankedFillCandidate[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (includedFlags[i]) {
      included.push(candidates[i])
    } else {
      dropped.push(candidates[i])
    }
  }
  return { included, dropped }
}

/**
 * Filter docs by relevance score against the diff. Docs with
 * `score >= threshold` are kept; docs below are dropped.
 *
 * The threshold is INCLUSIVE on the lower bound — a doc scoring exactly the
 * threshold value is kept, not dropped.
 *
 * Fast-path: `threshold <= 0` or non-finite (NaN, Infinity) returns every
 * doc in `kept` with `dropped` empty. This makes the function observably
 * no-op for the default `buildPrompt` call path (NFR44 parity).
 */
export function selectRelevantDocs(
  docs: DocFile[],
  diff: string,
  threshold: number,
): SelectRelevantDocsResult {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { kept: [...docs], dropped: [] }
  }
  const kept: DocFile[] = []
  const dropped: DocRelevanceScore[] = []
  for (const doc of docs) {
    const scored = scoreDocRelevance(doc, diff)
    if (scored.score >= threshold) {
      kept.push(doc)
    } else {
      dropped.push(scored)
    }
  }
  return { kept, dropped }
}
