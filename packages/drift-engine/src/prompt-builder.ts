import type { AnalysisInput, BuildPromptOptions, DocFile } from './types.js'
import {
  rankedFillSections,
  scoreDocRelevance,
  selectRelevantSections,
  type DocSection,
  type DroppedSection,
  type RankedFillCandidate,
} from './relevance.js'
import { estimatePromptTokens } from './prompt-budget.js'

function countChangedFiles(diff: string): number {
  if (!diff) return 0
  const matches = diff.match(/^diff --git /gm)
  return matches ? matches.length : 0
}

// Story 3.9b — prefix every line of `content` with its absolute (original-file)
// line number. Line `i` (0-indexed) becomes line `lineOffset + i + 1`
// (1-indexed). The LLM uses these prefixes when emitting `targetLineStart` /
// `targetLineEnd`, so it doesn't have to count lines. `quotedDocText` (also new
// in 3.9b) excludes the `N: ` prefix per the prompt instructions, so the
// reconciler can `indexOf` the quote in the raw body without stripping prefixes.
//
// `lineOffset` is the count of original-file lines BEFORE `content`'s first
// line. For a whole doc that is `frontMatterLineCount`. For a heading-delimited
// SECTION (FR150) it is `frontMatterLineCount + section.startLineIndex`, so a
// retained mid-file section keeps its TRUE absolute line numbers even when
// earlier sections were elided — the numbers are never renumbered from 1 nor
// shifted by a dropped section's length.
function prefixDocLines(content: string, lineOffset: number): string {
  const lines = content.split(/\r?\n/)
  return lines.map((line, i) => `${lineOffset + i + 1}: ${line}`).join('\n')
}

// A doc whose body has already been line-prefixed (whole-doc on the default
// path; section-by-section on the relevance-gated path).
interface RenderedDoc {
  path: string
  renderedContent: string
}

function renderDocsBlock(template: string, docs: RenderedDoc[]): string {
  return template.replace(
    /\{\{#each docs\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, inner: string) =>
      docs
        .map((doc) =>
          inner
            .replace(/\{\{this\.path\}\}/g, doc.path)
            .replace(/\{\{this\.content\}\}/g, doc.renderedContent),
        )
        .join(''),
  )
}

// Render a single retained section with its ABSOLUTE original-file line
// numbers (frontMatter offset + section start within the doc body). Used by
// both the per-doc section-gated path and the cross-doc ranked-fill path.
function renderSection(doc: DocFile, section: DocSection): string {
  return prefixDocLines(
    section.lines.join('\n'),
    doc.frontMatterLineCount + section.startLineIndex,
  )
}

// Render a doc's body for the section-gated path: keep only sections scoring
// at/above the threshold, each prefixed with its absolute line numbers. Returns
// null when no section survives — the doc is then omitted from the prompt
// entirely (same outcome as the whole-doc gate dropping an irrelevant doc).
function renderGatedDocContent(
  doc: DocFile,
  diff: string,
  threshold: number,
): string | null {
  const { kept } = selectRelevantSections(doc, diff, threshold)
  if (kept.length === 0) return null
  return kept.map((section) => renderSection(doc, section)).join('\n')
}

// Pure-logic prompt assembly. `template` is the contents of the canonical
// `prompt.md` (bundled with this package at `./prompt.md`). Callers read the
// file themselves and pass the string in — drift-engine never touches the
// filesystem. The Action does this from its bundled `dist/`; the CLI does it
// from `node_modules/@delfini/drift-engine/src/prompt.md` resolved via
// `import.meta.url`.
//
// Delegates to `buildPromptWithDrops` (Story P3.7.3) and discards the
// drop record — single source of truth on rendering, no divergence between
// the string-returning entrypoint and the drops-aware sibling.
export function buildPrompt(
  input: AnalysisInput,
  template: string,
  options?: BuildPromptOptions,
): string {
  return buildPromptWithDrops(input, template, options).prompt
}

/**
 * Drops-aware variant of `buildPrompt` — returns both the rendered prompt
 * and the cross-doc ranked-fill drop record (Story P3.7.3 / FR152). The
 * `droppedSections` array is non-empty ONLY when both
 * `relevanceThreshold > 0` AND `promptTokenBudget > 0` are supplied AND
 * ranked-fill actually dropped at least one retained section. Every other
 * code path (default, retrieval-only, budget-only-without-threshold)
 * returns an empty `droppedSections` array.
 *
 * The single internal rendering path means `buildPrompt`'s output and
 * `buildPromptWithDrops().prompt` are byte-identical for any given input —
 * the NFR44 snapshot test never has to choose between them.
 */
export function buildPromptWithDrops(
  input: AnalysisInput,
  template: string,
  options?: BuildPromptOptions,
): { prompt: string; droppedSections: DroppedSection[] } {
  const { diff, docs, prMetadata } = input

  // Default (no threshold / <= 0 / non-finite) → whole-doc render, byte-
  // identical to the pre-FR150 baseline (NFR44 snapshot parity). A positive
  // threshold switches to section-granularity retrieval (FR150): each doc's
  // body is reduced to its relevant heading-delimited sections, docs with no
  // surviving section are omitted.
  const threshold = options?.relevanceThreshold
  const useSections =
    typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0

  // Ranked-fill gate: only active when BOTH the retrieval stage is on AND a
  // positive budget is supplied. A budget alone (without retrieval) is a no-op
  // — there are no scored candidates to rank. Story Dev Notes §"AC2".
  const budget = options?.promptTokenBudget
  const useRankedFill =
    useSections &&
    typeof budget === 'number' &&
    Number.isFinite(budget) &&
    budget > 0

  const droppedSections: DroppedSection[] = []

  // Closure-bound substitutions so the rendering helpers (baseline + final)
  // share one source of truth for placeholder replacement.
  const substitutions: Record<string, string> = {
    '{{diff}}': diff,
    '{{prMetadata.title}}': prMetadata.title,
    '{{prMetadata.owner}}': prMetadata.owner,
    '{{prMetadata.repo}}': prMetadata.repo,
    '{{prMetadata.prNumber}}': String(prMetadata.prNumber),
    '{{prMetadata.headSha}}': prMetadata.headSha,
    '{{prMetadata.baseSha}}': prMetadata.baseSha,
    '{{changedFileCount}}': String(countChangedFiles(diff)),
  }
  const renderPrompt = (renderedDocs: RenderedDoc[]): string => {
    let out = renderDocsBlock(template, renderedDocs)
    for (const [placeholder, value] of Object.entries(substitutions)) {
      out = out.split(placeholder).join(value)
    }
    return out
  }

  // Build the set of (doc, retained-section) candidates and apply ranked-fill
  // if active. The set of retained sections per doc comes from
  // `selectRelevantSections` (FR150 — already filters below-threshold
  // sections). Ranked-fill then runs over the cross-doc flat list. The
  // section-budget passed to ranked-fill is `userBudget - nonDocBaseline`
  // where the baseline is the rendered prompt with EMPTY docs[] — this is
  // what keeps AC4's "impossible by construction" invariant: ranked-fill
  // never includes a section whose cumulative section cost would push the
  // FINAL rendered prompt past budget.
  let renderedDocs: RenderedDoc[]
  if (useRankedFill) {
    const baselineCost = estimatePromptTokens(renderPrompt([]))
    const sectionBudget = (budget as number) - baselineCost
    renderedDocs = renderWithRankedFill(
      docs,
      diff,
      threshold as number,
      sectionBudget,
      droppedSections,
    )
  } else if (useSections) {
    renderedDocs = []
    for (const doc of docs) {
      const renderedContent = renderGatedDocContent(doc, diff, threshold as number)
      if (renderedContent === null) continue
      renderedDocs.push({ path: doc.path, renderedContent })
    }
  } else {
    renderedDocs = docs.map((doc) => ({
      path: doc.path,
      renderedContent: prefixDocLines(doc.content, doc.frontMatterLineCount),
    }))
  }

  return { prompt: renderPrompt(renderedDocs), droppedSections }
}

// Render the doc set under both retrieval (FR150) AND ranked-fill (FR152).
// Collects every kept section across every doc as a flat candidate list,
// runs `rankedFillSections` with a `measure` closure that knows the per-
// section render cost, then groups included sections back by doc path so
// each doc renders its surviving sections in original order.
//
// Side effect: `droppedSections` is mutated in place with one entry per
// candidate ranked-fill dropped (each carries the `docPath` so the CLI's
// trace artefact and stderr header can identify the source unambiguously).
function renderWithRankedFill(
  docs: DocFile[],
  diff: string,
  threshold: number,
  budget: number,
  droppedSections: DroppedSection[],
): RenderedDoc[] {
  // When `budget <= 0`, the non-doc baseline (computed in
  // `buildPromptWithDrops`) already exceeds the user's budget — no section
  // budget remains. `rankedFillSections` would include everything on its
  // <=0 no-op fast-path; we let that happen so the final rendered prompt
  // overflows naturally and the CLI emits the AC4 case 3 exit 4
  // ("non-doc payload alone exceeds budget — no candidate section fits")
  // with `droppedSections` empty (AC6 absent-key signal preserved).
  // 1. Per-doc retrieval — build candidates over every doc's retained sections.
  const candidates: RankedFillCandidate[] = []
  // Capture the per-doc relevance score breakdown so the measure() closure
  // can re-derive each candidate's cost. We reuse `selectRelevantSections`
  // to get the scored list (per-doc, threshold-filtered).
  for (const doc of docs) {
    const { kept } = selectRelevantSections(doc, diff, threshold)
    for (const section of kept) {
      // Score is not surfaced by `selectRelevantSections` — but we don't
      // strictly need it for the ranked-fill cost; we only need it for the
      // ranking key. Recompute via the same scoring path the per-doc helper
      // uses internally so we get the exact tier-summed value.
      const score = scoreSectionAgainstDiff(doc, section, diff)
      candidates.push({ doc, section, score })
    }
  }

  // 2. Ranked-fill — measure() simulates the render cost (line-prefix
  // overhead + a small per-section framing fudge so the first section of an
  // otherwise-not-yet-included doc still accounts for the wrapper cost).
  const result = rankedFillSections(candidates, budget, measureSectionCost)

  // 3. Record drops with docPath populated (cross-doc visibility, AC3).
  for (const drop of result.dropped) {
    droppedSections.push({
      docPath: drop.doc.path,
      startLineIndex: drop.section.startLineIndex,
      score: drop.score,
    })
  }

  // 4. Group included sections back by doc, preserving the doc's original
  // section ordering (NOT the ranked order — the rendered prompt must read
  // top-to-bottom within each doc, even when retrieval picked sections out
  // of order).
  const includedByDoc = new Map<string, { doc: DocFile; sections: DocSection[] }>()
  for (const candidate of result.included) {
    const entry = includedByDoc.get(candidate.doc.path)
    if (entry) {
      entry.sections.push(candidate.section)
    } else {
      includedByDoc.set(candidate.doc.path, {
        doc: candidate.doc,
        sections: [candidate.section],
      })
    }
  }

  // 5. Render — iterate docs in their original input order to preserve the
  // top-level doc sequence the user supplied; within a doc, sort surviving
  // sections by startLineIndex so the rendered output reads in file order.
  const rendered: RenderedDoc[] = []
  for (const doc of docs) {
    const entry = includedByDoc.get(doc.path)
    if (!entry) continue
    const ordered = [...entry.sections].sort(
      (a, b) => a.startLineIndex - b.startLineIndex,
    )
    rendered.push({
      path: doc.path,
      renderedContent: ordered.map((section) => renderSection(doc, section)).join('\n'),
    })
  }
  return rendered
}

// Compute the rendered-token cost of a single (doc, section) candidate.
// Charges the line-prefixed section body PLUS the full per-doc `<document
// path="…">…</document>` wrapper the template emits (see `prompt.md` L25-29).
// The wrapper is charged on EVERY section rather than once per doc: that
// deliberately OVER-counts the second-and-later sections of a multi-section
// doc (the real wrapper renders once), which is the safe side — it guarantees
// the measure NEVER under-counts. Under-counting is the dangerous direction:
// it would let ranked-fill admit a section whose true rendered cost pushes the
// final assembled prompt past budget, breaking `buildPromptWithDrops`'s
// at-or-below-budget contract and AC4's "impossible by construction" invariant
// for every caller (not just the CLI, which has its own post-render gate).
// Path length is included in the wrapper bytes so a long doc path is accounted
// for — a fixed token constant could under-count a long path.
function measureSectionCost(candidate: RankedFillCandidate): number {
  const rendered = renderSection(candidate.doc, candidate.section)
  return estimatePromptTokens(rendered + docWrapperFraming(candidate.doc.path))
}

// The non-content bytes the template wraps each rendered doc in. Mirrors the
// `{{#each docs}}` block body in `prompt.md` with `{{this.content}}` removed:
//   \n  <document path="PATH">\n  </document>\n
// Kept as a single source of truth so a template wrapper change is reflected
// in the cost measure. Measured together with the section body via one
// `estimatePromptTokens` call so the ceil rounding is shared, not double-paid.
function docWrapperFraming(path: string): string {
  return `\n  <document path="${path}">\n  </document>\n`
}

// Re-derive a section's score independent of `selectRelevantSections` so
// `renderWithRankedFill` can attach the score to each candidate. Mirrors the
// scoring formula in `relevance.ts` — file-overlap + identifier-overlap +
// heading-overlap (section-scoped) plus the whole-doc `docPathInDiff` bonus
// applied to every section of that doc. Kept private; the relevance module
// is the source of truth on what constitutes a "score" and any future
// formula change must be reflected here in lockstep.
function scoreSectionAgainstDiff(doc: DocFile, section: DocSection, diff: string): number {
  // Reuse `scoreDocRelevance` on a synthetic single-section doc — the
  // resulting tier-summed score equals the per-section arithmetic used
  // internally by `selectRelevantSections`. Keeps the scoring formula in
  // exactly one place (relevance.ts) — any future formula change propagates
  // here automatically.
  const singleSectionDoc: DocFile = {
    path: doc.path,
    content: section.lines.join('\n'),
    frontMatterLineCount: doc.frontMatterLineCount + section.startLineIndex,
  }
  return scoreDocRelevance(singleSectionDoc, diff).score
}
