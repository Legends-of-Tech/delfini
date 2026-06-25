// packages/drift-engine/src/prompt-planner.ts
//
// Multi-prompt planner (design: docs/ideas/multi-prompt-diff-analysis.md). When
// a single assembled prompt would exceed the per-prompt token budget, split the
// analysis across SEVERAL budget-sized prompts so an arbitrarily large code diff
// can still be analysed — instead of today's hard exit-4 "split the PR" dead end.
//
// Pure-logic — no I/O, no LLM, no env (FR139). Rendering reuses `buildPrompt`,
// routing reuses the `relevance.ts` scorer, so a chunk is just `buildPrompt` on
// a slice of the input. The two consumer surfaces (CLI Skill loop + Action
// orchestrator) loop over `result.chunks`, dispatch each, and merge findings;
// putting the planner here keeps that behaviour parity-identical by construction.
//
// THE CHUNKING UNIT IS THE DOC SECTION. A finding is always doc-anchored
// (`Contradiction.targetDocPath` / `Addition.anchorSection`), so a *cross-file*
// finding is N diff hunks across N files that jointly contradict ONE section.
// By making the section the unit and shipping every hunk the scorer links to it
// in the SAME chunk, a cross-file finding anchored to that section is preserved
// by construction. The honest limit (see `oversizedSections`): a single section
// whose linked hunks alone exceed one budget cannot be kept whole — that is the
// mathematically-unavoidable case where "preserve every cross-file finding"
// fails, and the planner surfaces it loudly rather than dropping silently.

import type { AnalysisInput, DocFile } from './types.js'
import { buildPrompt } from './prompt-builder.js'
import { estimatePromptTokens } from './prompt-budget.js'
import {
  scoreDocRelevance,
  selectRelevantSections,
  type DocSection,
} from './relevance.js'
import {
  parseDiffHunks,
  renderHunksAsDiff,
  hunkKey,
  type DiffHunk,
} from './diff-hunks.js'

export interface PlanPromptsOptions {
  /** Per-prompt token ceiling. Each chunk is packed to stay at-or-below this. */
  promptTokenBudget: number
  /**
   * Diff↔doc relevance threshold (same signal as `BuildPromptOptions`). MUST be
   * positive to route hunks to sections; when it is not positive and the prompt
   * is over budget, the planner cannot split safely and returns the single
   * over-budget chunk with `overBudget: true` rather than guessing.
   */
  relevanceThreshold: number
}

export interface PromptChunk {
  /** Dispatch-ready prompt for this chunk (rendered via `buildPrompt`). */
  prompt: string
  /** `estimatePromptTokens(prompt)`. */
  estimatedTokens: number
  /**
   * LOUD signal: this chunk could not be reduced below budget — its content is
   * a single doc section plus the minimum hunks whose joint cost still overflows
   * (an unsplittable concentrated section). The chunk is emitted anyway (never
   * dropped); the consumer may warn the user that this prompt is oversized.
   */
  overBudget: boolean
  /** Docs contributing a rendered section to this chunk. */
  docPaths: string[]
  /** Code files whose hunks appear in this chunk's diff. */
  hunkFilePaths: string[]
}

export interface OversizedSection {
  docPath: string
  heading: string
  /**
   * Number of chunks this one section's hunks had to be spread across because
   * section + all its linked hunks exceeded a single budget. When > 1, a
   * cross-file finding anchored to this section whose contributing hunks landed
   * in DIFFERENT sub-chunks may be missed — the unavoidable-impossibility case.
   */
  splitAcross: number
}

export interface PlanPromptsResult {
  chunks: PromptChunk[]
  /**
   * `false` → exactly one chunk, byte-identical to `buildPrompt(input, template)`
   * (the prompt already fit; multi-prompt is a fallback, never a new default, so
   * the NFR44 snapshot path is untouched). `true` → the diff was routed + split.
   */
  split: boolean
  /**
   * Code files whose hunks the scorer linked to NO retained section, so they are
   * absent from every chunk. Symmetric with today's default-on doc-section
   * dropping (NFR49): below-threshold content is dropped, but here it is
   * reported (never silent) so a consumer can surface what was excluded.
   */
  droppedHunkFilePaths: string[]
  /** Sections too large to keep whole (see `OversizedSection`). */
  oversizedSections: OversizedSection[]
}

// A (doc, retained-section) pair plus the hunks routed to it.
interface WorkItem {
  doc: DocFile
  section: DocSection
  heading: string
  linked: DiffHunk[]
}

/**
 * Plan one-or-more budget-sized prompts for `input`.
 *
 * Fast path (prompt already fits): one chunk equal to `buildPrompt`. Over
 * budget: route each diff hunk to the doc sections it scores against, pack
 * (section + its hunks) work-items greedily into chunks, and sub-split any
 * single section whose hunks alone exceed budget — emitting that case loudly.
 */
export function planPrompts(
  input: AnalysisInput,
  template: string,
  options: PlanPromptsOptions,
): PlanPromptsResult {
  const { promptTokenBudget: budget, relevanceThreshold: threshold } = options

  // --- Fast path: the whole prompt already fits. Return ONE chunk that is
  // byte-identical to today's default render. Multi-prompt is purely a fallback
  // for oversized diffs — the common case never sees routing, so NFR44 parity
  // and the snapshot gate are untouched.
  const wholePrompt = buildPrompt(input, template)
  const wholeTokens = estimatePromptTokens(wholePrompt)
  if (wholeTokens <= budget) {
    return {
      chunks: [singleChunk(input, wholePrompt, wholeTokens, false)],
      split: false,
      droppedHunkFilePaths: [],
      oversizedSections: [],
    }
  }

  // --- Over budget but no usable routing signal: we cannot decide which hunks
  // are relevant, so splitting would be guessing. Return the single over-budget
  // chunk flagged loudly rather than drop content blindly.
  if (!(threshold > 0)) {
    return {
      chunks: [singleChunk(input, wholePrompt, wholeTokens, true)],
      split: false,
      droppedHunkFilePaths: [],
      oversizedSections: [],
    }
  }

  // --- Route: hunks → retained sections.
  const hunks = parseDiffHunks(input.diff)
  const workItems = buildWorkItems(input.docs, input.diff, hunks, threshold)
  const linkedKeys = new Set<string>()
  for (const item of workItems) for (const h of item.linked) linkedKeys.add(hunkKey(h))
  const droppedHunkFilePaths = uniqueInOrder(
    hunks.filter((h) => !linkedKeys.has(hunkKey(h))).map((h) => h.filePath),
  )

  // Degenerate case: nothing was retained (no section is relevant to the diff).
  // There is no drift-relevant content to chunk; returning the single
  // over-budget whole prompt is safer than emitting zero chunks (which would
  // silently analyse nothing).
  if (workItems.length === 0) {
    return {
      chunks: [singleChunk(input, wholePrompt, wholeTokens, true)],
      split: false,
      droppedHunkFilePaths,
      oversizedSections: [],
    }
  }

  // --- Two-level pack.
  const chunks: PromptChunk[] = []
  const oversizedSections: OversizedSection[] = []
  let current: WorkItem[] = []

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push(renderChunk(current, input, template, threshold, budget))
    current = []
  }

  for (const item of workItems) {
    // Level 2 — does this single section alone overflow? If so it cannot share
    // a chunk and must be sub-split across its own dedicated chunks.
    const solo = renderChunk([item], input, template, threshold, budget)
    if (solo.estimatedTokens > budget) {
      flush()
      const sub = subSplitSection(item, input, template, threshold, budget)
      chunks.push(...sub)
      oversizedSections.push({
        docPath: item.doc.path,
        heading: item.heading,
        splitAcross: sub.length,
      })
      continue
    }

    // Level 1 — greedy pack: would adding this item push the current chunk over
    // budget? If so, flush first. Packing is driven by the ACTUAL rendered token
    // count (not an estimate), so a chunk never silently overflows.
    if (current.length > 0) {
      const trial = renderChunk([...current, item], input, template, threshold, budget)
      if (trial.estimatedTokens > budget) flush()
    }
    current.push(item)
  }
  flush()

  return { chunks, split: true, droppedHunkFilePaths, oversizedSections }
}

// --- Work-item construction -------------------------------------------------

function buildWorkItems(
  docs: DocFile[],
  diff: string,
  hunks: DiffHunk[],
  threshold: number,
): WorkItem[] {
  const items: WorkItem[] = []
  for (const doc of docs) {
    const { kept } = selectRelevantSections(doc, diff, threshold)
    for (const section of kept) {
      const linked = hunks.filter(
        (h) => scoreSectionAgainstHunk(doc, section, h) >= threshold,
      )
      items.push({
        doc,
        section,
        heading: section.lines[0]?.trim() ?? '(leading)',
        linked,
      })
    }
  }
  return items
}

// Score one section against one hunk by reusing the whole-doc scorer on a
// synthetic single-section doc — mirrors `prompt-builder.ts`'s
// `scoreSectionAgainstDiff` so routing uses the EXACT production tier formula
// (any future change to the scoring formula propagates here automatically). The
// synthetic doc's `frontMatterLineCount` carries the section offset so the
// `docPathInDiff` whole-doc tier still behaves correctly.
function scoreSectionAgainstHunk(doc: DocFile, section: DocSection, hunk: DiffHunk): number {
  const synthetic: DocFile = {
    path: doc.path,
    content: section.lines.join('\n'),
    frontMatterLineCount: doc.frontMatterLineCount + section.startLineIndex,
  }
  return scoreDocRelevance(synthetic, renderHunksAsDiff([hunk])).score
}

// --- Chunk rendering --------------------------------------------------------

// Render a set of work-items as ONE chunk by slicing `input` down to the items'
// docs + the union of their linked hunks, then delegating to `buildPrompt` with
// section retrieval on. buildPrompt re-derives which sections of each passed doc
// survive against the chunk's (reduced) diff — keyed by the SAME scorer used for
// routing — so the intended sections render with their absolute original-file
// line numbers intact (Story 3.9b grounding survives the split). The budget is
// NOT passed to buildPrompt: in-chunk ranked-fill would DROP sections, but the
// planner's job is to SPILL them into other chunks, so budget control lives in
// the packer, not in the render.
function renderChunk(
  items: WorkItem[],
  input: AnalysisInput,
  template: string,
  threshold: number,
  budget: number,
): PromptChunk {
  const docPaths = uniqueInOrder(items.map((it) => it.doc.path))
  const docByPath = new Map(input.docs.map((d) => [d.path, d]))
  const docs = docPaths.map((p) => docByPath.get(p)!).filter(Boolean)

  const hunks = dedupeHunks(items.flatMap((it) => it.linked))
  const slice: AnalysisInput = {
    diff: renderHunksAsDiff(hunks),
    docs,
    prMetadata: input.prMetadata,
  }
  const prompt = buildPrompt(slice, template, { relevanceThreshold: threshold })
  const estimatedTokens = estimatePromptTokens(prompt)
  return {
    prompt,
    estimatedTokens,
    overBudget: estimatedTokens > budget,
    docPaths,
    hunkFilePaths: uniqueInOrder(hunks.map((h) => h.filePath)),
  }
}

// Level 2 — a single section whose (section + all linked hunks) exceeds budget.
// Spread the section's hunks across multiple chunks, each rendering the SAME
// section with a hunk subset that fits. If section + a single hunk still
// overflows (the section body alone is near/over budget), that sub-chunk is
// emitted with `overBudget: true` — we never drop the hunk, we surface the
// over-budget prompt. Hunks within a sub-chunk stay co-located, so cross-file
// findings whose hunks land in the SAME sub-chunk are still preserved; only
// findings split ACROSS sub-chunks are at risk (reported via OversizedSection).
function subSplitSection(
  item: WorkItem,
  input: AnalysisInput,
  template: string,
  threshold: number,
  budget: number,
): PromptChunk[] {
  const out: PromptChunk[] = []
  let group: DiffHunk[] = []

  const renderGroup = (hunks: DiffHunk[]): PromptChunk =>
    renderChunk([{ ...item, linked: hunks }], input, template, threshold, budget)

  for (const hunk of item.linked) {
    if (group.length === 0) {
      group.push(hunk)
      continue
    }
    const trial = renderGroup([...group, hunk])
    if (trial.estimatedTokens > budget) {
      out.push(renderGroup(group))
      group = [hunk]
    } else {
      group.push(hunk)
    }
  }
  if (group.length > 0) out.push(renderGroup(group))
  // Defensive: a section with zero linked hunks can still be over budget via its
  // own body; emit it as one chunk so the section is never lost.
  if (out.length === 0) out.push(renderGroup([]))
  return out
}

// --- Small helpers ----------------------------------------------------------

function singleChunk(
  input: AnalysisInput,
  prompt: string,
  tokens: number,
  overBudget: boolean,
): PromptChunk {
  return {
    prompt,
    estimatedTokens: tokens,
    overBudget,
    docPaths: input.docs.map((d) => d.path),
    hunkFilePaths: uniqueInOrder(parseDiffHunks(input.diff).map((h) => h.filePath)),
  }
}

function dedupeHunks(hunks: DiffHunk[]): DiffHunk[] {
  const seen = new Set<string>()
  const out: DiffHunk[] = []
  for (const h of hunks) {
    const k = hunkKey(h)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(h)
  }
  return out
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}
