---
name: delfini
description: Local drift detection between code changes and project docs — invoke on /delfini or on create-PR intent.
protocol-version: 1
---

# Delfini Skill — host-agent protocol

This file is the protocol the host coding agent follows when `/delfini` is invoked. Branch on CLI exit codes exactly as specified.

The CLI never calls an LLM. The only LLM dispatch in this protocol is the analysis dispatch under "Dispatch analysis" (and its single retry, under "Retry on schema-validation failure"), via the host agent's `Agent` tool against a Claude subagent that uses the host agent's existing tokens.

## Output discipline

Two things — and only these two — reach the user as host-agent chat text during a `/delfini` run:

1. The verbatim contents of `.delfini-trace/report.md` when findings exist.
2. The single Apply / Pick / Skip prompt (carrying a one-line digest as its question text), and the single-line outcome after the user answers.

What never reaches the user:

- **Step narration.** Do not say "Step N", "Per Step N of the protocol", "running `local-prepare`", "dispatching the subagent", "now running `local-finalize`". Tool calls already render as tool-use cards in the UI — narrating them in chat is duplication that drowns out the report.
- **Report summaries.** Never collapse the report into a one-sentence preview like "Drift detected — 5 findings in `docs/...`". The report itself IS the decision context; summarising it strips the severity, line ranges, quoted text, and proposed replacements the user needs to choose Apply vs Skip.
- **Internal protocol vocabulary.** "Step 7", "Step 8", "the protocol", "per the SKILL.md" — internal scaffolding the user did not ask to see. Replace with silent execution.

The section headings below (`## Ensure CLI is available`, `## Run prepare`, etc.) name what the host agent does — not what the host agent narrates. Execute them silently.

## Ensure CLI is available

Run `delfini --version`. If the command resolves and prints a version, continue.

If `delfini` is not on PATH:

1. **First, probe for a local install** before prompting the user. A repo may have `@delfini/cli` as a workspace dependency even when the global binary is absent. Try, in order:
   - `pnpm exec delfini --version`
   - `npx --no-install delfini --version` (the `--no-install` flag prevents npx from silently fetching from the registry — it only resolves a binary that already exists in the local `node_modules`)

   If either resolves and prints a version, use that invocation form (`pnpm exec delfini …` or `npx --no-install delfini …`) for every `delfini` invocation in the remaining steps, and continue. Do not prompt the user.

2. If no local install is found, ask the user: "Install `@delfini/cli` globally with `npm i -g @delfini/cli`? (y/n)"
3. On `y` → run `npm i -g @delfini/cli`, then re-verify with `delfini --version`.
4. On `n` or on install failure → fall back to `npx @delfini/cli` for the rest of this session. Substitute `npx @delfini/cli` for every `delfini` invocation in the remaining steps.

## Load config

Read `.claude/skills/delfini/delfini-config.json` (the committed, team-shared Delfini config). For repos set up before the rename, also accept a legacy `.claude/skills/delfini/doc-scope.json` — the CLI reads it as a fallback and migrates it to `delfini-config.json` on the next config write.

The config shape (v1) is:

```json
{
  "version": 1,
  "doc_scope": ["docs/", "packages/*/README.md"],
  "ignore_code_scope": ["src/generated/**", "db/migrations/"]
}
```

- `doc_scope` — the source-of-truth docs Delfini analyses (directories scanned recursively for `.md`, single files, or globs).
- `ignore_code_scope` — **optional.** Code paths whose CHANGES Delfini ignores: a changed file matching any entry (directory, file, or glob — same dialect as `doc_scope`) is dropped from the analysed diff, as if it had not changed. Omit it (or leave it empty) to analyse all changed code.

If the file exists and its `doc_scope` is non-empty, parse it and continue.

If no config exists, **or the config exists but its `doc_scope` is empty** (the `delfini install` scaffold before it has been filled in), AND the user did not pass `--scope <paths>` to `/delfini`, prompt the user in a single turn:

> "No docs configured yet. Which docs should Delfini analyse? Provide one or more paths — directories (recursive `.md` scan), single files, or globs. Example: `docs/ specs/architecture.md packages/*/README.md`."

Validate each path the user supplies:

- Resolve each entry against `git rev-parse --show-toplevel`.
- Reject any path that resolves outside the repo root.
- For non-existent paths, warn the user but keep the path in scope (a teammate may have deleted a file in a different branch).

Write the validated scope to `.claude/skills/delfini/delfini-config.json` in the shape `{"version": 1, "doc_scope": [<paths>]}`. The file is committed to git — team-shared by construction. (`ignore_code_scope` is configured by hand-editing this file; the first-run prompt only seeds `doc_scope`.)

If the user passed `--scope <paths>` to `/delfini`, run that invocation against the override list without touching the persisted file. Likewise `--ignore-code-scope <paths>` overrides `ignore_code_scope` for a single run without modifying the file.

## Resolve the diff source

Run `delfini diff-status`. It prints a single line of JSON to stdout and exits `0`:

```json
{"branch":"<name>","isDefaultBranch":<bool>,"hasLocalChanges":<bool>,"hasCommittedChanges":<bool>}
```

On any non-zero exit, surface the command's stderr to the user and stop.

Parse the JSON and resolve the `--diff-source` value you will pass to `local-prepare`, using exactly this decision table:

- **`hasLocalChanges === false && hasCommittedChanges === false`** → there is nothing to analyse. Emit exactly one line and stop — do **not** run `local-prepare`, do **not** dispatch a subagent:

  > ✅ No changes since `origin/main` — nothing to analyse.

- **`isDefaultBranch === true`** → resolve to `local`. On the default branch the committed-vs-base range collapses by construction, so `committed` / `both` would equal `local` anyway.
- **`hasLocalChanges === true && hasCommittedChanges === false`** → resolve to `local`.
- **`hasLocalChanges === false && hasCommittedChanges === true`** → resolve to `committed`.
- **`hasLocalChanges === true && hasCommittedChanges === true`** on a feature branch → the resolution depends on how `/delfini` was invoked this run:
  - **create-PR auto-invocation** → resolve to `both` **silently**. An opened PR contains committed + uncommitted work, so the analysed diff must too. Do not prompt.
  - **manual `/delfini`** → ask the user in a single turn:

    > You have both uncommitted and committed changes. Analyse local (uncommitted) changes only, or local + committed (what the PR will contain)?

    Resolve to `local` for "uncommitted only" or `both` for "local + committed". Do not proceed until the user answers.

You learn whether this run is a **create-PR auto-invocation** from the `CLAUDE.md` auto-invoke block, not from this file — that block is what fires `/delfini` on create-PR intent and instructs you to resolve `both` silently in that path. A bare, user-typed `/delfini` is a manual invocation.

## Run prepare

Run `delfini local-prepare --diff-source <resolved>` (the value resolved in "Resolve the diff source"). On success (exit `0`), read the three output files written under `.delfini-trace/`:

- `.delfini-trace/analysis-input.json`
- `.delfini-trace/analysis-prompt.md`
- `.delfini-trace/schema.json`

**Check for a split run first.** If `.delfini-trace/chunks.json` exists, the diff was too large for one prompt and `local-prepare` split the analysis into several budget-sized prompts. In that case `analysis-prompt.md` is absent and you must follow "Multi-prompt mode" below instead of the single "Dispatch analysis" / "Run finalize" steps. When `chunks.json` is absent, proceed with the single-prompt steps as written.

Branch on non-zero exit codes:

- **Exit `2` (no doc-scope set AND no `--scope` provided)** → fall back to the "Load config" first-run prompt, write `delfini-config.json`, then re-run `delfini local-prepare --diff-source <resolved>`.
- **Exit `4` (non-doc prompt payload exceeds budget — diff + schema + instructions alone do not fit, or no doc section fits after ranked-fill)** → surface two options to the user:
  1. Re-invoke with a narrower scope: `/delfini --scope <narrower-paths>`.
  2. Split the PR into smaller changes.
  Do not continue.

  Note: retrieval is **on by default** (`--relevance-threshold 5`). Retained doc sections that exceed the prompt budget are ranked-filled (most-relevant-first) rather than hard-failed. The CLI then exits `0` with a `dropped N section(s) — over prompt budget` line on stderr; that path does **not** reach exit `4`. Exit `4` is reserved for the non-doc payload itself being over budget (or, under `--relevance-threshold 0`, an over-budget whole-doc prompt).
- **Any other non-zero exit** → surface the CLI's error output to the user and stop. Do not continue.

## Dispatch analysis

Dispatch a subagent via the host agent's `Agent` tool with these parameters:

- `model`: `'sonnet'` (or honour a `--model <id>` flag the user passed to `/delfini`).
- `subagent_type`: `'general-purpose'`.
- `description`: `'Delfini drift analysis'`.
- `prompt`: the full contents of `.delfini-trace/analysis-prompt.md`, followed by the full contents of `.delfini-trace/schema.json`, followed by the literal instruction: `write your JSON findings to .delfini-trace/findings.json`.

The subagent's only required side effect is writing `.delfini-trace/findings.json`. Do not ask the subagent to render a report, edit any source file, or post any commentary.

## Retry on schema-validation failure

After the analysis subagent completes, run `delfini local-finalize .delfini-trace/findings.json` (see "Run finalize"). If `local-finalize` exits with code `3` (schema validation failure):

1. Preserve the failing output: copy `.delfini-trace/findings.json` to `.delfini-trace/findings-attempt-1.json`.
2. Dispatch a **second** subagent via the host agent's `Agent` tool with the same parameters as "Dispatch analysis", but append the schema-validation error (from `local-finalize`'s stderr) to the prompt along with: `the previous attempt failed schema validation with the error above — fix and return valid JSON`.
3. Re-run `delfini local-finalize .delfini-trace/findings.json`.
4. If the second attempt also exits `3`: copy the failing output to `.delfini-trace/findings-attempt-2.json`, surface both raw outputs (`findings-attempt-1.json` and `findings-attempt-2.json`) plus the schema-validation error to the user, and stop. **No third try.**

Rationale: if a frontier model cannot satisfy the schema twice with the schema in hand, the prompt or the schema is broken. Debugging belongs upstream — do not paper over it with a third retry.

## Multi-prompt mode

This section REPLACES "Dispatch analysis", "Retry on schema-validation failure", and "Run finalize" when `.delfini-trace/chunks.json` is present (a large-diff split run). Everything else — "Surface the report", "Apply UX" — is identical.

Read `.delfini-trace/chunks.json`. It has the shape:

```json
{"version":1,"chunkCount":<N>,"prompts":["analysis-prompt-0.md", ...],"oversizedSections":[...],"droppedHunkFilePaths":[...]}
```

**Dispatch each chunk.** For each entry in `prompts` (index `k` = 0…N-1), dispatch a subagent via the host agent's `Agent` tool with the SAME parameters as single-prompt "Dispatch analysis" (`model` `'sonnet'` or a `--model` override, `subagent_type` `'general-purpose'`, `description` `'Delfini drift analysis'`), except:

- `prompt`: the full contents of `.delfini-trace/<prompts[k]>`, followed by the full contents of `.delfini-trace/schema.json`, followed by the literal instruction: `write your JSON findings to .delfini-trace/findings-<k>.json` (use the chunk's own index `k`).

Each subagent's only required side effect is writing its own `.delfini-trace/findings-<k>.json`. Dispatch all chunks before finalizing. If `oversizedSections` is non-empty, one or more chunks exceeded budget (a single doc section attracted more diff than fits one prompt) — dispatch them anyway; they are still within the model's context limit.

**Finalize the batch.** Run `delfini local-finalize .delfini-trace/` (pass the trace **directory**, not a single findings file). It reconciles every `findings-<k>.json` against the full docs and merges them into one `.delfini-trace/report.md`. Exit codes match single mode: `0` (no findings → tell the user `No drift detected.` and stop), `1` (findings → continue to "Surface the report"), any other non-zero → surface the error and stop.

**Per-chunk retry on schema failure.** On exit `3`, `local-finalize` prints a JSON payload of the shape `{"error":"schema_validation","failedChunks":[{"chunk":<k>,"issues":[...]}]}`. Re-dispatch ONLY the failed chunks: for each `failedChunks[].chunk` value `k`, copy `findings-<k>.json` to `findings-<k>-attempt-1.json`, then dispatch a second subagent for `prompts[k]` with the chunk's schema-validation error appended plus `the previous attempt failed schema validation with the error above — fix and return valid JSON`, overwriting `findings-<k>.json`. Re-run `delfini local-finalize .delfini-trace/`. If the same chunk fails a second time, preserve `findings-<k>-attempt-2.json`, surface both attempts plus the error to the user, and stop. **No third try per chunk** (same rationale as single mode).

## Run finalize

Run `delfini local-finalize .delfini-trace/findings.json`. On exit `0` (no findings) or exit `1` (findings present), read `.delfini-trace/report.md`.

Exit codes:

- **Exit `0`** → no findings. Tell the user `No drift detected.` and stop.
- **Exit `1`** → findings present. Continue to "Surface the report".
- **Exit `3`** → schema validation failure. See "Retry on schema-validation failure".
- **Any other non-zero exit** → surface the CLI's error output and stop.

## Surface the report

Output the contents of `.delfini-trace/report.md` to the user as host-agent chat text, verbatim, in a single chat message. The report is the decision context for the Apply UX that follows — the user needs the numbered findings, severities, file:line targets, quoted doc text, and proposed replacements visible in front of them before they answer Apply / Pick / Skip.

**Anti-patterns — do NOT do these:**

- "Drift detected — 5 apply-eligible findings, all in `docs/...`." — a one-line summary that throws away every actionable detail the report carries.
- "Here are the findings:" / "Per Step 7 of the protocol:" / "Report:" / "Now showing the report:" — any prefix line that frames the report. Emit the report and nothing else.
- Paraphrasing the severity counts, restating the section names in your own words, trimming the proposed-replacement code blocks, or reordering the entries.
- Splitting the report across multiple chat messages or interleaving it with tool-call narration.

**Positive shape:** the next host-agent chat message after `delfini local-finalize` exits `1` is the contents of `.delfini-trace/report.md` — no prefix, no suffix, no commentary. The Apply UX prompt comes in the message after that.

## Apply UX

Findings present (exit `1` from "Run finalize").

**Guard — only-manual-review case:** if the report's "Apply-eligible findings" section is absent or contains the literal text `No apply-eligible findings.` (meaning every finding is narrative-only drift and/or a clarification — both kinds live under "Manual review required" and neither is auto-applicable), do NOT present the Apply / Pick / Skip prompt. Instead, tell the user:

> Drift detected, but no auto-applicable fixes. Review the "Manual review required" section above and act manually (fix the code, hand-edit the doc, or accept the drift). The `.delfini-trace/` artefacts remain on disk for reference.

Then stop. The apply UX below only runs when the "Apply-eligible findings" section has at least one numbered entry.

Otherwise, ask the user in a single turn. Use a one-line digest as the question / description so the AskUserQuestion card itself carries the decision context:

> **N findings: X drift, Y additive (H High / M Medium / L Low). Apply all (a) / Pick subset (s) / Skip (n)?**

Derive the digest deterministically from `.delfini-trace/report.md`:

- `N = X + Y` (total apply-eligible findings; excludes "Manual review required" entries).
- `X` = count of headings shaped `### [<n>] [<severity>] drift:` (the brackets are literal characters in the heading; `<n>` is the one-based index, `<severity>` is one of `H` / `M` / `L`).
- `Y` = count of headings shaped `### [<n>] [<severity>] additive:` (same shape, with `additive` in place of `drift`).
- `H` / `M` / `L` = number of apply-eligible entries whose `<severity>` is `H` / `M` / `L` respectively.

Respond to exactly one of `a`, `s`, or `n`. Do not ask follow-up questions before the user replies.

### `(a) Apply all`

For every entry in the report's "Apply-eligible findings" section (drift and additive findings only), apply the proposed replacement / proposed content via the host agent's `Edit` tool.

**Ordering:** for each file, apply findings in **descending line order** (highest target line first, lowest last). Earlier-line splices shift later-line offsets — applying top-down corrupts the line numbers for every subsequent edit on the same file. Descending order keeps every subsequent edit's target lines stable.

**Manual-review findings (narrative-only drift + clarifications):** entries under "Manual review required" are **never** offered for auto-apply. Two sub-cases, same outcome:
- **Narrative-only drift** — the LLM correctly detected drift but emitted no concrete `proposedReplacement` (typically because the doc rule is right and the code is the violation). The user must fix code (or hand-edit the doc) — no splice possible.
- **Clarification (FR147 — no-fabrication invariant)** — a human answers a clarification by hand-editing the doc; an agent does not invent a doc paragraph.

Even when the user picks `(a)`, skip every "Manual review required" entry silently — do not ask the user separately, do not prompt for each one, do not let one through.

### `(s) Pick subset`

Ask the user to name one-based indices from the "Apply-eligible findings" section in a single reply (e.g. `1, 3, 5` or `1-3, 6`). Apply the named subset using the same per-file descending-line-order rule as `(a)`.

"Manual review required" entries (narrative-only drift + clarifications) are not indexed in the apply-eligible numbering scheme and are not selectable. If the user names an index that maps to a manual-review entry (or to anything outside the apply-eligible range), refuse with the literal message:

> Manual-review entries cannot be auto-applied — see "Manual review required"

Do not apply any edits in that case until the user re-supplies a valid subset.

### `(n) Skip`

Exit without applying any edits. The `.delfini-trace/` artefacts remain on disk for the user's reference.

### Outcome line

After the apply batch finishes (or the user picks `(n)`), emit exactly one host-agent chat line — the outcome — and stop. Do not narrate the individual `Edit` tool calls; they appear as tool-use cards in the UI already.

- `(a)` success → `Applied N/M findings.` (where M = total apply-eligible findings, N = number actually applied; for `(a)` these are equal unless a mid-batch `Edit` failure intervened — in which case use the failure message below instead).
- `(s)` success → `Applied N/M findings.` (where N is the size of the user's subset and M is the total apply-eligible count; N ≤ M by construction).
- `(n)` → `Skipped — findings preserved in .delfini-trace/`
- Mid-batch `Edit` failure → use the failure message defined in "Mid-batch `Edit` failure" below instead of either success line.

### Mid-batch `Edit` failure

If the host agent's `Edit` tool fails partway through an apply batch (typically because the target file's content has changed since `local-prepare` ran), stop the batch immediately. Report to the user:

> Applied N of M findings. Finding K (`<path>:<line>`) couldn't be applied — file content has changed since analysis. Re-run `/delfini` to refresh.

**Do not roll back already-applied edits.** The host agent's `Edit` tool is not transactional. The local rollback primitive is `git checkout -- <paths>` — the user can run that against any files they want to revert. Re-running `/delfini` after a refresh produces a new set of findings against the current file state.
