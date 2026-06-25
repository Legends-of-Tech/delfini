# Doc-Section-Sharded Diff Analysis (multi-prompt drift detection)

## Problem Statement
How might we analyze an arbitrarily large code diff across several budget-sized
prompts without breaking algorithm parity between the Skill and the Action?

## Context (why this is the unhandled axis)
Today `buildPromptWithDrops` (`packages/drift-engine/src/prompt-builder.ts`) only
ever trims the **doc** side — relevance scoring, section retrieval, and ranked-fill
all operate on `docs[]`. The **diff** is spliced in whole via `{{diff}}` and is
mandatory. So when `local-prepare` (`packages/cli/src/commands/local-prepare.ts:312`)
hits the budget gate, exit 4 is reserved for "the non-doc payload alone exceeds
budget" — and the non-doc payload *is* the diff. The only advice the system can give
is the dead-end one it prints: "split the PR, or shrink the diff." The diff is the
real ceiling, and it is the one axis with no relevance/budget machinery.

## The hard truth that shapes the design
"Chunk the diff" + "preserve every cross-file finding" + "diff exceeds budget" is
**mathematically impossible** in the worst case: if a single finding's coupled hunks
(across files) jointly exceed one prompt budget, no chunking scheme can co-locate
them. So the deliverable is not "preserve every finding" — it is the strongest
*provable, testable* preservation invariant, plus loud surfacing of the cases that
violate it.

This eliminates the "keep diff whole, shard by doc" option: it is the only scheme
that trivially preserves every cross-file finding (every prompt sees the whole diff),
but it dies the moment the diff exceeds budget — which is the stated problem.

## Recommended Direction
Make the **doc section** the unit of analysis. Every finding is doc-anchored
(`Contradiction.targetDocPath`/`targetSection`, `Addition.anchorSection`), so a
cross-file finding is N hunks across N files that jointly contradict **one** doc
section. Make the section the magnet that pulls coupled hunks to it.

A new pure drift-engine function `planPrompts(input, options): Prompt[]` scores each
diff hunk against each doc section (reusing `relevance.ts`), then bin-packs
(doc-section + all hunks relevant to it) into budget-sized prompts via the existing
`rankedFillSections`. `buildPrompt` is untouched; `planPrompts` returns exactly
today's single prompt when everything fits one bin — so `prompt-snapshot.test.ts`
stays green and the default path is byte-identical (NFR44/FR139 preserved). Merge +
reconcile move into drift-engine, so both surfaces share them and parity is
*strengthened*, not risked.

The honest, provable invariant we ship — not the impossible "every finding":

  > For any doc section S, all hunks the router assigns to S are analyzed in one
  > prompt. Any cross-file finding anchored to S whose hunks the router co-assigns
  > to S is preserved. Cases where S's relevant hunks alone exceed one budget are
  > surfaced loudly, never silently dropped.

## Key Assumptions to Validate
- [x] **Router recall (load-bearing bet):** VALIDATED on the 3 ground-truth
      fixtures + a hand-built cross-file case (see Spike Results). The
      deterministic scorer linked the correct contradicting hunk to each
      ground-truth section (3/3), and co-located both files of a genuine
      cross-file finding into one chunk at every budget. Caveat: small corpus;
      no fixture exercises a hunk that contradicts a section while sharing no
      identifiers/paths with it — that recall hole is unmeasured.
- [!] **Single-section-over-budget frequency:** the failure mode is REACHABLE,
      not hypothetical. When many hunks are relevant to the SAME section,
      section-atomic chunking cannot split them, producing an unsplittable
      over-budget chunk (spike Pass 3: maxChunkTok 12096 vs budget 1500). This is
      the realistic "big refactor of one subsystem documented in one section"
      case. Frequency on real PRs still unknown — but the design MUST handle it.
- [ ] **Merge correctness:** dedup key (targetDocPath, targetLineStart,
      targetLineEnd) actually collapses the same finding seen by two chunks.
      Not exercised by the spike (no LLM in the loop) — still open.

## Spike Results (2026-06-20)
Throwaway harness: `packages/drift-engine/scripts/spike-chunk-recall.ts`
(prototype `planPrompts` reusing the real `scoreDocRelevance` /
`splitIntoSections`; run via `node --import tsx`). Two findings, one green, one red:

**GREEN — the core thesis holds.** A cross-file finding anchored to ONE doc
section is preserved by construction. Pass 4 (one `## Session Tokens` section
that `issuer.ts` and `validator.ts` jointly contradict): both hunks co-located
in one chunk at budget 150k, 300, AND 120 — the section is the magnet, exactly
as designed. Routing recall on the 3 committed ground-truth fixtures: the scorer
identified the right contradicting hunk every time (`src/utils/format.ts` s=28,
`src/payments/processor.ts` s=40, etc.). No ground-truth finding was lost to
chunking.

**RED — the section-as-atom has a hard over-budget wall.** When one section is
relevant to more diff than fits a budget, chunking by section CANNOT help: a
section is atomic, so its hunks can't spread across chunks, and you get an
over-budget chunk (Pass 3: case-01 diff x100 → every chunk 12096 tok against a
1500 budget; GT AT-RISK). Resolving this requires INTRA-section hunk-splitting —
and that is precisely the point where "preserve every cross-file finding" becomes
mathematically impossible (two coupled hunks for one section, but the section's
hunks don't all fit one budget). The spike turns the one-pager's predicted
impossibility case from theory into a reproduced failure.

**Design consequence:** `planPrompts` needs a documented two-level policy —
(1) pack section work-items into budget-sized chunks (handles the common case,
preserves cross-file findings per section); (2) when a SINGLE section's hunks
exceed budget, sub-split those hunks across prompts carrying the same section,
and emit a LOUD structured signal that cross-file findings within that section
may be split (the testable-invariant downgrade, never a silent drop).

**Caveats on the evidence:** the token-efficiency fixtures have small diffs
(132–2903 tok), so they barely force chunking; the inflate-stress is synthetic.
The validation gap they left — a real multi-file PR with a *labeled* cross-file
finding — is now closed by a committed fixture (below).

### Cross-file stress fixture (`__tests__/fixtures/cross-file/case-01-session-ttl`)
Generated by `scripts/gen-cross-file-fixture.ts` (throwaway); a realistic
session-auth PR carrying all three structures, each labeled in `expected.json`:
a genuine cross-file finding (`issuer.ts` bumps TTL to 7200 while `validator.ts`
still enforces 3600 — the `## Session Tokens` section says they MUST agree at
3600; visible only across both files), a concentrated 10-file `SessionToken →
SessionTicket` rename all routing to that one section, and spread findings on
other sections. Spike Pass 4 against it:

| budget | N | cross-file | anchor over-budget | note |
|--------|---|-----------|--------------------|------|
| 150000 | 1 | CO-LOCATED | no | fits one prompt = today's behaviour |
| 5000   | 1 | CO-LOCATED | no | anchor work-item is 1376 tok, fits |
| 1375   | 3 | CO-LOCATED | **YES (wall)** | section emitted as one oversized overflow chunk |

The precise tradeoff, now empirically pinned: at the wall the prototype keeps the
cross-file finding together by letting the anchor chunk **exceed budget** — i.e.
you can have at most two of {respect budget, preserve cross-file finding, chunk a
concentrated section}. A budget-respecting variant must sub-split the section's
hunks and so MAY split a cross-file finding — exactly the impossibility, made
concrete. The true contributing files score highest (validator 40, issuer 25),
so cross-file RECALL is robust — the finding is never the thing dropped first.

### New design lever — routing precision (path-token over-linking)
All 14 changed files linked to `## Session Tokens`, including `rate-limit.ts`
(score 6) which shares no domain identifiers with it. Cause (verified against the
REAL `scoreDocRelevance`): `extractIdentifiers` accepts the generic path segments
`src` and `auth`, and `scoreIdentifierOverlap` substring-matches them against the
section's cited `src/auth/...` paths (+3 each). So any section that cites file
paths over-attracts every file under those paths. Benign for recall (true files
score far higher) but it inflates concentration and makes the over-budget wall
hit sooner. Lever: use a HIGHER link threshold for the diff→section join than the
doc→section retrieval threshold, and/or down-weight generic path segments. This
is a precision knob the design should expose, not a blocker.

## MVP Scope
IN:  `planPrompts()` in drift-engine (N=1 => byte-identical to `buildPrompt`);
     per-hunk relevance routing; budget bin-packing of section+hunks; merge +
     dedup + reconcile in drift-engine; SKILL.md bounded dispatch loop with
     per-chunk retry; loud structured signal for over-budget sections.
OUT: compressed-global-context two-phase map-reduce; non-doc-anchored cross-doc
     findings; any LLM in the routing stage (stays deterministic/pure).

## Not Doing (and Why)
- **Naive diff bin-packing** (split on `^diff --git`) — throws away the relevance
  signal already built and re-sends all docs N times.
- **Keep-diff-whole / shard-by-doc** — trivially preserves cross-file findings but
  fails the moment the diff exceeds budget (the stated problem). Eliminated.
- **Two-phase compressed-context map-reduce** — 3x the machinery (compression format,
  coupling graph, harder parity story) for the tail of the tail. Earn it with recall
  evidence; keep it as a fallback escape hatch, do not pre-build it.
- **Promising "every cross-file finding"** — mathematically impossible once a single
  finding's coupled hunks exceed one budget. Ship a precise, testable invariant and
  surface violations loudly instead.

## Open Questions
- Fan-out cap vs. truly unbounded: unbounded N means unbounded host-agent tokens /
  provider cost per run — do we want a soft warning above some N?
- Per-chunk retry vs. whole-batch retry on schema failure — and how that interacts
  with the existing two-attempt cap in SKILL.md.
- Does the Action's LangChain orchestrator dispatch chunks concurrently (latency) or
  serially (rate-limit safety)?
