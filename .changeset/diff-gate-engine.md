---
"@delfini/drift-engine": minor
---

[drift-engine] New `gateDiffByRelevance` — the diff-side symmetric of doc retrieval. Routes every hunk to the retained doc sections with the planner's own scorer, drops hunks linked to no section (reported, never silent), trims leading/trailing context to one line on weakly-linked hunks, and unconditionally keeps structural signals (in-scope doc edits, brand-new files, dependency manifests). Stands down rather than ever emitting an empty diff. The default `buildPrompt` path is untouched — the canonical prompt snapshot is byte-identical.
