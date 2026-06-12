# Delfini Compare-Diffs Prompt — Design Notes

> **The runtime prompt is canonical at [`packages/drift-engine/src/prompt.md`](../../packages/drift-engine/src/prompt.md).**
>
> That file ships inside `@delfini/drift-engine` and is consumed by every Delfini surface (Action, CLI) via parameter injection — the caller reads `prompt.md` and passes its contents into `buildPrompt(input, template)`. drift-engine itself is pure-logic and never touches the filesystem. It is the only place to edit the prompt text itself.
>
> This file is a companion design doc. It does NOT duplicate the prompt template. It captures the surrounding rationale: why the prompt is shaped the way it is, the type contract it produces (including the forward-looking three-label model that lands with FR88c), the assembly order including the retry-only corrective-feedback appendix, and the design decisions behind the operating principles.
>
> The runtime prompt currently ships a drift-only subset of what this design doc describes. The clarifications leg (`NEEDS_CLARIFICATION` + `clarifications[]`) is documented here as the planned extension; it is not yet wired into `schema.ts` / `pipeline.ts`. See `pipeline.ts:178-182` for the integration TODO.

---

## Purpose

The structured analysis prompt that `prompt-builder.ts` constructs and sends to the LLM on every PR analysis run. It compares the PR code diff against the team's source-of-truth markdown documents, classifies the PR into one of three labels (`PASS` / `DRIFT_DETECTED` / `NEEDS_CLARIFICATION`), provides evidence-grounded citations for drift findings and bounded clarifying questions for ambiguity findings, and returns a structured JSON result.

**Implements:** Epic 2, Story 2.2 (Prompt Builder) — `apps/action/src/adapters/single-call/prompt-builder.ts`

**Input:** `AnalysisInput` — the PR diff, all source-of-truth doc files from the configured doc scope, and PR metadata.
**Output:** `AnalysisResult` — a JSON object with a top-level `label`, a `contradictions` array (drift findings), a `clarifications` array (ambiguity findings — pending FR88c), and an overall `rawConfidence` score.
**Models:** Provider-agnostic — designed for Claude, Gemini, and GPT via the port/adapter pattern.

---

## Prompt Assembly Reference

`prompt-builder.ts` assembles the final prompt string by concatenating sections in this order. Section bodies live in the runtime `prompt.md`.

| Order | Section | Condition |
|---|---|---|
| 1 | `<documents>` | Always |
| 2 | `<diff>` | Always |
| 3 | `<pr_metadata>` | Always |
| 4 | `<instructions>` | Always |
| 5 | `<severity_criteria>` | Always |
| 6 | `<reasoning_process>` | Always |
| 7 | `<output_schema>` | Always |
| 8 | `<examples>` | Always |
| 9 | `<corrective_feedback>` | Retry only — when `failReasons` is non-empty (pending the quality-gate retry; see Corrective Feedback Appendix below) |
| 10 | `<query>` | Always (last) |

---

## Corrective Feedback Appendix (Retry Only — pending Story 2.5 quality gate)

When the quality gate (Story 2.5 — currently backlog) fails and the pipeline retries with corrective feedback, `prompt-builder.ts` will append this section between `<examples>` and `<query>`. It is only present on retry — never on the first attempt. Documented here ahead of implementation so the contract is settled when retry-mode lands.

```xml
<corrective_feedback>

Your previous analysis did not pass the quality gate. The following issues were identified:

{{#each failReasons}}
- {{this}}
{{/each}}

Re-analyze the PR diff against the source-of-truth documents. Address each issue listed above. Specifically:
- If a citation was flagged as **ungrounded**, verify that the document path, section heading, and line reference you cite actually exist in the <documents> provided. Do not cite sections or lines that are not present.
- If relevance was flagged as **low**, re-evaluate whether each contradiction represents a genuine conflict between the code change and the documentation, not just superficial textual similarity.
- If confidence was flagged as **miscalibrated**, adjust your confidence scores to reflect your actual certainty. Use the full 1–5 range.
- If your previous analysis was flagged as **wrong-label** (e.g. you emitted DRIFT_DETECTED on a finding that should have been NEEDS_CLARIFICATION, or vice versa), re-apply Step 4 of <reasoning_process> rigorously: can you quote a specific document passage that the code contradicts? If not, the kind is clarification, not drift. Move the finding to the correct array and update the top-level `label` accordingly.
- If your previous analysis was flagged as a **fabricated contradiction** (you emitted DRIFT_DETECTED but the cited document passage doesn't actually make the claim you said it does), drop that finding entirely. It belongs in `clarifications[]` as a NEEDS_CLARIFICATION entry with a bounded question, OR not at all if the behavior is a routine implementation detail. This is the prohibited failure mode — never substitute a fabricated drift finding for an honest "the docs don't decide on this."
- If your previous analysis was flagged as a **missed clarification gap** (you emitted PASS but the diff introduced a clear undocumented decision such as a timeout, retry policy, auth flow, or security boundary), re-scan the diff for behaviors the docs are silent on. Emit those as `clarifications[]` entries with bounded questions; the label becomes NEEDS_CLARIFICATION.

Return a corrected JSON object conforming to <output_schema>. Re-apply the co-occurrence rule from Step 5: only one yellow label per response.

</corrective_feedback>
```

---

## Type Alignment Reference (Forward-Looking — 3-label model, FR88c)

These types reflect the prompt's planned output contract once the clarifications leg lands. The currently-shipped Zod schema (`apps/action/src/adapters/single-call/schema.ts`) and domain types (`apps/action/src/ports/types.ts`) validate only the drift-only subset (`{ contradictions[], rawConfidence }`); when FR88c is implemented, those will widen to include `label` and `clarifications[]` per the shapes below.

```typescript
type Label = 'PASS' | 'DRIFT_DETECTED' | 'NEEDS_CLARIFICATION'

interface Contradiction {
  docFile: string
  section: string
  lineRef: string
  diffLocation: string
  severity: 'High' | 'Medium' | 'Low'
  description: string
  suggestion: string
  confidence: number  // 1–5 integer
}

interface Clarification {
  diffLocation: string
  behaviorSummary: string
  naturalHomeDocFile: string
  naturalHomeSection: string
  boundedQuestion: string
  proposedSuggestion: string | null
  confidence: number  // 1–5 integer
}

interface AnalysisResult {
  label: Label
  contradictions: Contradiction[]   // empty unless label === 'DRIFT_DETECTED'
  clarifications: Clarification[]   // empty unless label === 'NEEDS_CLARIFICATION'
  rawConfidence: number  // 0.0–1.0
}
```

Input types consumed by `prompt-builder.ts`:

```typescript
interface DocFile {
  path: string
  content: string
}

interface PRMetadata {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string
  title: string
}

interface AnalysisInput {
  diff: string
  docs: DocFile[]
  prMetadata: PRMetadata
}
```

---

## Design Decisions

**Why longform data at the top:** Claude's documentation states that placing long documents above the query can improve response quality by up to 30% on complex, multi-document inputs. Since Delfini sends potentially dozens of markdown docs and large diffs, this ordering is critical.

**Why three severity levels, not five:** The escalation skill uses five types because it classifies the *nature* of a discovery (hygiene vs. product vs. architectural). This prompt classifies the *severity of a contradiction* — a narrower judgment. Three levels (High/Medium/Low) provide enough granularity for the quality gate and PR comment formatting without forcing the LLM to make fine distinctions between adjacent levels. The confidence score (1–5) provides the additional granularity the quality gate needs.

**Why docs-first suggestions only:** The PRD and architecture both establish a docs-first posture. Suggesting code changes would position Delfini as a code reviewer (competitive with existing tools). Suggesting doc updates positions Delfini as a documentation governance tool (a new category). The suggestion field always frames the action as "consider updating [doc section]."

**Why "precision over recall" as an operating principle:** The quality gate (Story 2.5) provides a safety net for false positives — the scorer can catch ungrounded citations and irrelevant matches. But there is no downstream system to catch false negatives. By biasing the LLM toward precision, we let the quality gate handle the edge cases rather than flooding developers with noise. The three-label model adds NEEDS_CLARIFICATION as a third release valve: what used to be low-confidence drift can now correctly route to clarification, which improves precision and recall simultaneously by giving the LLM a non-binary choice. This is a tunable trade-off: as evals mature, we may shift toward higher recall with tighter quality gate thresholds.

**Why explicit reasoning steps:** Claude's best practices recommend that for complex multi-step reasoning, providing general guidance about the reasoning process produces better results than prescriptive step-by-step plans. However, for this use case the reasoning *must* follow a specific evidence-grounding pattern (read docs first, find matches, then evaluate, then classify the kind, then assign the label). The steps ensure citation grounding happens before kind-classification, and kind-classification before label-assignment — critical for the false-confidence sub-types the eval gate measures (NFR40).

**Why three labels, not a continuum:** The PRD's review-disposition primitive is binary at the GitHub layer (Request Changes vs Comment), and the eval harness needs a discrete confusion matrix to track the three NFR40 false-confidence sub-types. A continuum (single severity score) cannot honor the qualitative drift-vs-ambiguity distinction the no-fabrication principle rests on — drift means "the docs make a specific claim the code reverses" and ambiguity means "the docs are silent on a decision the code makes." These are different kinds of finding, not different points on a severity axis.

**Why a top-level `label` field instead of deriving it from array emptiness:** Three reasons. (1) Anti-fabrication ergonomics — separate `contradictions[]` and `clarifications[]` arrays make it structurally hard to put a clarification into the drift slot, which is the prohibited failure mode. (2) Downstream simplicity — the pipeline can switch on a single `label` field rather than recomputing the label from emptiness rules; the comment formatter renders one of three branches directly. (3) Eval readability — NFR41's confusion matrix uses the `label` field as the model's emitted label, so there is exactly one definition of "what label did the model produce."

**Why DRIFT trumps when both kinds are present:** GitHub review disposition is single-valued — a review is either Request Changes or a regular Comment, not both. Co-emitting drift findings and clarification findings in the same response would be a phantom capability the downstream cannot honor. Forcing one kind per response (with drift always winning) keeps the classification crisp for evals and prevents the LLM from using "I'll claim weak drift so I can also include the ambiguity I'm more confident about" as an escape valve.

**Why post-PR doc text is the source of truth, not the pre-PR version:** When a developer fixes drift in the same PR by editing both code and the relevant doc to match, the LLM sees the post-PR doc content (read at the PR head SHA) and the full diff (which includes both edits). Anchoring the contradiction tests to the post-PR text — not a mentally-reconstructed pre-PR version — prevents the most common false-positive mode of the analyser: flagging a developer's own just-written doc text as contradicted by the code it was written to accommodate. The runtime prompt's Operating Principles and Step 3 enforce this; the carve-out for "edited but still wrong" (partial edits, edits that fixed a different aspect, new wording that makes claims the code doesn't fulfil) preserves the analyser's ability to flag genuinely-still-broken docs.

**Why one finding per doc location, even when the same rule appears at multiple places:** A team's source-of-truth doc often states the same rule at multiple locations — for example, a primary statement in a conventions section AND a restatement in an "Anti-Patterns" summary. The Approve-and-Commit splicer (FR102) keys per finding on `(targetDocPath, targetSection)` and atomically updates exactly one doc location per accepted finding. If the LLM consolidates multiple locations under one finding citing only the first match, the second location becomes un-updateable through the normal accept flow, leaving silent drift behind that re-surfaces on the next analysis run as if it were "new" — a poor reviewer experience. The runtime prompt's Operating Principles and Step 2 require a separate finding per location. This raises raw recall of repeated-rule cases without violating the precision-over-recall principle, because the second location truly does need an independent update for the doc to stay internally consistent — it's distinct work, not a duplicate finding. Reviewers see one card per affected location and accept each individually.
