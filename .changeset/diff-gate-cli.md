---
"@delfini/cli": minor
---

[cli] `local-prepare` now gates the diff side by default: the new `--diff-keep-threshold <N>` (defaulting to the effective `--relevance-threshold`) drops hunks not relevant to any retained doc section before prompt assembly, cutting first-run prompt tokens on large branches. Drops are reported via a `diff gate:` stderr line and a `_diffGateResult` trace record; `--diff-keep-threshold 0` opts out. Every successful single-prompt run also prints a `prompt ≈ Nk tokens (docs/diff/template)` breakdown line.
