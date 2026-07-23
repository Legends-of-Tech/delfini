---
"@delfini/cli": minor
---

[cli] Wire the multi-prompt planner into the Skill so an over-budget code diff
is analysed across several prompts instead of hard-failing. When the assembled
prompt exceeds budget and retrieval is on, `local-prepare` now calls
`planPrompts` and — if the split yields at least one chunk that fits — writes a
`chunks.json` manifest plus one `analysis-prompt-<k>.md` per chunk (a single
fitting chunk collapses to the normal `analysis-prompt.md` layout; a budget so
tight that nothing fits still exits `4` as before). `local-finalize` gains a
multi-prompt mode: given the trace **directory** it reconciles every
`findings-<k>.json` against the full docs, merges them with
`mergeAnalysisResults`, and reports per-chunk schema failures as `failedChunks`
for targeted retry. The single-prompt path is unchanged (byte-identical
artefacts, same exit codes). `[skill]` The scaffolded SKILL.md template gains a
"Multi-prompt mode" section describing the dispatch loop, directory-based
finalize, and per-chunk retry.
