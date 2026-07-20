# @delfini/drift-engine

The pure-logic analysis core behind [Delfini](https://github.com/Legends-of-Tech/delfini) — the tool that detects when a code change has made your documentation wrong and proposes the fix.

This package is the brain, with none of the plumbing. Given a diff and a set of documents, it builds the analysis prompt, defines the schema the model must answer in, and reconciles the model's output back to exact line numbers. It is shared by both Delfini surfaces — the **Skill** (local, `@delfini/cli`) and the **Action** (CI) — so the analysis is identical wherever it runs. A finding surfaced locally is the same finding the Action would surface on the eventual PR.

## What it does

A drift analysis is three pure steps, and this package owns all three:

1. **`buildPrompt`** — assemble the LLM prompt from a diff, the in-scope docs, and PR metadata. Every doc line is prefixed with its number so the model can cite exact ranges.
2. **`analysisSchema`** — the schema the model's JSON output must satisfy: structured findings of three kinds — `drift` (replace these lines), `additive` (insert this content), and `clarification` (uncertain — surface for a human).
3. **`validateAndReconcile`** — validate the model's JSON and verify each finding's quoted text actually matches the doc at the cited lines. Mismatches (model hallucinations) are discarded before they reach the caller.

## Install

```bash
npm install @delfini/drift-engine
```

## Public API

```ts
import {
  buildPrompt,             // (input, template, options?) => string
  buildPromptWithDrops,    // (input, template, options?) => { prompt, droppedSections }
  validateAndReconcile,    // (rawJson, docs) => AnalysisResult
  mergeAnalysisResults,    // (results, warn?) => AnalysisResult
  planPrompts,             // (input, template, options?) => PlanPromptsResult
  gateDiffByRelevance,     // (diff, docs, options) => DiffGateResult
  estimatePromptTokens,    // (prompt) => number
  analysisSchema,          // Zod schema for the model's output
  // doc-scope matching:
  normalizeDocScope,
  validateDocScopeEntry,
  classifyEntry,
  isFileInDocScope,
  // types:
  type AnalysisInput,
  type AnalysisResult,
  type DocFile,
  type Contradiction,
  type Addition,
  type PlanPromptsResult,
} from '@delfini/drift-engine'
```

Both the Action and the CLI follow the same flow: gather inputs (diff + docs + PR metadata) → `buildPrompt` → send to an LLM → `validateAndReconcile` on the JSON → render the result. Internal helpers are not re-exported; callers compose only through the surface above.

## Relevance retrieval (optional)

`buildPrompt(input, template, options?)` accepts an optional third argument to keep large prompts focused:

```ts
buildPrompt(input, template, { relevanceThreshold: 5 })
```

Each doc section is scored against the diff and sections below the threshold are dropped before rendering:

| Signal | Points |
|---|---|
| The doc itself appears in the diff | +20 |
| A code-file path from the diff appears in the section | +10 per file |
| An identifier from the diff appears in the section | +3 each, capped at +30 |
| A heading overlaps a diff identifier | +5 per heading |

A threshold of `5` keeps any section with a single file-path or heading match — a safe default that typically cuts prompt size ~40% on doc-heavy inputs with no measurable recall loss. Omit `options` (or pass `0`) to keep every section.

## Diff-side gating (optional)

`gateDiffByRelevance(diff, docs, { sectionThreshold, keepThreshold })` is the symmetric operation on the diff side, for consumer call-sites (the CLI and Action run it by default before prompt assembly). Every hunk is scored against the retained doc sections with the same tier formula; hunks below `keepThreshold` are dropped (reported in `droppedHunks`, never silently), weakly-linked hunks have leading/trailing context trimmed to one line, and structural signals — in-scope doc edits, brand-new files, dependency manifests — always survive. The gate stands down (returns the diff verbatim, `active: false`) rather than ever emitting an empty diff. The default `buildPrompt` path never calls it, so the canonical snapshot is unaffected.

## Runtime constraints

The package is intentionally pure so it can run unchanged in CI and on a developer's laptop:

- **No I/O** — never reads files, never touches the network.
- **No LLM client** — never imports an Anthropic, OpenAI, or LangChain SDK. It builds the prompt and validates the response; *calling* the model is the caller's job.
- **No environment reads** — pure functions of explicit arguments. Same input → byte-identical output, every time.

Runtime dependencies are exactly two, both pure CPU: [`zod`](https://www.npmjs.com/package/zod) (schema validation) and [`picomatch`](https://www.npmjs.com/package/picomatch) (glob matching).

## License

[Apache-2.0](https://github.com/Legends-of-Tech/delfini/blob/main/LICENSE)
