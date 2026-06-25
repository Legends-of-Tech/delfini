// Story 3.9b — orchestrator-side line-range reconciliation.
//
// architecture.md L268-269 — "Guardrail 2 — Citation Grounding (deterministic):
// every cited evidence excerpt must appear verbatim (CRLF/whitespace
// normalized) in the input docs. Findings whose citations don't ground are
// downgraded from DRIFT to NEEDS CLARIFICATION (no-fabrication principle)."
//
// MVP implementation: drop ungrounded findings (instead of synthesising a
// clarification). The clarification leg is unreachable in v1 (the orchestrator
// only emits drift) and surfacing a synthesised clarification with no
// concrete proposed_replacement re-introduces the noise this guardrail exists
// to suppress. Operators see drops via the `core.warning` callback so the
// silent-drop rate is observable in the Actions log.
//
// Mechanism:
//   1. The LLM saw doc lines prefixed with absolute line numbers (Story 3.9b
//      Task 3) and emitted both `targetLineStart` / `targetLineEnd` AND a
//      verbatim `quotedDocText` excerpt.
//   2. We `indexOf` the quote in the doc body (after CRLF→LF + per-line
//      trailing-whitespace normalisation).
//   3. If the quote is found, derive the line range from the match and
//      overwrite the LLM's claimed range. The code, not the LLM, is the
//      source of truth for line numbers.
//   4. If not found, drop the finding.

import type { Addition, AnalysisResult, Contradiction, DocFile } from './types.js'
import { analysisSchema } from './schema.js'

// Whitespace normalisation matched to `apps/web/src/server/reviews/compare-forgiving.ts`
// (Story 4.10): CRLF→LF and per-line trailing-whitespace trim. Keeping the
// shape symmetric means a quote that grounds in the orchestrator also matches
// the slice the FR102 commit-splicer reads — divergence here would create a
// "grounded in analysis but missing at commit-time" failure mode.
function normaliseLineEndings(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
}

export interface LocatedRange {
  // 1-indexed, inclusive — matches the wire/orchestrator contract for
  // `targetLineStart` / `targetLineEnd`. Both numbers are absolute (i.e.
  // already offset by `frontMatterLineCount`).
  start: number
  end: number
}

// Locate the verbatim quote in the doc body. Returns absolute line numbers
// (offset by `frontMatterLineCount`), or `null` if the quote isn't found.
// First-match-wins on duplicate occurrences — there's no obvious better tie-
// breaker without re-introducing the LLM line range as a hint, which defeats
// the whole point of this reconciliation pass.
export function locateQuote(
  quote: string,
  docBody: string,
  frontMatterLineCount: number,
): LocatedRange | null {
  const normBody = normaliseLineEndings(docBody)
  const normQuote = normaliseLineEndings(quote)
  if (normQuote.length === 0) return null

  const idx = normBody.indexOf(normQuote)
  if (idx === -1) return null

  // Convert character offset → 1-indexed body line number.
  // `bodyStart` = number of newlines in `normBody[0..idx)` + 1.
  const before = normBody.slice(0, idx)
  const bodyStart = (before.match(/\n/g)?.length ?? 0) + 1

  // The match spans newlines internal to `normQuote`. Body-end line is body-
  // start plus the count of newlines inside the quote.
  const quoteNewlineCount = normQuote.match(/\n/g)?.length ?? 0
  const bodyEnd = bodyStart + quoteNewlineCount

  return {
    start: bodyStart + frontMatterLineCount,
    end: bodyEnd + frontMatterLineCount,
  }
}

export type WarnFn = (message: string) => void

// Partition drift findings by actionability:
//   - null or whitespace-only `proposedReplacement` → returned in `narrativeOnly`.
//     The LLM correctly detected drift but had no concrete doc patch to
//     suggest (typically because the doc rule is right and the code is the
//     violation — resolution is to fix code, not docs). These are NOT
//     apply-eligible but are real findings the user should see; the Skill's
//     CLI report surfaces them under "Manual review required". The Action's
//     hosted-review consumers ignore the `narrativeOnly` arm to preserve
//     Stream 4a auto-resolve semantics (a null-replacement on the hosted
//     surface would block auto-resolve forever).
//   - byte-equal to `quotedDocText` after CRLF/whitespace normalisation
//     → silently dropped. This is genuine no-op noise — a stale-comment
//     artefact where the LLM senses contradiction on a code comment but the
//     doc is already correct. Accepting it would produce no diff. Drop is
//     logged via `onWarn` for observability but the finding is discarded
//     (not surfaced as narrative-only) because there is nothing to convey
//     to the user — the doc and the proposed wording are the same string.
//
// Drops in the byte-equal branch are surfaced via `onWarn` (operator-
// observable in the Actions log) for the same reason `reconcileLineNumbers`
// warns on ungrounded drops — silent-drop rate is the only signal that the
// LLM is producing this shape. Null/whitespace drops do NOT warn — they
// flow through `narrativeOnly` instead, which is the operator-observable
// surface for that case.
export function filterActionableContradictions(
  contradictions: Contradiction[],
  onWarn: WarnFn = () => {},
): { kept: Contradiction[]; narrativeOnly: Contradiction[] } {
  const kept: Contradiction[] = []
  const narrativeOnly: Contradiction[] = []
  for (const c of contradictions) {
    if (c.proposedReplacement === null || c.proposedReplacement.trim() === '') {
      narrativeOnly.push(c)
      continue
    }
    if (
      normaliseLineEndings(c.proposedReplacement) ===
      normaliseLineEndings(c.quotedDocText)
    ) {
      const preview = c.quotedDocText.slice(0, 80).replace(/\n/g, ' ')
      onWarn(
        `Reconciliation dropped finding for "${c.targetDocPath}" — proposedReplacement is byte-equal to quotedDocText (no-op; preview: "${preview}${c.quotedDocText.length > 80 ? '…' : ''}").`,
      )
      continue
    }
    kept.push(c)
  }
  return { kept, narrativeOnly }
}

// Drop overlapping contradictions before they ship to the platform. The
// downstream splicer (`findOverlappingRanges` in splice-helpers.ts) rejects
// the entire Approve-and-Commit batch when any two findings on the same doc
// share an overlapping `[targetLineStart..targetLineEnd]` range — by design,
// because applying two replacements to the same span clobbers each other.
//
// Observed Sonnet-4.6 behaviour: when a section block contains multiple
// conceptual drifts (e.g. the 3-line TanStack stack block where each line is
// a separate drift target), the model emits N findings ALL targeting the
// same line range, each with its own proposed replacement. The reviewer
// hits "Approve and Commit" → splicer rejects the whole batch. The result
// is a dead-end for the demo.
//
// Strategy: keep the highest-confidence finding per overlap group; drop the
// rest with a warning so operators see the silent-drop rate in the Actions
// log. Tie-break by first-seen so behaviour is deterministic for fixtures.
//
// This is a SAFETY NET, not a model fix. The prompt instructs the LLM to
// emit one consolidated finding per overlapping span, but compliance is
// best-effort. The dedup pass guarantees the platform never receives
// findings that the splicer will reject.
//
// Story 4.26 AC6 (Path B) — additive findings are NOT deduped here. The
// canonical gate is `findOverlappingRanges` in `apps/web/src/server/reviews/
// lib/splice-helpers.ts`, which runs server-side after FR88d and before any
// DB write. Its tests at `apps/web/src/server/reviews/lib/__tests__/
// splice-helpers.test.ts` (Story 4.25 — "Story 4.25 — additive findings
// expand the conflict taxonomy" describe block at L396+) cover the three
// additive overlap classes from the AC2 prompt rewrite:
//   1. additive anchor inside a drift range — rejected
//   2. additive anchors at the same line with the SAME insertionMode —
//      rejected (ambiguous)
//   3. additive anchors at the same line with DIFFERENT insertionMode
//      values ('before' vs 'after') — accepted (deterministic before/after)
// Adding a sibling additive-dedup pass at the orchestrator was considered
// (AC6 Path A) but rejected for the lower-lift / single-canonical-gate
// posture — the splicer already catches every overlap the LLM can emit.
export function dedupeOverlappingContradictions(
  contradictions: Contradiction[],
  onWarn: WarnFn = () => {},
): Contradiction[] {
  // Group by doc path so overlap is only considered within a single file.
  const byDoc = new Map<string, Contradiction[]>()
  for (const c of contradictions) {
    const list = byDoc.get(c.targetDocPath) ?? []
    list.push(c)
    byDoc.set(c.targetDocPath, list)
  }

  const kept: Contradiction[] = []
  for (const [, docFindings] of byDoc) {
    // Sort by confidence desc, then by original index (stable tie-break).
    const indexed = docFindings.map((c, i) => ({ c, i }))
    indexed.sort((a, b) => {
      if (b.c.confidence !== a.c.confidence) return b.c.confidence - a.c.confidence
      return a.i - b.i
    })

    const docKept: Contradiction[] = []
    for (const { c } of indexed) {
      const overlap = docKept.find(
        (k) =>
          c.targetLineStart <= k.targetLineEnd && c.targetLineEnd >= k.targetLineStart,
      )
      if (overlap) {
        onWarn(
          `Reconciliation dropped overlapping finding on "${c.targetDocPath}" lines ${c.targetLineStart}-${c.targetLineEnd} — already covered by a higher-confidence finding at lines ${overlap.targetLineStart}-${overlap.targetLineEnd}.`,
        )
        continue
      }
      docKept.push(c)
    }
    kept.push(...docKept)
  }
  return kept
}

// Story 4.25 — locate an anchor section heading in the doc body and return
// its absolute line number. Mirrors `locateQuote`'s contract (1-indexed,
// offset by frontMatterLineCount, first-match-wins) but searches for a
// markdown heading line whose visible text equals the anchor section. We
// match any line that strips down to the anchor text after removing leading
// `#` markers and surrounding whitespace — that lets the LLM emit
// "Technology Stack & Versions" and ground against `## Technology Stack &
// Versions` in the doc.
export function locateAnchorHeading(
  anchorSection: string,
  docBody: string,
  frontMatterLineCount: number,
): number | null {
  const normBody = normaliseLineEndings(docBody)
  const wantedText = anchorSection.trim()
  if (wantedText.length === 0) return null
  const lines = normBody.split('\n')
  const HEADING_RE = /^\s*#{1,6}\s/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Story 4.25 code-review fix: require an actual heading prefix. `replace`
    // returns the line unchanged when the regex doesn't match, so without this
    // gate any prose line whose trimmed text equals the anchor would match
    // (e.g. a TOC entry rendered as the bare section name).
    if (!HEADING_RE.test(line)) continue
    const stripped = line.replace(/^\s*#{1,6}\s*/, '').trim()
    if (stripped === wantedText) {
      return i + 1 + frontMatterLineCount
    }
  }
  return null
}

// Story 4.25 — drop additive findings whose anchor heading can't be located
// in the doc body (no-fabrication invariant); overwrite `anchorLine` with
// the located absolute line number for findings whose anchor IS located.
// The LLM emits a section heading text; the orchestrator derives the line.
export function reconcileAdditiveAnchors(
  additions: Addition[],
  docs: DocFile[],
  onWarn: WarnFn = () => {},
): Addition[] {
  const kept: Addition[] = []
  for (const a of additions) {
    const doc = docs.find((d) => d.path === a.targetDocPath)
    if (!doc) {
      onWarn(
        `Reconciliation dropped additive finding for unknown doc path "${a.targetDocPath}" (no doc with this path was analysed).`,
      )
      continue
    }
    const lineNumber = locateAnchorHeading(
      a.anchorSection,
      doc.content,
      doc.frontMatterLineCount,
    )
    if (lineNumber === null) {
      const preview = a.anchorSection.slice(0, 80)
      onWarn(
        `Reconciliation dropped additive finding for "${a.targetDocPath}" — anchor section heading not found in doc body (preview: "${preview}${a.anchorSection.length > 80 ? '…' : ''}").`,
      )
      continue
    }
    kept.push({ ...a, anchorLine: lineNumber })
  }
  return kept
}

// Reconcile each contradiction's line range against the doc body via
// `locateQuote(quotedDocText)`. Findings whose quote can't be located are
// dropped (returned list is shorter than input). Findings whose quote is
// located have their `targetLineStart` / `targetLineEnd` overwritten — the
// LLM's emitted numbers become advisory.
export function reconcileLineNumbers(
  contradictions: Contradiction[],
  docs: DocFile[],
  onWarn: WarnFn = () => {},
): Contradiction[] {
  const kept: Contradiction[] = []
  for (const c of contradictions) {
    const doc = docs.find((d) => d.path === c.targetDocPath)
    if (!doc) {
      onWarn(
        `Reconciliation dropped finding for unknown doc path "${c.targetDocPath}" (no doc with this path was analysed).`,
      )
      continue
    }
    const located = locateQuote(c.quotedDocText, doc.content, doc.frontMatterLineCount)
    if (located === null) {
      // First 80 chars of the quote — never log the full quote (could be
      // arbitrary doc content; in public repos the Actions log is public).
      const preview = c.quotedDocText.slice(0, 80).replace(/\n/g, ' ')
      onWarn(
        `Reconciliation dropped finding for "${c.targetDocPath}" — quotedDocText not found in doc body (preview: "${preview}${c.quotedDocText.length > 80 ? '…' : ''}").`,
      )
      continue
    }
    kept.push({
      ...c,
      targetLineStart: located.start,
      targetLineEnd: located.end,
    })
  }
  return kept
}

// Public surface — composed reconciliation entry point for the analysis core.
// Validates the LLM's raw JSON output against `analysisSchema`, then runs the
// four-stage reconciliation pipeline (line-number grounding, actionability
// filter, overlap dedup, additive-anchor grounding) in the same order the
// Action's orchestrator used pre-extraction.
//
// Throws on schema-validation failure (`analysisSchema.parse` throws). The
// `@delfini/cli` `local-finalize` command keys exit-code 3 off this throw via
// FR145's one-retry contract.
//
// `onWarn` defaults to a no-op. The Action wires `core.warning` so dropped
// findings (ungrounded quotes, unactionable replacements, overlap losers,
// missing additive anchors) show up in the Actions log.
export function validateAndReconcile(
  rawJson: unknown,
  docs: DocFile[],
  onWarn: WarnFn = () => {},
): AnalysisResult {
  const parsed = analysisSchema.parse(rawJson)
  const reconciledContradictions = reconcileLineNumbers(
    parsed.contradictions as Contradiction[],
    docs,
    onWarn,
  )
  const { kept: actionable, narrativeOnly } = filterActionableContradictions(
    reconciledContradictions,
    onWarn,
  )
  const dedupedContradictions = dedupeOverlappingContradictions(actionable, onWarn)
  const reconciledAdditions = reconcileAdditiveAnchors(
    parsed.additions as Addition[],
    docs,
    onWarn,
  )
  // narrativeOnly is intentionally NOT deduped: it never enters the splicer,
  // so overlap doesn't matter, and dropping a narrative-only entry that
  // overlaps with an apply-eligible one would hide useful context from the
  // user (the two findings can describe the same drift from different angles).
  //
  // `narrativeOnlyContradictions` is conditionally spread (only when non-
  // empty) to keep the optional-field semantics honest: consumers that
  // predate this field (notably apps/action's hosted-review path) see no
  // change in result shape for the common case, and their `toEqual`-style
  // fixture comparisons stay stable. CLI consumers use `?? []` so the
  // undefined case is handled identically to `[]`.
  return {
    contradictions: dedupedContradictions,
    additions: reconciledAdditions,
    rawConfidence: parsed.rawConfidence,
    ...(narrativeOnly.length > 0 ? { narrativeOnlyContradictions: narrativeOnly } : {}),
  }
}

// Multi-prompt merge (design: docs/ideas/multi-prompt-diff-analysis.md). When an
// over-budget analysis is split into N chunks by `planPrompts`, each chunk is
// dispatched separately and its raw JSON is run through `validateAndReconcile`
// against that chunk's docs — yielding N already-grounded `AnalysisResult`s.
// This folds them into ONE.
//
// The same finding can legitimately surface in more than one chunk: a doc
// SECTION relevant to hunks in two chunks is rendered into both, so the LLM may
// flag the same doc line twice. Dedup re-uses the EXISTING overlap pass for
// contradictions — `dedupeOverlappingContradictions` keys on
// `(targetDocPath, overlapping [targetLineStart..targetLineEnd])` and keeps the
// highest-confidence finding, which is exactly the cross-chunk-duplicate case
// (identical ranges overlap trivially). Because inputs are already reconciled,
// merge needs no doc bodies.
//
// Additions and narrative-only contradictions are exact-deduped (the overlap
// pass deliberately does not touch additives — see the L157 note — and narrative
// entries never enter the splicer). A duplicate here is a byte-identical finding
// emitted by two chunks; collapsing it prevents the Skill from offering the same
// edit twice. Distinct findings on the same anchor are preserved.
//
// `rawConfidence` is the MAX across chunks: it is an overall-signal scalar, and
// a high-confidence verdict from any chunk should not be diluted by averaging
// against chunks that happened to see unrelated slices of the diff.
export function mergeAnalysisResults(
  results: AnalysisResult[],
  onWarn: WarnFn = () => {},
): AnalysisResult {
  const dedupedContradictions = dedupeOverlappingContradictions(
    results.flatMap((r) => r.contradictions),
    onWarn,
  )
  const additions = dedupeExact(
    results.flatMap((r) => r.additions),
    (a) => `${a.targetDocPath}\u0000${a.anchorLine}\u0000${a.insertionMode}\u0000${a.proposedContent}`,
    (a) =>
      onWarn(
        `Merge dropped duplicate additive finding for "${a.targetDocPath}" at line ${a.anchorLine} (${a.insertionMode}) — identical content already merged from another chunk.`,
      ),
  )
  const narrativeOnly = dedupeExact(
    results.flatMap((r) => r.narrativeOnlyContradictions ?? []),
    (c) => `${c.targetDocPath}\u0000${c.targetLineStart}\u0000${c.targetLineEnd}\u0000${c.whatContradicts}`,
    () => {},
  )
  const rawConfidence = results.length > 0 ? Math.max(...results.map((r) => r.rawConfidence)) : 0

  return {
    contradictions: dedupedContradictions,
    additions,
    rawConfidence,
    ...(narrativeOnly.length > 0 ? { narrativeOnlyContradictions: narrativeOnly } : {}),
  }
}

// Keep the FIRST occurrence per key; report each later duplicate via `onDrop`.
// Order-preserving and deterministic (first-seen wins).
function dedupeExact<T>(items: T[], key: (item: T) => string, onDrop: (item: T) => void): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) {
      onDrop(item)
      continue
    }
    seen.add(k)
    out.push(item)
  }
  return out
}
