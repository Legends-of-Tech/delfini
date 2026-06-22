# Spec: Configurable ignore-code-scope (drop code-change paths from drift analysis)

> **Status:** IMPLEMENTED (Phase 4 complete). All tasks T1–T7 landed; repo-wide typecheck + lint
> clean; 740 tests pass. The only 2 failing tests are the pre-existing Windows-CRLF artifact on
> gates A (drift-engine prompt-snapshot) and C (bundled-CLI parity) — both compare LF `buildPrompt`
> output against CRLF-on-disk fixtures (delta = exactly one `\r` per line) and pass in CI on Linux.
> `prompt.md` and the snapshot fixtures were not modified. Companion to the repo context spec in
> [`SPEC.md`](./SPEC.md); the invariants and boundaries there govern this work.

## Objective

**What we're building.** Let developers configure a set of **code paths whose changes Delfini
ignores during drift analysis.** When a changed file matches the ignore set, its diff is dropped
before prompt assembly, so the LLM never sees it and it can produce no findings.

**Why.** Real PRs touch paths that can never contradict source-of-truth docs but still cost prompt
tokens and risk spurious findings: generated clients, snapshots, migrations, fixtures, a vendored
SDK, an experimental scratch dir. Delfini already drops a *fixed, hard-coded* set of such paths via
the opt-in diff pre-filter (`filterDiff`: lockfile/generated/vendored/fixture). This feature makes
the ignore set **user-configurable per repo**, on both delivery surfaces, without weakening parity.

**Who it's for.** A team adopting Delfini who wants to point it at their docs *and* tell it which
code areas are out of bounds for drift — once, in a committed config their whole team shares.

**Success looks like.** A developer adds `ignore_code_scope` to their committed Delfini config (or
the `ignore_code_scope` Action input), and a PR touching only those paths produces **zero findings
on both the Skill and the Action**, with the dropped paths visible (not silent). All three release
gates stay green; the no-config path is byte-identical to today.

### Reframed success criteria

- A changed file matching any `ignore_code_scope` entry contributes **nothing** to the analysed
  diff — identical decision on the CLI (Windows) and the Action (Linux CI), via one shared matcher.
- With `ignore_code_scope` **empty/absent**, `analysis-input.json`, `analysis-prompt.md`, and the
  Action's assembled diff are **byte-identical** to today (NFR44 / NFR49(b) parity preserved).
- Dropped paths are **surfaced**, never silent: in the CLI trace (`_filterResult`) and the Action's
  one-line `core.info` summary, under a new `ignored` reason.
- A PR whose only non-doc changes are all ignored is treated **as if those files did not change**
  (feeds smart-skip on the Action; yields an empty-diff PASS on the Skill).

## Tech Stack

No new dependencies. Uses what the repo already ships:

- **`picomatch@4`** — the single glob dialect (ADR-2026-06-01), already a `@delfini/drift-engine`
  runtime dep. Ignore matching reuses the existing `isFileInDocScope` predicate (dir → subtree,
  file → exact, glob → picomatch) so the ignore dialect *is* the doc-scope dialect by construction.
- **`zod`** — config-file schema validation (CLI).
- Engine stays pure (no I/O / no LLM / no `process.env`); CLI stays deterministic (no LLM).

## Commands

Unchanged from [`SPEC.md`](./SPEC.md). Verify with:

```bash
pnpm --filter @delfini/drift-engine build
pnpm --filter @delfini/action-core build
pnpm --filter @delfini/cli build
pnpm --filter @delfini/action build
pnpm typecheck && pnpm lint && pnpm test
```

New user-facing surface:

```bash
# Skill (per-run override; comma- or space-separated; overrides config without writing it)
delfini local-prepare --ignore-code-scope "src/generated/**, db/migrations/"

# Action (workflow input; newline- or comma-delimited, mirrors doc_scope)
#   with:
#     doc_scope: docs/
#     ignore_code_scope: |
#       src/generated/**
#       db/migrations/
```

## Project Structure / Where the change lands

```
packages/drift-engine/src/diff-filter.ts       Add user-glob path dropping (reason 'ignored').
                                                Reuse isFileInDocScope for the match. Signature
                                                gains an options arg; default call = today's behaviour.
packages/drift-engine/src/index.ts             Re-export the new DropReason / option type (additive).

packages/cli/src/doc-scope.ts  → config.ts     RENAME. delfini-config.json owns BOTH scopes:
                                                { version, doc_scope, ignore_code_scope }. Legacy
                                                doc-scope.json read-fallback + one-time migration.
packages/cli/src/commands/local-prepare.ts     Read ignore_code_scope from config + --ignore-code-scope
                                                override; run the diff filter when it is non-empty.
packages/cli/src/commands/install.ts           Update path constant / function names / log strings.
packages/cli/src/cli.ts                         Wire --ignore-code-scope; keep --reset-scope semantics.
packages/cli/src/index.ts                       Barrel: renamed config exports.
packages/cli/templates/SKILL.md                Rename "Load doc-scope"→"Load config"; document the
.claude/skills/delfini/SKILL.md                 new file + ignore_code_scope; both copies in lockstep.

packages/action-core/src/pipeline-inputs.ts    Read ignore_code_scope input → PipelineInputs.ignoreCodeScope.
apps/action/action.yml                         New ignore_code_scope input (default empty).
apps/action/src/lite-pipeline.ts               Filter changedFiles via isFileInDocScope ONCE, before
                                                both smart-skip and buildAnalysisInput; surface count.
                                                (buildAnalysisInput / analysis-input.ts: NO signature
                                                change — it receives the already-filtered file array.)

docs/ + READMEs                                packages/cli/README.md, apps/action/README.md examples.
.changeset/                                    minor: cli + drift-engine + action-core.
```

**Parity spine (unchanged principle).** The *decision* lives in one shared predicate,
`isFileInDocScope` (picomatch@4 dialect). Both surfaces feed it the same normalized `string[]`; only
the *mechanism* differs by diff shape — the CLI drops matching files while parsing its `git diff`
string (`filterDiff` with `ignorePaths`), the Action drops matching `ChangedFile`s from its array
before the diff is synthesized. A file the Skill ignores is a file the Action ignores; the existing
dialect-parity fixtures pin it. No new positional/option parameter is added to `buildAnalysisInput`.

## Design

### 1. The matcher (drift-engine) — `filterDiff` gains an options arg

`filterDiff(diff)` today: parses the diff, drops built-in noise (lockfile/generated/vendored/
fixture paths + whitespace/import hunks). It is called only when `enableDiffPreFilter` is on.

Change it to `filterDiff(diff, options?)`:

```ts
export type DropReason =
  | 'lockfile' | 'generated' | 'vendored' | 'fixture'
  | 'whitespace-only' | 'import-only'
  | 'ignored'                                   // NEW — matched a user ignore_code_scope entry

export interface FilterDiffOptions {
  /** Apply the built-in noise classifiers. Default true → today's `filterDiff(diff)` is unchanged. */
  builtins?: boolean
  /** User ignore globs (repo-relative, picomatch dialect). Empty → no ignore dropping. */
  ignorePaths?: string[]
}
```

- Per parsed file, classify ignore **first**: if `ignorePaths` is non-empty and
  `isFileInDocScope(file.path, ignorePaths)` is true → drop with reason `'ignored'`. Else fall
  through to the existing `classifyPath` built-ins (only when `builtins` is true).
- One diff parse, one pass — ignore + built-ins compose without parsing twice.
- **Back-compat:** `filterDiff(diff)` ≡ `filterDiff(diff, { builtins: true, ignorePaths: [] })` ≡
  today. Existing tests and the existing `enableDiffPreFilter` call sites keep their bytes.
- `diff-filter.ts` may now import `isFileInDocScope` from `./doc-scope.js` (same package, no new
  external dep). The file's "NO picomatch" comment refers to its hand-written *built-in* classifiers
  and stays true for those; user globs deliberately use the shared picomatch predicate for dialect
  parity. The comment will be amended to record this distinction.

Consumers run the filter whenever `enableDiffPreFilter || ignorePaths.length > 0`, calling
`filterDiff(diff, { builtins: enableDiffPreFilter, ignorePaths })`. When neither applies, they skip
the call entirely (byte-identical no-op path preserved).

### 2. CLI config — rename `doc-scope.json` → `delfini-config.json`

One committed, team-shared config file owns both scopes:

```jsonc
// .claude/skills/delfini/delfini-config.json
{
  "version": 1,
  "doc_scope": ["docs/", "packages/*/README.md"],
  "ignore_code_scope": ["src/generated/**", "db/migrations/"]   // optional; default []
}
```

- **Schema (`version: 1`):** `doc_scope: string[]` (required, ≥1) + `ignore_code_scope: string[]`
  (optional, default `[]`). `ignore_code_scope` entries are validated/normalized with the same
  `validateDocScopeEntry` + `normalizeDocScope` engine algebra as `doc_scope` (repo-relative, no
  `..` escape, no control chars). **No version bump:** the filename change is itself the
  compatibility boundary (an old CLI looks for `doc-scope.json` and never opens the new file), so
  `version` stays `1`; the new key is purely additive within v1.
- **Migration (read):** `readConfig` reads `delfini-config.json` if present; else falls back to a
  legacy `doc-scope.json` (read as `{ version, doc_scope, ignore_code_scope: [] }`). No repo with a
  committed `doc-scope.json` breaks.
- **Migration (write):** any config write emits `delfini-config.json`; if a legacy `doc-scope.json`
  exists it is deleted in the same write (single source of truth) with a one-line stderr note. Net
  effect for existing users: transparent rename on their next scope edit / install.
- **Module rename:** `doc-scope.ts` → `config.ts`. `DOC_SCOPE_RELATIVE_PATH` →
  `DELFINI_CONFIG_RELATIVE_PATH`; `readDocScope/writeDocScope/docScopeExists/deleteDocScope` →
  `readConfig/writeConfig/configExists/deleteConfig` (returning/taking the whole config object).
  `writeConfig` preserves an existing `ignore_code_scope` when only `doc_scope` is being set
  (install path) and vice-versa.
- **`--reset-scope`** keeps its name and now deletes `delfini-config.json` (resets *all* Delfini
  config). Rationale: it already deletes the whole scope file today; widening it to the renamed file
  is the least-surprise behaviour. (Open question OQ-3 considers a `--reset-config` alias.)
- **`--ignore-code-scope <paths>` flag** on `local-prepare` mirrors `--scope`: a per-run override
  that does **not** write the file (FR144 per-run-override invariant), parsed with the same
  comma/space splitter as `--scope`.

### 3. Action input — `ignore_code_scope`

- New `action.yml` input `ignore_code_scope` (default empty → ignore nothing). Documented exactly
  like `doc_scope`: newline- or comma-delimited; each entry a dir / file / picomatch glob.
- `readPipelineInputs()` splits on `[\n,]`, runs `normalizeDocScope`, yields
  `PipelineInputs.ignoreCodeScope: string[]` (default `[]`; **no** "fall back to a default" — empty
  means ignore nothing, unlike `doc_scope` which defaults to `docs/`).

### 4. Smart-skip interaction (Action) — strip once, before classify (CONFIRMED)

In `runLitePipeline`, filter `changedFiles` **once** via the shared predicate, **before** both
`classifyPr` and `buildAnalysisInput`, so an ignored file is uniformly "as if unchanged":

```ts
const analysedFiles = changedFiles.filter(f => !isFileInDocScope(f.filename, inputs.ignoreCodeScope))
const ignoredCount = changedFiles.length - analysedFiles.length
if (ignoredCount > 0) core.info(`Delfini ignored ${ignoredCount} changed file(s) via ignore_code_scope.`)
// classifyPr(analysedFiles.map(f => f.filename), …)  and  buildAnalysisInput(ctx, analysedFiles, docs, …)
```

This is the single ignore application point on the Action — `buildAnalysisInput` needs **no** new
param (it receives fewer files). The built-in `enableDiffPreFilter` path inside `buildAnalysisInput`
is untouched. Surfacing is a dedicated `core.info` line (the `ignored` count), separate from the
built-in pre-filter summary.

Consequence (confirmed): a PR touching **only** ignored code → smart-skip → clean PASS, not an
empty-diff analysis.

> **CLI counterpart (no smart-skip there):** the CLI has no `classifyPr` stage. An all-ignored diff
> simply renders empty → the analysis subagent returns no findings (a harmless empty-diff PASS). An
> optional short-circuit in `local-prepare` ("0 files remain after ignore → nothing to analyse") is
> a nice-to-have, deferred unless it falls out cheaply (tracked in Tasks as optional).

### 5. Scope boundary — code side only

`ignore_code_scope` filters the **analysed diff** (the code-change side). It does **not** remove
documents from the doc set — docs are governed by `doc_scope` + in-doc front-matter
(`delfini: ignore`). A markdown file can be both a tracked doc and an ignored code path without
contradiction: it is still rendered as a doc if in `doc_scope`; only its appearance *in the diff* is
dropped. This keeps the two scopes orthogonal and matches the requirement's wording ("code changes").

### 6. Install scaffolding (follow-up)

`delfini install` prompts for **both** scopes — docs first, then ignore code paths — and **always
creates** `delfini-config.json` (when none exists) with **both fields present**, using empty arrays
when a prompt is skipped (or on a non-TTY shell). This gives the team a committed, hand-editable
template with both knobs visible. New `--ignore-code-scope` install flag mirrors `--scope` for
non-interactive runs; a single-field flag run preserves the field it doesn't name.

Consequence: an empty `doc_scope` is treated as **"not configured"** in `local-prepare`
(`resolveScopePaths` returns null → exit 2) and in the SKILL's "Load config" step, so the first
`/delfini` run prompts to fill the scaffold rather than silently analysing zero docs.
New writer `writeConfigScaffold` (always both fields, empty allowed) backs this; the general
`writeConfig` / `writeDocScope` semantics (require non-empty doc_scope, omit empty ignore) are
unchanged.

## Code Style

Match the surrounding code (Prettier `.prettierrc`, ESLint flat config): named exports only,
kebab-case files, `.js` import extensions, heavy "why" comments that cite the requirement/invariant.
The engine matcher stays pure; the CLI stays LLM-free.

```ts
// packages/drift-engine/src/diff-filter.ts (sketch)
import { isFileInDocScope } from './doc-scope.js'

const ignoreReason =
  ignorePaths.length > 0 && isFileInDocScope(file.path, ignorePaths) ? 'ignored' : null
if (ignoreReason !== null) {
  droppedPaths.push({ path: file.path, reason: ignoreReason })
  continue // never reaches the built-in classifiers or hunk-level filtering
}
```

## Testing Strategy

Vitest 3, tests in `__tests__/` beside each package. Behaviour change ships with tests.

- **drift-engine — `diff-filter.test.ts`:** `filterDiff(diff)` and `filterDiff(diff, {})` remain
  byte-identical to today (regression guard for the default arg). New cases: ignore by dir / file /
  glob; `'ignored'` reason recorded; ignore composes with built-ins (both reasons in one result);
  ignore-only with `builtins:false` leaves non-ignored files untouched; empty `ignorePaths` is a
  no-op. Reuse the dialect semantics already covered by `doc-scope-dialect.json`.
- **drift-engine — snapshot parity (`prompt-snapshot.test.ts`):** unchanged and green by
  construction — `filterDiff` is consumer-side, never inside `buildPrompt` (NFR44 gate A).
- **CLI — `config.test.ts`** (renamed from `doc-scope.test.ts`): schema accepts/normalizes/validates
  `ignore_code_scope`; legacy `doc-scope.json` read-fallback; migration write deletes the legacy
  file; `writeConfig` preserves the untouched scope. `local-prepare.test.ts`: ignore from config and
  from `--ignore-code-scope`; trace `_filterResult` carries `'ignored'` drops; no-ignore path
  byte-identical (gate C parity).
- **action-core — `analysis-input.test.ts`:** ignore threading + `core.info` summary counts the
  `ignored` bucket. **`pipeline-inputs.test.ts`** (or equivalent): `ignore_code_scope` split/
  normalize/default-empty. **`smart-skip` / lite-pipeline:** only-ignored-files PR → smart-skip PASS.
- **Cross-surface parity (`doc-scope-dialect-parity.test.ts`, `bundled-parity.test.ts`):** the
  ignore matcher uses `isFileInDocScope`, so the existing dialect-parity fixtures already pin
  CLI≡engine≡action agreement; extend fixtures if a new edge surfaces.

## Boundaries

### Always
- Run `pnpm typecheck && pnpm lint && pnpm test` before pushing.
- Add a **changeset** (this touches `cli`, `drift-engine`, `action-core`). Proposed: `minor` for all
  three, impact markers `[cli]` / `[drift-engine]` / `[action-core]` (+ `[skill]` for SKILL.md).
- Keep `@delfini/drift-engine` pure and `@delfini/cli` LLM-free.
- Keep the no-config path **byte-identical** (the three release gates stay green with no re-snapshot).
- Use `isFileInDocScope` for ignore matching — do **not** hand-roll a second glob path.

### Ask first
- Any change to `buildPrompt` default-path output (must not happen here; if a candidate edit would,
  stop) — fires the snapshot gate.
- Schema/version changes beyond the additive `ignore_code_scope` key.
- Renaming the `--reset-scope` flag or changing its blast radius beyond "delete the renamed file".

### Never
- Reintroduce a `.delfiniignore` dotfile. Path-level exclusion via a side-channel dotfile was
  **deliberately retired in v6.1** (`packages/action-core/src/doc-exclusion.ts:4`); this feature
  routes config through the committed config file (Skill) and the workflow input (Action) instead.
- Make the ignore filter alter doc rendering, the prompt template, or `analysisSchema`.
- Weaken, skip, or delete a release gate to make CI pass.

## Success Criteria (done = all true)

- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] **Gate A** (drift-engine prompt-snapshot parity), **Gate B-lite** (action + action-core),
      **Gate C** (bundled-CLI parity) all green — no re-snapshot.
- [ ] `filterDiff(diff)` output unchanged for all existing fixtures (default-arg regression guard).
- [ ] CLI: `ignore_code_scope` from `delfini-config.json` and `--ignore-code-scope` both drop
      matching files from the analysed diff; legacy `doc-scope.json` still loads; migration writes
      `delfini-config.json` and removes the legacy file.
- [ ] Action: `ignore_code_scope` input drops matching files; only-ignored PR smart-skips to PASS;
      `core.info` summary reports the `ignored` count.
- [ ] No-config path byte-identical (`analysis-input.json` / assembled diff).
- [ ] CLI≡Action: identical ignore decision for identical `(file, ignore_code_scope)` (dialect
      parity fixtures cover it).
- [ ] A changeset is present; READMEs (`packages/cli`, `apps/action`) document the new config.
- [ ] drift-engine still imports nothing outside `zod` + `picomatch`.

## Open Questions (need human input before / during Plan)

- **OQ-1 — Naming.** Confirm `ignore_code_scope` as the JSON key **and** the Action input name (I'm
  aligning both to the key you chose). CLI flag proposed as `--ignore-code-scope` (verbose but
  mirrors the key); acceptable, or prefer `--ignore-scope`?
- **OQ-2 — Smart-skip behaviour (Action). RESOLVED ✅** A PR touching only ignored code →
  smart-skip → clean PASS (single array-filter in `runLitePipeline`; no new `buildAnalysisInput`
  param). See §4.
- **OQ-3 — Reset ergonomics.** `--reset-scope` now deletes the whole `delfini-config.json`. Keep the
  name (least churn), or also add a `--reset-config` alias and/or have it clear only `doc_scope`?
- **OQ-4 — Migration aggressiveness.** On write, delete the legacy `doc-scope.json` (recommended,
  single source of truth) vs. leave it and just stop reading it. Affects whether existing repos see a
  file deletion in their next Delfini-authored commit.
- **OQ-5 — Release bump.** `minor` across the three packages assumes the rename is non-breaking via
  the read-fallback. Confirm that's the intended semver posture (vs. `major` on `@delfini/cli` to
  signal the config-file rename explicitly).

> Proceeding into Plan/Tasks with defaults for the still-open items: OQ-1 flag `--ignore-code-scope`,
> OQ-3 keep `--reset-scope` (deletes the renamed file), OQ-4 delete legacy on migrate, OQ-5 `minor`.
> Each is localized and cheap to flip during Implement.

---

## Implementation Plan (Phase 2)

**Build order (fixed by the monorepo):** `drift-engine` → `action-core` → `cli` → `action`.

**Components & dependency graph** (→ = "must land before"):

```
T1 drift-engine: filterDiff options + 'ignored'      ─┐
T2 cli: config-module rename + schema + migration    ─┼─→ T3 cli: local-prepare ignore + flag ─┐
T4 action-core: pipeline-inputs.ignoreCodeScope      ─┼─→ T5 action: lite-pipeline filter+input┼─→ T6 docs/SKILL/changeset ─→ T7 verify
                                                      ─┘                                        ─┘
```

- **Parallelizable first wave:** T1, T2, T4 are in three different packages and share no files —
  they can proceed independently.
- **Second wave:** T3 needs T1 (filterDiff options) **and** T2 (readConfig surfaces
  `ignore_code_scope`). T5 needs T4 (`PipelineInputs.ignoreCodeScope`).
- **Last:** T6 (user-facing docs + the two SKILL.md copies + changeset) once behaviour is settled;
  T7 is the full green-gate sweep.

**Verification checkpoints (between waves):**
1. After T1 — `pnpm --filter @delfini/drift-engine test` green **including gate A** (snapshot parity
   proves the consumer-side matcher didn't disturb `buildPrompt`).
2. After T2/T3 — `pnpm --filter @delfini/cli test` green including **gate C** (bundled-parity) and
   the byte-identical no-ignore assertion.
3. After T4/T5 — `pnpm --filter @delfini/action test && pnpm --filter @delfini/action-core test`
   green (**gate B-lite**), only-ignored-PR smart-skips.
4. After T6/T7 — root `pnpm typecheck && pnpm lint && pnpm test`, all three gates, changeset present.

**Risks & mitigations:**
- **R1 — parity/snapshot regression.** The matcher is consumer-side and the default `filterDiff(diff)`
  arg is preserved → gate A unaffected. Mitigate with the default-arg regression test (T1) and the
  no-ignore byte-identical assertions (T3, T5).
- **R2 — SKILL.md two-copy drift.** `packages/cli/templates/SKILL.md` and the scaffolded
  `.claude/skills/delfini/SKILL.md` must stay identical (asserted by `skill-template` /
  `bundled-install-smoke` tests). Edit both in T6 and run those suites.
- **R3 — migration deletes a committed file.** A one-line stderr note + `config.test.ts` coverage;
  governed by OQ-4.
- **R4 — stray `doc-scope` references.** 19 files matched the grep; T2 sweeps the CLI imports and
  the `--reset-scope` subcommand test; T7's lint/typecheck catches leftovers.
- **R5 — action-core has no `pipeline-inputs` test today.** T4 adds one (default-empty, split,
  normalize).
- **R6 — eslint `no-restricted-imports` on drift-engine.** `diff-filter.ts` importing the sibling
  `./doc-scope.js` is allowed (the ban list is fs/child_process/http/LLM/`process.env`, not
  intra-package imports). Confirmed by T1 lint.

## Tasks (Phase 3)

> Ordered by dependency, not importance. Each ≤ ~5 files, each independently verifiable.

- [x] **T1 — drift-engine: `filterDiff` options + `'ignored'` reason**
  - Acceptance: `filterDiff(diff, { builtins, ignorePaths })` drops files matching `ignorePaths`
    (via `isFileInDocScope`) with reason `'ignored'`, classified before the built-ins; `builtins`
    defaults true so `filterDiff(diff)` is byte-identical to today; empty `ignorePaths` is a no-op.
  - Verify: `pnpm --filter @delfini/drift-engine test` (new cases + **gate A** snapshot still green),
    `typecheck`, `lint`.
  - Files: `src/diff-filter.ts`, `src/index.ts`, `__tests__/diff-filter.test.ts` (+ `src/types.ts` if
    an option type is hoisted there).

- [x] **T2 — cli: rename config module + schema + migration**
  - Acceptance: `delfini-config.json` schema `{ version:1, doc_scope, ignore_code_scope? }` validates
    `ignore_code_scope` via the shared engine algebra; `readConfig` reads the new file or falls back
    to a legacy `doc-scope.json`; `writeConfig` writes the new file, deletes the legacy file (one-line
    note), and preserves the scope it isn't editing. Module renamed `doc-scope.ts`→`config.ts` with
    callers updated.
  - Verify: `pnpm --filter @delfini/cli test` (renamed `config.test.ts` + migration/ignore cases),
    `typecheck`, `lint`.
  - Files: `src/config.ts` (was `doc-scope.ts`), `src/commands/install.ts`, `src/cli.ts`,
    `src/index.ts`, `__tests__/config.test.ts` (was `doc-scope.test.ts`).

- [x] **T3 — cli: `local-prepare` consumes ignore + `--ignore-code-scope` flag**
  - Acceptance: `runLocalPrepare` resolves `ignore_code_scope` from config and the
    `--ignore-code-scope` per-run override (no file write); runs `filterDiff(diff, { builtins:
    enableDiffPreFilter, ignorePaths })` whenever ignore is non-empty or the prefilter is on; trace
    `_filterResult` carries `'ignored'` drops; no-ignore path byte-identical.
  - Verify: `pnpm --filter @delfini/cli test` (ignore-from-config, ignore-from-flag, byte-identical
    no-ignore, trace assertion), **gate C** bundled-parity, `typecheck`, `lint`.
  - Files: `src/commands/local-prepare.ts`, `src/cli.ts`, `__tests__/local-prepare.test.ts`.
  - Depends: T1, T2.

- [x] **T4 — action-core: `pipeline-inputs` reads `ignore_code_scope`**
  - Acceptance: `PipelineInputs` gains `ignoreCodeScope: string[]`; `readPipelineInputs` splits the
    `ignore_code_scope` input on `[\n,]`, `normalizeDocScope`s it, defaults to `[]` (no `docs/`-style
    fallback — empty means ignore nothing).
  - Verify: `pnpm --filter @delfini/action-core test` (new pipeline-inputs coverage), `typecheck`,
    `lint`.
  - Files: `src/pipeline-inputs.ts`, `__tests__/pipeline-inputs.test.ts` (new).

- [x] **T5 — action: lite-pipeline filter + `action.yml` input + smart-skip**
  - Acceptance: `action.yml` declares `ignore_code_scope` (default empty, documented like
    `doc_scope`); `runLitePipeline` filters `changedFiles` once via `isFileInDocScope`, feeding the
    filtered array to both `classifyPr` and `buildAnalysisInput`, and emits a `core.info` ignored
    count; a PR touching only ignored code smart-skips to PASS. No `buildAnalysisInput` signature
    change.
  - Verify: `pnpm --filter @delfini/action test` (only-ignored→smart-skip PASS; ignored file absent
    from analysis), **gate B-lite**, `typecheck`, `lint`.
  - Files: `action.yml`, `src/lite-pipeline.ts`, `src/__tests__/lite-pipeline.test.ts`
    (+ `lite-pipeline.e2e.test.ts` if the e2e fixture needs the input).
  - Depends: T4.

- [x] **T6 — docs, SKILL.md (both copies), changeset**
  - Acceptance: `packages/cli/templates/SKILL.md` "Load doc-scope" section becomes "Load config"
    (reads `delfini-config.json`, documents `ignore_code_scope`, notes legacy fallback), mirrored
    byte-for-byte into `.claude/skills/delfini/SKILL.md`; `packages/cli/README.md` +
    `apps/action/README.md` show an `ignore_code_scope` example; a `.changeset/*.md` bumps cli +
    drift-engine + action-core (`minor`) with `[cli]`/`[drift-engine]`/`[action-core]`/`[skill]`
    markers.
  - Verify: `pnpm --filter @delfini/cli test` (`skill-template` + `bundled-install-smoke` green),
    changeset-check gate.
  - Files: `packages/cli/templates/SKILL.md`, `.claude/skills/delfini/SKILL.md`,
    `packages/cli/README.md`, `apps/action/README.md`, `.changeset/<name>.md`.
  - Depends: T1–T5 behaviour settled.

- [x] **T7 — full verification & parity sweep**
  - Acceptance: clean build in dependency order; root `pnpm typecheck && pnpm lint && pnpm test`
    green; gates A / B-lite / C green; no-config path byte-identical; CLI≡Action ignore decision
    holds on the dialect-parity fixtures.
  - Verify: the four build commands + the three verify commands from §Commands; spot-check a
    hand-built ignore case on both surfaces.
  - Files: none (CI/verification only).

- [ ] **T8 (optional) — cli `local-prepare` all-ignored short-circuit**
  - Acceptance: when every changed file is ignored and the resulting diff is empty, `local-prepare`
    exits cleanly with a "nothing to analyse" signal instead of dispatching a subagent. Only land if
    it falls out cheaply; otherwise leave the harmless empty-diff PASS.
  - Verify: `pnpm --filter @delfini/cli test`.
  - Files: `src/commands/local-prepare.ts`, `__tests__/local-prepare.test.ts`.
```
