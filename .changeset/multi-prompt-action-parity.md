---
"@delfini/action-core": minor
---

[action-core] Close Skill↔Action parity for large diffs: `SingleCallOrchestrator`
now splits an over-budget analysis across several budget-sized prompts via
`planPrompts`, dispatches each chunk through the same single-call + retry path,
reconciles each against the full docs, and merges with `mergeAnalysisResults` —
the same drift-engine primitives the Skill's `local-prepare` / `local-finalize`
use, so a finding the Skill surfaces is the finding the Action surfaces. The
single-call path is unchanged: when the whole prompt fits the per-prompt budget
(default 150k, mirroring the CLI, overridable via the orchestrator constructor)
it makes exactly one LLM call as before. A diff the planner cannot split falls
back to one whole-prompt call rather than analysing nothing; oversized doc
sections are surfaced via `core.warning`.
