# Case 01 — Doc-heavy

A small code-change diff alongside three docs that, taken together, dwarf the
changed surface. Only the `## Payment Processing` mid-file section in the
architecture doc could plausibly contradict the change:

- **Diff:** rename `processPaymentBatch` → `processPaymentTransactions` in
  `src/payments/processor.ts`. About a dozen lines, no comments. (Comments
  in a fixture diff leak common English tokens into the relevance scorer's
  identifier set and produce spurious cross-section matches — they are
  deliberately omitted here.)
- **`docs/payments-architecture.md`** (`frontMatterLineCount: 3`) — eight
  H2 sections; only the `## Payment Processing` mid-file section is the
  retention ground-truth (mentions `processPaymentBatch` and
  `src/payments/processor.ts`). The architecture doc also has `## Overview`
  and `## Notifications` sections that survive retrieval at threshold 5
  because they mention `payments` and `provider` — that is fine; the gate
  asserts the ground-truth section survives, not that it is the *only*
  section to survive. This doc carries `frontMatterLineCount: 3` to
  exercise the absolute-line-number offset behaviour under retrieval — the
  deferred-work follow-up flagged during P3.7.4 review.
- **`docs/billing-faq.md`** (`frontMatterLineCount: 0`) — customer-facing
  billing questions: cards, expiries, invoices, taxes, disputes, refunds,
  trials, prepayment, cancellation, POs, credits, billing contact. Entirely
  orthogonal to the diff; every section scores below threshold and is
  dropped under retrieval-on.
- **`docs/deployment-runbook.md`** (`frontMatterLineCount: 0`) — production
  deployment runbook: preconditions, build verification, rollout, migrations,
  feature flags, monitoring, rollback, post-deployment review, out-of-hours,
  communication, hotfixes, multi-region. Entirely orthogonal to the diff;
  every section scores below threshold and is dropped under retrieval-on.

Under retrieval-on (`relevanceThreshold: 5`, `promptTokenBudget: 150_000`),
the assembled prompt shrinks materially because two of the three docs are
dropped entirely and the architecture doc renders just a few surviving
sections. The token-reduction ratio (`tokensOn / tokensOff`) is expected
to land well below the named constant `MAX_PROMPT_TOKEN_RATIO_DOC_HEAVY`
locked in `packages/drift-engine/__tests__/token-efficiency.test.ts`.

The ground-truth section the retention gate asserts MUST survive
retrieval + ranked-fill is the `## Payment Processing` heading at
`DocFile.content` line index 24 (0-indexed).
