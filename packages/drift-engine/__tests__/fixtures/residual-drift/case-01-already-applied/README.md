# Residual-drift fixture — case-01-already-applied

The code change raises the session timeout from 30 to 60 seconds (`src/config.ts`).
Two docs describe that timeout:

- **`docs/aligned.md`** — the developer has **already edited it on this branch** to say "60
  seconds", so the `diff` contains both the code edit and this doc edit, and the doc body in
  `analysis-input.json` reflects the post-PR head ("60 seconds"). This doc is **already-applied**
  and MUST NOT be re-flagged as drift — the developer already fixed it.
- **`docs/unfixed.md`** — still says "30 seconds" in its post-PR-head content; the `diff` does
  not touch it. This is the **residual drift** doc and MUST be flagged.

`expected.json` labels the two paths: `residualDocPaths` (must drift) and `alreadyAppliedDocPaths`
(must not re-flag). The LLM-free tests assert the fixture shape, the label/doc-path correspondence,
and that `buildPrompt` renders the post-PR-head bytes of both docs. The behavioural assertion
(the LLM does not re-flag the already-applied doc) is a release-time NFR40 eval check, not a
per-commit unit test (Story P3.7.5).

**Additive extension under Story P3.7.5:** `expected.json` also carries `groundTruthDocPath`
(= `docs/unfixed.md`) and `groundTruthSection` (= `{ startLineIndex: 2, headingText: "## Defaults" }`).
These fields feed the P3.7.5 retention gate, which asserts the residual-drift section survives
`selectRelevantSections` + `rankedFillSections`. The original `residualDocPaths` /
`alreadyAppliedDocPaths` labels are untouched — Story P3.7.4's fixture-parity tests in
`packages/drift-engine/__tests__/prompt-builder.test.ts` continue to read them.
