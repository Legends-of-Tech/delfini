# Lexically-invisible contradiction — the diff gate's accepted recall hole

This fixture pins the **load-bearing bet** of the always-on diff gate
(`docs/ideas/token-diet-symmetric-retrieval.md`, Key Assumption 1): that hunks
which contradict a doc section usually share lexical signal (identifiers,
paths, headings) with it. This case is the counter-example, kept labelled and
committed so the bet stays *measured* instead of assumed.

## The shape

- `src/config/timeouts.ts` changes `IDLE_LIMIT_MS` from `3600_000` to
  `7200_000` — the idle timeout doubles from one hour to two.
- `docs/policies.md § Session lifetime` says
  *"Sessions expire after one hour of inactivity."*
- That is a real High-severity contradiction — and the hunk shares **zero**
  identifiers or paths with the section (the doc paraphrases the behaviour in
  product language; the code speaks in constants). Lexical routing scores the
  pair 0.
- A second, doc-linked hunk (`src/payments/api.ts`, cited by `## Payments`)
  keeps the gate's retained-section universe non-empty — the realistic
  mixed-PR shape in which the gate actually fires. With a single invisible
  hunk and equal thresholds the gate stands down on its own (`no-sections`),
  so the hole only opens on mixed diffs.

## What the committed test asserts

`__tests__/diff-gate-fixtures.test.ts` asserts the invisible hunk **is
dropped** at the default thresholds. That is the CURRENT, ACCEPTED behaviour,
not a target: if a future scoring improvement (semantic signals, numeric-literal
matching, section-adjacency heuristics) closes the hole, the test fails
loudly and should be UPDATED to assert the keep — flipping this fixture from
"documented loss" to "regression guard".

## Scope notes

- The same hole predates the gate on the doc side: NFR49's default-on
  retrieval already drops `## Session lifetime` from the prompt for this diff
  (score 0 < 5), and `planPrompts` routing makes the same bet for over-budget
  runs. The gate extends an existing, deliberate trade — it does not introduce
  a new class of blindness.
- Escape hatch: `--diff-keep-threshold 0` (CLI) / `diffKeepThreshold: 0`
  (Action) disables the gate; `--relevance-threshold 0` disables retrieval and
  gating together.
