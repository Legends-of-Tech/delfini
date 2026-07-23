# @delfini/action-core

The shared pipeline core of the [Delfini](https://github.com/Legends-of-Tech/delfini) GitHub Action.

[Delfini](https://github.com/Legends-of-Tech/delfini) detects when a code change has made your documentation wrong. This package holds the parts of the Action's CI pipeline that are identical across both Action editions — the standalone open-source action and the hosted-platform-paired action — so they share one tested implementation:

- **Doc reader** — fetches the in-scope docs from the repo via a single git-trees call + the shared doc-scope matcher (glob dialect from [`@delfini/drift-engine`](https://www.npmjs.com/package/@delfini/drift-engine)), with front-matter exclusion (`delfini: ignore`).
- **Change classification** — decides whether a PR's changes are worth analyzing or can be skipped.
- **Analysis assembly** — builds the unified diff and the analysis input (with an optional deterministic diff pre-filter that drops noise like lockfiles).
- **Orchestrator** — the LLM adapter over the engine's `buildPrompt` / `validateAndReconcile`; for over-budget diffs it splits the analysis via `planPrompts` and merges per-chunk results with `mergeAnalysisResults` — the same drift-engine primitives the Skill uses, so both surfaces agree on large diffs.
- **Shared GitHub client** — PR context, changed-file listing, doc reads, check status, and an idempotent PR-comment writer.
- **Input reader** — parses the Action's `doc_scope` input (with the code-side `docs/` default) into the engine's doc-scope representation.

## Install

```bash
npm install @delfini/action-core
```

## Stability

**No API-stability guarantee while pre-1.0.** `@delfini/action-core` is the internal shared core of the Delfini Action, published for transparency and for consumption by the hosted Delfini platform, which pins exact versions. It is not designed as a general-purpose library; exports may change between minor versions.

If you want drift analysis as a library, use [`@delfini/drift-engine`](https://www.npmjs.com/package/@delfini/drift-engine) instead — the pure-logic analysis core with a deliberate, documented public API.

## License

[Apache-2.0](https://github.com/Legends-of-Tech/delfini/blob/main/LICENSE)
