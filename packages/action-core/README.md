# @delfini/action-core

The shared analysis-pipeline core of the [Delfini](https://github.com/Legends-of-Tech) GitHub Action.

This package carries the pieces of the Action's pipeline that are identical in both Delfini Action
artifacts — the standalone (Lite) open-source action and the hosted-platform (Full) action that
ships with the Delfini platform:

- **Doc reader** — `readDocsViaGitTrees` / `readDocsAtHeadViaGitTrees`: one recursive git-trees
  call + the shared `isFileInDocScope` matcher (picomatch@4 dialect, via `@delfini/drift-engine`),
  then matched-blob fetch with front-matter exclusion (`delfini: ignore`).
- **Smart-skip** — `classifyPr`: the FR57 classification (structurally-uninteresting changes /
  every-changed-file-in-doc-scope).
- **Analysis-input assembly** — `buildAnalysisInput` + `buildUnifiedDiff` (+ the opt-in
  deterministic diff pre-filter).
- **Orchestrator** — `SingleCallOrchestrator` / `createOrchestrator`: the single-call LLM adapter
  over `@delfini/drift-engine`'s `buildPrompt` / `validateAndReconcile`, with the canonical
  `prompt.md` template bundled into `dist/`.
- **Shared GitHub client** — PR context, changed-file listing, doc reads, check status, and the
  idempotent marker-keyed PR comment writer.
- **Pipeline input reader** — `readPipelineInputs`: the `doc_scope` delimited-string split,
  `normalizeDocScope`, the code-side `docs/` default, and the hoisted
  `PipelineInputs` / `PipelineDeps` / `Enforcement` types.

## Stability

**No API-stability guarantee in V1.** `@delfini/action-core` is the internal shared core of the
Delfini Action, published for transparency and for consumption by the Delfini platform
(`delfini-web`), which pins exact versions. It is not designed as a general-purpose library
surface; exports may change between minor versions while the package is pre-1.0.

If you want drift analysis as a library, use [`@delfini/drift-engine`](https://www.npmjs.com/package/@delfini/drift-engine)
— the pure-logic analysis core with a deliberate, documented public API.

## License

Apache-2.0
