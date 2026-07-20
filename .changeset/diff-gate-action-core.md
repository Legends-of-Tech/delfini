---
"@delfini/action-core": minor
---

[action-core] `SingleCallOrchestrator` gates the diff by relevance before dispatch (default `ANALYSIS_DIFF_KEEP_THRESHOLD = 5`, lockstep with the CLI's cross-flag default, so both surfaces make identical keep/drop decisions on identical input). Dropped hunks surface as a `core.warning`; the `diffKeepThreshold: 0` constructor option opts out.
