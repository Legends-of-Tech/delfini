# Symmetric Retrieval — always-on diff-side gating (first-run token diet)

## Problem Statement
How might we cut the Skill path's **first-run** token spend ≥5× on a typical repo
without regressing finding recall on the ground-truth fixtures?

## Context (why the first run is the unhandled axis)
The driving complaint is real and specific: "my first `/delfini` on a big branch ate
200k tokens" — on the **Skill path**, where every token is the user's Claude Code
subscription. We control nothing model-side there (no `cache_control`, no model
routing of the API call); the only levers are prompt size and run avoidance.

Anatomy of the spend today:

- **Docs** already have default-on retrieval at both call sites (threshold 5 /
  NFR49, ranked-fill at 150k — `packages/cli/src/commands/local-prepare.ts:69-92`),
  a measured ~40% reduction.
- **The diff is sent whole** whenever the assembled prompt fits the 150k budget.
  Hunk→section routing with unlinked-hunk dropping EXISTS
  (`packages/drift-engine/src/prompt-planner.ts`, `droppedHunkFilePaths` —
  "reported, never silent") — but only fires on the over-budget path. Under 150k
  the fast path returns the whole prompt byte-identical.
- **The template** (`packages/drift-engine/src/prompt.md`) is ~360 lines ≈ 5k
  tokens, ~180 of them examples, re-sent on every call and every chunk.

So a ~140k big-branch run is precisely the worst case: too small to trigger
routing, big enough to hurt. The machinery that fixes the complaint is already
written and tested — it is gated behind the wrong condition.

## Recommended Direction
Make hunk→section routing the **default input-assembly step**, not an over-budget
fallback — the same NFR49(b) call-site pattern as the doc-side threshold: gate at
the CLI + action-core consumers, canonical `buildPrompt` untouched, NFR44 snapshot
parity preserved by construction.

1. **Always-on diff-side gating.** Route every hunk via the existing scorer
   (`relevance.ts` / `buildWorkItems`). Unlinked hunks are dropped with the
   existing loud report. A **structural keep-list** (new files, dependency-manifest
   changes, new exported symbols) preserves the inputs additive findings need.
2. **Tiered hunk context.** Strongly-linked hunks keep full context (U3);
   weakly-linked hunks are trimmed to U1/U0 — the middle ground between drop and
   keep, so borderline hunks stay visible at reduced cost.
3. **Template diet.** `prompt.md` 5k → ~2k tokens (compress five examples to 2-3,
   terse rule tables) as a **versioned prompt bump** with every parity gate moving
   in lockstep.
4. **Token-breakdown observability.** A per-run template/docs/diff split line in
   `local-prepare` output. Ships first: it verifies the spend anatomy, lets users
   self-diagnose, and is complaint telemetry for free.

Napkin math on the complaint scenario: 140k prompt → gating drops 60-80% of hunks
on a typical big refactor, tiered context trims survivors ~30%, template −3k →
**~25-45k total ≈ 4-6× on run #1**. The drift ledger (fast-follow, below) covers
every run after.

## Key Assumptions to Validate
- [ ] **Load-bearing bet — contradicting hunks share lexical signal with their
      sections.** The multi-prompt spike flagged this recall hole as *unmeasured*
      (a hunk contradicting a section while sharing no identifiers/paths).
      Always-on gating turns that soft gap into silent missed findings on the
      default path. Test: a labeled fixture with zero identifier/path overlap
      between the contradicting hunk and its section — built and measured
      **before** the default flips. (Multi-prompt mode already makes this exact
      bet, but only for over-budget runs.)
- [ ] **Big-branch hunks are mostly unlinked.** Deterministic, no LLM: run the
      router over a handful of real big PRs and report the dropped fraction —
      the go/no-go number and the marketing number. Known threat: path-token
      over-linking (generic segments like `src`/`auth` attract every file —
      documented in the multi-prompt design). Mitigation is the precision lever,
      not an optional extra: down-weight generic path segments and use a higher
      keep/drop threshold than the chunk-routing threshold.
- [ ] **The structural keep-list bounds additive-recall loss.** Unlinked hunks are
      where gap findings live (a new `@sentry/node` import matches no section
      lexically). Additions are already precision-over-recall posture; a bounded,
      documented loss is defensible — an unbounded one is not.
- [ ] **The slim template holds recall.** The examples encode the multi-location /
      disjoint-range behaviors; the ground-truth + cross-file fixtures decide how
      far the diet can go.
- [ ] **The 200k anatomy is mostly diff.** Verified by the observability line on
      real complaint repos before deeper investment.

## MVP Scope
IN:  token-breakdown line in `local-prepare`; always-on hunk routing at both call
     sites (keep-list + loud drop report); tiered-context rendering; slim template
     behind a versioned bump with parity gates in lockstep; the
     lexically-invisible-contradiction fixture; a deterministic savings-measurement
     script over sample big PRs.
OUT: everything under Not Doing; the drift ledger (fast-follow, separately scoped).

## Fast-follow (drift ledger — runs #2..#N)
The dev who just paid for run #1 will fix docs and re-run to verify — and today
re-pays in full. Section-granular incremental re-analysis: hash each
(section content × linked-hunk set); unchanged pairs replay their prior reconciled
findings through `mergeAnalysisResults`; only changed sections re-enter the prompt.
Degenerate case ships first: **zero-token re-run** when no changed hunk links to
any section. `--no-ledger` escape hatch; a fixture proves that mutating one hunk
re-enters exactly one section. Does not touch run #1 — ships second.

## Not Doing (and Why)
- **Compressed-context funnel / two-phase map-reduce** — deferred again. Stage 1
  must still ingest the whole diff in some form, its recall on compressed input is
  unproven, and it adds a serial LLM stage plus a second prompt held in
  Skill/Action parity. It earns its keep only if this design's measured ceiling
  disappoints.
- **Prompt caching** — no control over subagent calls on the Skill path; the
  cache-repriced "docs-whole / diff-shard" chunking variant dies with it.
- **Output-token optimization** — ~2% of the problem.
- **Haiku subagent routing** — orthogonal one-afternoon experiment that stacks
  with everything here; not on this design's critical path.
- **Promising zero recall loss** — dropping content can always drop a finding in
  the worst case. As with multi-prompt chunking, the deliverable is a precise,
  testable invariant (linked hunks always analyzed; drops always reported loudly)
  plus fixtures that pin the measured loss at zero on ground truth.

## Open Questions
- One relevance knob or two? The keep/drop threshold likely wants to sit above the
  chunk-routing threshold (precision lever) — separate flags or one with a
  multiplier?
- Where do dropped-hunk reports surface — Skill stderr + trace artifact only, or
  also the Action's PR comment as a footnote?
- Does tiered context (U1/U0 re-emission) interact with `diff-hunks.ts` subset
  re-emission, which currently assumes hunks pass through verbatim?
- Ledger invalidation keys: content hashes only, or do line-number shifts without
  content change need normalizing first?
