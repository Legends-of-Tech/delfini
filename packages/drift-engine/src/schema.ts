import { z } from 'zod'

export const ContradictionSchema = z.object({
  targetDocPath: z.string().min(1),
  targetSection: z.string().min(1),
  targetLineStart: z.number().int().positive(),
  targetLineEnd: z.number().int().positive(),
  whatChanged: z.string().min(1),
  whatContradicts: z.string().min(1),
  proposedReplacement: z.string().nullable(),
  severity: z.enum(['High', 'Medium', 'Low']),
  confidence: z.number().int().min(1).max(5),
  // Story 3.9b — verbatim doc-side excerpt the LLM cites as contradicted by
  // the code change. Used by the orchestrator's reconciler to locate the cited
  // text in the doc body and overwrite `targetLineStart` / `targetLineEnd`
  // with the actual line range. Min length 1 — empty quotes are rejected so
  // the LLM can't bypass grounding by emitting an empty string.
  quotedDocText: z.string().min(1),
})

// Story 4.25 / 4.26 — additive finding LLM output shape. The diff introduces
// a foundational new concept that no doc section covers but that the doc
// would naturally describe. The LLM cites an anchor SECTION HEADING (not a
// quoted line) plus an insertion mode + the verbatim new content to splice.
// The orchestrator's reconciler locates the anchor section's line in the doc
// body before the finding leaves the orchestrator.
export const AdditionSchema = z.object({
  targetDocPath: z.string().min(1),
  anchorSection: z.string().min(1),
  insertionMode: z.enum(['before', 'after']),
  proposedContent: z.string().min(1),
  severity: z.enum(['High', 'Medium', 'Low']),
  confidence: z.number().int().min(1).max(5),
  whatChanged: z.string().min(1),
  rationaleForAddition: z.string().min(1),
})

// Story 4.26 — `additions` is REQUIRED (not `.optional().default([])`).
// Mirrors `contradictions`' shape so the LLM is forced to emit an explicit
// `[]` when no additive findings apply. The Story 4.25 shape used
// `.optional().default([])` which the Zod→JSON-Schema conversion under
// `withStructuredOutput` surfaces as a non-required field to the LLM — a
// likely contributor to additive under-emission spotted in the 4.25 code
// review.
export const AnalysisResultSchema = z.object({
  contradictions: z.array(ContradictionSchema),
  additions: z.array(AdditionSchema),
  rawConfidence: z.number().min(0).max(1),
})

// Public-API alias (architecture.md L1055–L1070). `AnalysisResultSchema` is
// the historical internal name; `analysisSchema` is the camelCase public
// surface re-exported from the barrel.
export const analysisSchema = AnalysisResultSchema

export type ContradictionShape = z.infer<typeof ContradictionSchema>
export type AdditionShape = z.infer<typeof AdditionSchema>
export type AnalysisResultShape = z.infer<typeof AnalysisResultSchema>
