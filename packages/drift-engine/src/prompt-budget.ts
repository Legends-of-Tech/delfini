// Cheap, deterministic, dependency-free token estimator.
//
// Consumer: `delfini local-prepare` (Story P3.2.2) uses this to decide whether
// to exit `4` (`prompt_too_large`) before dispatching the subagent. Estimate
// only — Anthropic's per-request input-token limit is the hard ceiling; the
// CLI's budget is set well below that, so a 5–10% error is fine.
//
// Heuristic: `Math.ceil(length / 3.5)` is empirically close to GPT-style BPE
// tokenization for English + code mix. Do NOT add a tokenizer dependency
// (`gpt-tokenizer`, `js-tiktoken`, etc.) here — drift-engine's sole runtime
// dep is `zod`; adding a tokenizer would violate FR139 + AC8. If byte-
// accurate counting becomes necessary for cost prediction in a Post-MVP
// feature, revisit then. Premature optimisation otherwise.
export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 3.5)
}
