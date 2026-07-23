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
  multiplier? → **Resolved (v1): two knobs, `--diff-keep-threshold` defaulting to
  the effective `--relevance-threshold`** (see Implementation Spec).
- Where do dropped-hunk reports surface — Skill stderr + trace artifact only, or
  also the Action's PR comment as a footnote? → **Resolved (v1): Skill stderr +
  `_diffGateResult` trace sibling; Action `core.warning`.** PR-comment footnote
  deferred.
- Does tiered context (U1/U0 re-emission) interact with `diff-hunks.ts` subset
  re-emission, which currently assumes hunks pass through verbatim? → **Resolved
  (v1): the gate rewrites hunk header + body BEFORE re-emission, so downstream
  parsers see a self-consistent diff; interior context runs are left untouched
  (lead/trail trim only) to avoid sub-hunk splitting.**
- Ledger invalidation keys: content hashes only, or do line-number shifts without
  content change need normalizing first? (Open — ledger is the fast-follow.)

---

# Implementation Spec (v1) — always-on diff-side gating

Design anchor for the feature branch `feat/symmetric-diff-gating`. Follows the
NFR49(b) call-site pattern throughout: **the canonical `buildPrompt` default path
is untouched**, all three NFR44 snapshot gates stay byte-identical, and the
default flips only at the two consumer call-sites (CLI flag layer + Action
orchestrator constants).

## 1. drift-engine: `src/diff-gate.ts` (pure, FR139 charter)

```ts
export interface DiffGateOptions {
  sectionThreshold: number   // retained-section universe (same signal as relevanceThreshold)
  keepThreshold: number      // per-hunk keep bar; <=0 → gate inactive
  strongMultiplier?: number  // default 4 — maxScore >= keepThreshold*4 keeps full context
  contextRadius?: number     // default 1 — context lines kept per side on weak hunks
}
export type GateKeepReason =
  | 'linked-strong' | 'linked-weak' | 'doc-in-scope' | 'new-file' | 'dependency-manifest'
export interface DiffGateResult {
  keptDiff: string           // === input diff verbatim when !active
  active: boolean
  inactiveReason?: 'no-threshold' | 'no-docs' | 'no-hunks' | 'no-sections' | 'all-dropped'
  keptByReason: Record<GateKeepReason, number>
  droppedHunks: { filePath: string; hunkHeader: string; maxScore: number }[]
  trimmedHunkCount: number
  contextLinesRemoved: number
}
export function gateDiffByRelevance(
  diff: string, docs: DocFile[], options: DiffGateOptions,
): DiffGateResult
```

Behaviour:
1. **Universe** — every doc's `selectRelevantSections(doc, diff, sectionThreshold).kept`,
   scored against the FULL pre-gate diff (mirrors `planPrompts` routing exactly).
2. **Per-hunk score** — `scoreSectionAgainstHunk` (extracted from
   `prompt-planner.ts` into `relevance.ts`, the declared scoring source of truth;
   the planner imports it back — no third mirrored copy). `maxScore` = max over
   the universe. Hunks score on their full text (header + body incl. context) —
   planner-identical.
3. **Keep decision**, first matching reason wins:
   `doc-in-scope` (filePath ∈ docs[].path — the prompt contract requires doc
   edits visible in the diff) → `new-file` (`new file mode` in fileHeader, or
   `--- /dev/null` for `--no-index` untracked renders) → `dependency-manifest`
   (basename ∈ small fixed set: package.json, Cargo.toml, go.mod, pyproject.toml,
   requirements.txt, Gemfile, composer.json, pom.xml, build.gradle(.kts),
   deno.json) → `linked-strong` (maxScore ≥ keepThreshold×strongMultiplier) →
   `linked-weak` (maxScore ≥ keepThreshold) → dropped.
   Keep-list + strong hunks keep full context; weak hunks get the context trim.
4. **Context trim (weak hunks)** — leading/trailing context lines cut to
   `contextRadius`; interior context runs untouched (v1: no sub-hunk splitting);
   a trailing context line immediately followed by a `\ No newline` marker is
   never trimmed; `@@ -a,b +c,d @@` header recomputed (starts advance by the
   leading trim; counts shrink by both trims; post-`@@` context text preserved).
   Changed (`+`/`-`) lines are NEVER trimmed.
5. **Inactive (verbatim pass-through)** when: keepThreshold ≤ 0 / non-finite;
   sectionThreshold ≤ 0; docs empty; zero parsed hunks; empty universe; or the
   decision would keep ZERO hunks (`all-dropped`) — the gate never emits an
   empty diff (mirrors the planner's degenerate-case safety).
6. Re-emission via `renderHunksAsDiff` on the (possibly rewritten) kept hunks —
   file order first-seen, hunk order preserved, `keptDiff` re-parseable by
   `parseDiffHunks`. Rename/mode-only file headers (zero hunks) drop when the
   gate is active — same documented v1 limitation as the planner.
7. Deterministic; no new runtime dep; exported from the barrel.

Known accepted corner: a weak hunk whose ONLY lexical link to its section lives
in trimmed context lines can cause that section to fall out of the post-gate
doc-side retrieval. Changed lines are never trimmed, so contradiction *evidence*
survives; only the retrieval *signal* can weaken. Documented, not defended — the
lexically-invisible fixture covers the general class.

## 2. CLI (`local-prepare`)

- New pass-through option `diffKeepThreshold?: number`; new flag
  `--diff-keep-threshold <n>` (0 disables). The cli.ts handler resolves the
  default: `opts.diffKeepThreshold ?? opts.relevanceThreshold` — so real runs
  gate at 5 by default, while direct `runLocalPrepare` callers (tests) see no
  behaviour change unless they opt in (NFR49(b) discipline).
- Gate call-site: after docs are read, before input assembly. Active only when
  BOTH thresholds are positive. Post-gate, doc-side retrieval scores sections
  against the GATED diff — deliberate compounding.
- Stderr (only when active and something was dropped/trimmed):
  `diff gate: dropped H unrelated hunk(s) in F file(s), trimmed context on K hunk(s)`
- Trace sibling `_diffGateResult` (additive; ABSENT when the gate did not fire —
  AC6 absent-key discipline): `{ keepThreshold, keptByReason, droppedHunks,
  trimmedHunkCount, contextLinesRemoved }`.
- **Token-breakdown observability line** on every single-prompt success:
  `prompt ≈ 37.4k tokens (docs ≈ 21.0k, diff ≈ 11.2k, template ≈ 5.2k)` —
  computed CLI-side from three auxiliary `buildPrompt` renders (empty-docs /
  empty-diff variants); no new engine API.

## 3. action-core (`SingleCallOrchestrator`)

- Constants `ANALYSIS_DIFF_KEEP_THRESHOLD = 5` (lockstep with the CLI default,
  same duplication note as the existing budget/threshold constants);
  constructor option `diffKeepThreshold` for tests/operators.
- `analyze()` gates `input.diff` FIRST (sectionThreshold = existing
  ANALYSIS_RELEVANCE_THRESHOLD), then runs the unchanged fast-path/split flow on
  the gated input. Reconciliation still uses the full `input.docs`.
- `core.warning` when hunks were dropped. Gate decisions are pure + constants
  are lockstep ⇒ both surfaces gate identically on identical input (parity).

## 4. Tests & fixtures

- `drift-engine/__tests__/diff-gate.test.ts` — inactive reasons, each keep
  reason, drop, trim mechanics (header recompute, `\ No newline` guard,
  round-trip `parseDiffHunks`), all-dropped guard, determinism.
- `fixtures/lexically-invisible/case-01-paraphrase/` — a real contradiction
  whose hunk shares ZERO identifiers/paths with the doc section. Test asserts
  the gate DROPS it at default thresholds (the documented, accepted recall
  hole — the load-bearing bet, now pinned by a fixture) and that
  `keepThreshold 0` keeps it (escape hatch).
- Cross-file survival — `cross-file/case-01-session-ttl` hunks (`issuer.ts`,
  `validator.ts`) must be KEPT by the gate at defaults (scores 25/40 ≫ 5).
- CLI: gate wiring (drop + trace + stderr), pass-through default unchanged,
  flag-default resolution. action-core: fake-model prompt excludes dropped hunk;
  ctor opt-out keeps it.
- Gates A/B-lite/C untouched by construction (no `buildPrompt` change).

## 5. Measurement script (deterministic, no LLM)

`packages/drift-engine/scripts/measure-diff-gate.ts` — feed an
`analysis-input.json` (or `--diff` + docs dir), print kept/trimmed/dropped hunk
counts by reason and estimated prompt tokens before/after (whole prompt +
diff-side only). The go/no-go number for assumption 2, runnable on any repo.

## 6. Out of scope (v1)

Interior-context sub-hunk splitting; generic-path-segment down-weighting (knob
documented, not built); template diet (needs LLM eval evidence — separate,
prompt-versioned change); drift ledger (fast-follow); PR-comment drop footnote.
