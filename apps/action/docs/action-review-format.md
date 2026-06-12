# Delfini Action — Review Body Format (Canonical Contract)

## Purpose

This document describes the byte-strict review-body format the Delfini GitHub Action emits, consumed by Phase 2's webhook ingestion handler at [`apps/web/src/server/reviews/handle-pull-request-review.ts`](../../../apps/web/src/server/reviews/handle-pull-request-review.ts) and parsed at [`apps/web/src/server/reviews/parse-narrative-suggestions.ts`](../../../apps/web/src/server/reviews/parse-narrative-suggestions.ts).

The format is **enforced in code** by the round-trip parser-contract test at [`apps/action/src/__tests__/comment-formatter.test.ts`](../src/__tests__/comment-formatter.test.ts), which inlines the seven Story 4.1 parser regexes verbatim. **This document is descriptive — when this doc and the test disagree, the test wins.** Anyone editing this doc should also re-run the test (or update it if the change is intentional).

## Body-prefix markers

The Action emits four top-level body shapes. The first line of each body is a byte-strict marker (em-dash U+2014) that drives Phase 2 routing.

| Body prefix (first line) | Review event | Phase 2 handling |
|---|---|---|
| `## Delfini — Contradictions Detected` | `REQUEST_CHANGES` | ingest as `review_requests` + `proposed_doc_changes` rows |
| `## Delfini — PASS` | `APPROVE` | resolve any prior `pending` `proposed_doc_changes` rows |
| `## Delfini — PASS (Smart-skipped)` | `APPROVE` | same as PASS — no contradictions to consume |
| `## Delfini — Unable to Complete Analysis` | `COMMENT` | **silently ignored** (Story 4.1 matcher requires Contradictions or PASS prefix) |

The dash character in every header is **em-dash U+2014**, not hyphen-minus `-`. Both Story 3.1's formatter and Story 4.1's matcher are byte-strict here.

## Review-event mapping

The disposition flag (`hasContradictions: boolean`) the Action computes from the pipeline's resolved output drives the GitHub review event:

| `output.conclusion` | `hasContradictions` | Path | Review event |
|---|---|---|---|
| `success` (PASS or smart-skip) | `false` | `postOrUpdateReview` | `APPROVE` (fresh per re-run — no idempotency lookup) |
| `failure` (required-mode contradictions) | `true` | `postOrUpdateReview` | `REQUEST_CHANGES` (idempotent — see below) |
| `neutral` (warning-mode contradictions) | `true` | `postOrUpdateReview` | `REQUEST_CHANGES` (idempotent — see below) |
| `neutral` (orchestrator error / unable-to-complete) | n/a | `postReviewComment` | `COMMENT` (no idempotency) |

The warning-vs-required distinction lives in the GitHub check status conclusion, NOT the review event — both modes post a Request Changes review with the same body bytes.

## Per-contradiction block format

Each `## Delfini — Contradictions Detected` body contains numbered blocks, one per contradiction. The block layout is byte-strict and tested against Phase 2 Story 4.1's parser.

```markdown
### N. {targetDocPath} — {targetSection}

**Severity:** High|Medium|Low

**What changed in this PR:** {whatChanged value, free text, single line or wrapped paragraph}

**What contradicts:** {whatContradicts value, free text}

**Target doc:** {targetDocPath}

**Target section:** {targetSection} (lines {targetLineStart}–{targetLineEnd})

**Proposed replacement:**

```
{proposed replacement text — plain triple-backtick fence, NO `suggestion` language tag}
```
```

### Character-level constraints

These distinctions are byte-strict and easy to break with copy-paste:

- **Heading line `### N. {path} — {section}`** — em-dash **U+2014** between path and section
- **Top-level `## Delfini — …` headers** — em-dash **U+2014**
- **Line range `(lines N–M)`** — en-dash **U+2013** (Story 4.1's parser tolerates hyphen-minus as a fallback, but the canonical contract is U+2013)
- **Proposed-replacement fence** — plain triple backticks ```` ``` ```` with **NO `suggestion` language tag**. The `suggestion` tag would trigger GitHub's "Commit suggestion" one-click button, which only works on lines in the PR diff — source-of-truth docs typically aren't in a code-only PR per FR88a.
- **Label-value pattern** — `**Label:** value` on a **single line**, NOT label-then-newline-then-value. Story 4.1's `WHAT_CHANGED_RE` / `WHAT_CONTRADICTS_RE` lookaheads terminate at the next bold-uppercase header; splitting label and value across lines risks the lookahead truncating the field if the value contains a paragraph break followed by another bold header.

### Narrative-only contradictions

When the LLM cannot determine a concrete replacement (e.g., the contradiction is debatable and the doc owner should choose the wording), the block omits the `**Proposed replacement:**` field and the entire fence. The block ends at the `**Target section:** … (lines N–M)` line. Story 4.1's parser detects narrative-only by the absence of the fence and stores `proposed_replacement = null`. Story 4.6's Approve action is disabled for narrative-only rows (no replacement text to commit).

Do **not** emit `**Proposed replacement:** _(none)_` or any placeholder — the parser treats the absence of the fence as the signal.

### Field order

The canonical block order is: `Severity → What changed in this PR → What contradicts → Target doc → Target section → Proposed replacement`. Story 4.1's parser uses per-field regexes (positional order is not strictly enforced), but emitting the canonical order keeps the block human-readable and matches the parser's tested-against ordering.

## Idempotency contract (Request Changes path)

The Action posts at most ONE Request Changes review per PR; subsequent re-runs that detect contradictions update the existing review's body in place rather than creating a new one. The lookup uses three filters applied to `pulls.listReviews`:

1. `review.user?.type === 'Bot'` — the Action is its own bot identity inside its own runner; the only `Bot`-type reviews on a single PR are its own
2. `review.state === 'CHANGES_REQUESTED'` — `pulls.listReviews` returns ALL reviews including past Approves and Comments. This filter excludes a prior Delfini Approve whose body could otherwise spuriously match the prefix on a regression
3. `review.body.startsWith('## Delfini — Contradictions Detected')` — em-dash U+2014, byte-strict; declared as a module-level `const REQUEST_CHANGES_PREFIX` in [`apps/action/src/github-client.ts`](../src/github-client.ts)

Note: GitHub's `pulls.listReviews` returns past-tense `state` (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, ...), NOT the original `event` enum (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`). Don't confuse the two.

### Why the Action's bot-identity check is looser than Story 4.1's

Story 4.1's webhook handler at [`handle-pull-request-review.ts`](../../../apps/web/src/server/reviews/handle-pull-request-review.ts) does an additional login check (`review.user.login.toLowerCase() === \`${GITHUB_APP_SLUG}[bot]\`.toLowerCase()`). That's defensive — the webhook handler runs in a multi-tenant web app where any bot could post on a watched PR; it must not falsely ingest a non-Delfini review.

The Action runs **inside the repo's own GitHub Actions runner** with a token whose identity is the Action installation itself. The `pulls.listReviews` lookup is scoped to a single PR; the only `Bot`-type reviews could be the Action's own. The `state` + body-prefix filters are sufficient. Adding a login-string check would require introducing `GITHUB_APP_SLUG` to the Action's env, which it does not currently consume.

### Approve path is fresh per re-run

The Approve path (`hasContradictions === false`) does **not** use the idempotency lookup — every clean re-run creates a fresh Approve review. FR89's "fresh Approve review on clean re-run" is intentional: each clean pass is a distinct audit-trail event tied to its `commit_id` (which the Action sets explicitly to `ctx.headSha` on every `createReview` call so Story 4.1 ingests the correct `head_commit_sha`).

Multiple Delfini Approve reviews may accumulate over a PR's lifecycle. This is correct behaviour, not a bug.

### Page-1 lookup limit

The idempotency lookup reads only the first 100 reviews (`per_page: 100`, single page). If a PR ever has >100 reviews, the prior Delfini Request Changes review may land beyond the first page and the lookup will falsely conclude "no prior exists" → create a duplicate. The Action emits a `core.warning` if the page is full so the operator can detect this empirically:

```
Delfini: review list capped at 100 — idempotency may misfire on this PR.
```

Pagination is not added preemptively. If real-world PRs trigger this warning, revisit then.

## Source of truth (the test, not this doc)

If you're editing this document, also update / re-run [`apps/action/src/__tests__/comment-formatter.test.ts`](../src/__tests__/comment-formatter.test.ts). The seven regexes in that test (copied verbatim from [`apps/web/src/server/reviews/parse-narrative-suggestions.ts`](../../../apps/web/src/server/reviews/parse-narrative-suggestions.ts) lines 18–27) are the authoritative contract surface. Drift on either side fails the test before it ships.

For the broader sequencing rationale (why this primitive lives in Story 3.6, why the spec is descriptive rather than prescriptive, why Phase 1 ↔ Phase 2 contract enforcement is byte-level), see [`temp/DIRECTION.md`](../../../temp/DIRECTION.md).

## What Phase 2's parser tolerates

Beyond the byte-strict contract above, Story 4.1's parser is intentionally lenient on a few axes so minor formatting drift doesn't fail ingestion:

- **Line range separator** — both en-dash `–` (U+2013, the contract) and hyphen-minus `-` are accepted in `(lines N–M)`. Emit U+2013.
- **Spacing after `**Label:**`** — `\s*` is the matcher, so any whitespace (or none) is fine. Emit a single space.
- **Field order** — per-field regexes; positional order is not strictly enforced. Emit the canonical order anyway.
- **Optional Proposed replacement** — narrative-only contradictions yield `proposed_replacement = null`.
- **Hard-required fields** — `**Severity:**`, `**Target doc:**`, `**Target section:**` with parseable `(lines N–M)` parenthetical. Missing any of these → `parse_error` in Story 4.1's UI.
