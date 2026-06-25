---
"@delfini/drift-engine": minor
---

[drift-engine] Add `planPrompts` — a multi-prompt planner that splits an
over-budget analysis across several budget-sized prompts so an arbitrarily large
code diff can still be analysed instead of hard-failing. The chunking unit is the
doc section: every diff hunk the relevance scorer links to a section ships in the
same chunk, so a cross-file finding anchored to that section is preserved by
construction. A single section whose linked hunks alone exceed one budget is
sub-split and surfaced via `oversizedSections` (never dropped silently). The
default path is untouched — `planPrompts` returns one chunk byte-identical to
`buildPrompt` whenever the prompt already fits, so the NFR44 snapshot gate is
unaffected. Also exports `mergeAnalysisResults`, which folds the per-chunk
reconciled `AnalysisResult`s back into one (re-using the existing overlap-dedup
pass for cross-chunk duplicate contradictions, exact-deduping additions /
narrative-only findings, and taking the max `rawConfidence`), plus the `DiffHunk`
type (`parseDiffHunks` / `renderHunksAsDiff` stay internal).
