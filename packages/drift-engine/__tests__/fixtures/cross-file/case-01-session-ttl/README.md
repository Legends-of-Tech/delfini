# cross-file / case-01-session-ttl

A realistic session-auth refactor PR built to validate the **doc-section-sharded
multi-prompt design** (`docs/ideas/multi-prompt-diff-analysis.md`). Unlike the
`token-efficiency` fixtures (one finding, one file ↔ one section), this fixture
carries all three structures the chunking design must handle:

1. **A genuine cross-file finding** (the load-bearing case for "preserve every
   cross-file finding"). `src/auth/issuer.ts` bumps the session TTL to 7200s
   while `src/auth/validator.ts` still rejects tokens older than 3600s. The
   `## Session Tokens` section of `docs/auth-architecture.md` states the two
   MUST agree at 3600s. **No single hunk contradicts the doc** — the drift is
   only visible when both hunks are read together with that section. A chunking
   scheme that splits the two files into different prompts LOSES this finding.

2. **A concentrated single-section cluster** (the over-budget wall). A repo-wide
   `SessionToken` → `SessionTicket` rename across 10 files,
   every hunk routing to the SAME `## Session Tokens` section. Because a section
   is the atomic unit, its hunks cannot spread across chunks — at a tight budget
   this section + its hunks overflow a single prompt, the exact case where
   "preserve every cross-file finding" becomes impossible and the design must
   sub-split + surface loudly.

3. **Spread findings** (clean fan-out). `rotation.ts` (900→1800s) and
   `rate-limit.ts` (100→200rpm) drift against DIFFERENT sections (`## Token
   Rotation`, `## Rate Limiting`), so they distribute across chunks without
   contention.

`expected.json` labels all of the above. The base `groundTruthDocPath` +
`groundTruthSection` keys match the `token-efficiency` retention-gate shape;
the `crossFileFinding` / `concentratedCluster` / `spreadFindings` keys are the
extended labeling this design needs.

Regenerate with:
`node --import tsx packages/drift-engine/scripts/gen-cross-file-fixture.ts`
