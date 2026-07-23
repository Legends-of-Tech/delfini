# Spec: Delfini OSS

> **Status:** Context-establishing spec for the *existing* `delfini-oss` monorepo. This documents
> what the project is, how it is built, and the invariants that govern changes to it — it is not a
> proposal for new work. Keep it alive: update it when an architectural decision, boundary, or
> command changes. Versions cited are point-in-time (packages are changesets-managed).

## Objective

**What it is.** Delfini is doc-drift detection for software teams: it catches pull requests whose
**code** changes contradict the project's source-of-truth **documentation** — before they merge.

**Who it's for.** Software teams who keep authoritative docs (architecture notes, ADRs, READMEs,
runbooks) and want a guard against code silently diverging from them.

**Two delivery surfaces, one analysis core.**

- **The Skill (`@delfini/cli`)** — local drift detection inside a coding agent (Claude Code). Runs
  on the agent's *existing* LLM tokens; no Delfini API key, no GitHub App, no new credentials.
- **The Action (`apps/action`)** — drift detection in CI. Reads docs + PR diff, calls the team's
  *own* LLM provider key, and posts one rich structured-findings PR comment.

**The defining property: algorithm parity by construction.** Both surfaces import the same pure
core (`@delfini/drift-engine`), so a finding the Skill surfaces locally is the same finding the
Action surfaces on the eventual PR. This is the product's core promise and the reason the core is
factored out as a dependency-free package.

**What success looks like.** A contributor can change any package and the three CI release gates
(prompt-snapshot parity, Lite action/action-core suites, bundled-CLI parity) stay green —
proving the two surfaces still agree.

## Tech Stack

- **Language:** TypeScript 5.7+ (`strict`, `ES2022`, `ESNext` modules, `moduleResolution: bundler`,
  `noEmit` at root). ESM throughout (`"type": "module"`).
- **Runtime:** Node.js 20+.
- **Package manager / monorepo:** pnpm 10+ workspaces (`packages/*`, `apps/*`). Pinned via
  `packageManager` in root `package.json`.
- **Core runtime deps (drift-engine):** `zod` (schema) + `picomatch@4` (glob dialect) — both pure
  CPU, no I/O.
- **CLI deps:** `commander` (routing), `simple-git` (git), `tinyglobby` (fs walk), `zod`.
- **Action-core deps:** `@actions/core`, `@actions/github`, `@langchain/{core,anthropic,openai}`,
  `gray-matter` (front-matter parsing).
- **Build tools:** `tsc -b` (drift-engine, action-core), `tsup` (cli bundle), `@vercel/ncc`
  (action single-file bundle).
- **Test:** Vitest 3. **Lint:** ESLint 9 flat config + typescript-eslint. **Format:** Prettier.
- **Release:** changesets (`@changesets/cli`, `@changesets/changelog-github`) + npm OIDC trusted
  publishing.
- **License:** Apache-2.0.

## Commands

```bash
# Install
pnpm install

# Build — ORDER MATTERS (dependency chain):
pnpm --filter @delfini/drift-engine build   # tsc -b
pnpm --filter @delfini/action-core build    # tsc -b + copy-prompt
pnpm --filter @delfini/cli build            # tsup (bundles drift-engine)
pnpm --filter @delfini/action build         # ncc single-file bundle

# Verify (run from root; -r fans out to every workspace)
pnpm typecheck      # pnpm -r typecheck  → tsc --noEmit per package
pnpm lint           # pnpm -r lint       → eslint src per package
pnpm test           # pnpm -r test       → vitest run per package

# Release machinery
pnpm changeset            # add a changeset to a PR (required for published-package changes)
pnpm version-packages     # changeset version (generated — do not hand-edit)
pnpm release              # changeset publish

# Product entry point (the Skill)
npx @delfini/cli install .   # scaffold .claude/skills/delfini/SKILL.md into a repo
```

## Project Structure

```
packages/drift-engine/   Pure-logic analysis core (published: @delfini/drift-engine)
                         prompt assembly, schema, reconciliation, doc-scope algebra,
                         diff pre-filter, ranked-fill budget. NO I/O, NO LLM, NO env.
packages/action-core/    Shared Action pipeline core (published: @delfini/action-core)
                         doc reader, smart-skip, analysis-input assembly, orchestrator
                         adapters (LangChain), shared GitHub client. No semver promise in V1.
                         The single-call orchestrator splits an over-budget analysis via
                         planPrompts and merges per-chunk results (mergeAnalysisResults) —
                         same primitives as the Skill, so both surfaces agree on big diffs.
packages/cli/            The Skill CLI (published: @delfini/cli; tsup-bundles drift-engine)
                         install / local-prepare / diff-status / local-finalize / --reset-scope.
                         Deterministic — NEVER calls an LLM. local-prepare splits an
                         over-budget diff into chunks.json + analysis-prompt-<k>.md (via
                         planPrompts) instead of exit 4; local-finalize given the trace
                         DIRECTORY merges the per-chunk findings (mergeAnalysisResults).
apps/action/             Standalone GitHub Action (ncc-bundled; dist/ built at release tags;
                         never published to npm). Lite pipeline + comment formatter.
scripts/                 Release-gate scan scripts (Lite-dist scan, action-core tarball scan,
                         dist prompt-asset check, JS comment stripper).
docs/                    Prompt fixtures / reference docs.
.changeset/              Release machinery (changesets config + impact-tag changelog formatter).
.claude/skills/delfini/  The product Skill artefact — what `delfini install` scaffolds.
.github/workflows/       CI: changeset-check, cli-auto-release, cli-release, delfini-lite.
```

**Dependency arrows:** `drift-engine` ← `action-core` ← `apps/action`; `drift-engine` ← `cli`.
`drift-engine` depends on nothing internal. Both consumer surfaces (`cli`, `action`) bottom out at
`drift-engine`, which is what guarantees parity.

**Public API of the core** (`packages/drift-engine/src/index.ts` barrel — exactly this, no
internal helpers leak): `buildPrompt`, `buildPromptWithDrops`, `validateAndReconcile`,
`mergeAnalysisResults`, `estimatePromptTokens`, `analysisSchema`, the doc-scope algebra (`normalizeDocScope`,
`validateDocScopeEntry`, `classifyEntry`, `isFileInDocScope`), `filterDiff`, `rankedFillSections`, `planPrompts`
(multi-prompt planner for over-budget diffs — splits into budget-sized chunks,
single-chunk fast path is byte-identical to `buildPrompt`), `gateDiffByRelevance`
(diff-side relevance gate — consumer call-sites drop hunks linked to no retained
doc section before prompt assembly; default-on at the CLI flag layer and in the
Action orchestrator), plus the published types.

## Code Style

Enforced by Prettier (`.prettierrc`) and ESLint (`eslint.config.js`). Match the surrounding code.

```ts
// .prettierrc: no semicolons, single quotes, trailing commas (all), printWidth 100, tabWidth 2
import type { AnalysisInput, BuildPromptOptions, DocFile } from './types.js'

// Named exports only — `export default` is an ESLint error repo-wide.
// Relative imports carry the .js extension (ESM, bundler resolution).
export function buildPrompt(
  input: AnalysisInput,
  template: string,
  options?: BuildPromptOptions,
): string {
  return buildPromptWithDrops(input, template, options).prompt
}
```

Key conventions:
- **Named exports only.** No `export default` (ESLint `no-restricted-syntax`).
- **kebab-case file names** (`prompt-builder.ts`, `doc-scope-entry.ts`).
- **Heavy "why" comments.** The codebase documents *rationale and invariants* (FR/AC/ADR
  references, snapshot-parity reasoning), not the obvious "what". Preserve this density when
  editing — comments cite the requirement they satisfy.
- **`.js` extension on relative imports** (ESM).
- **Errors set `process.exitCode`**, they do not call `process.exit()` (CLI flush + test
  isolation invariant).
- `_`-prefixed params for intentionally-unused arguments (action / action-core only).

## Testing Strategy

- **Framework:** Vitest 3 (`vitest run`). Tests live in `__tests__/` beside each package's `src/`.
- **Test reaches internals via relative `../src/...` imports** (same workspace package); the public
  barrel stays minimal.
- **The snapshot parity test is load-bearing.** `packages/drift-engine/__tests__/prompt-snapshot.test.ts`
  pins `buildPrompt` output byte-for-byte against `fixtures/canonical-prompt.snapshot.md`. A
  prompt change that fires this is *deliberate* — follow the re-snapshot procedure in
  `packages/drift-engine/README.md`. Default consumer paths (diff pre-filter off, no relevance
  threshold) must keep output byte-identical to baseline.
- **Cross-surface parity tests:** `bundled-parity.test.ts` (cli) and the doc-scope-dialect-parity
  tests (cli + action-core) prove the bundled CLI and the action agree with the core.
- **Token-efficiency / residual-drift fixtures** under `drift-engine/__tests__/fixtures/` are
  golden-file cases with `analysis-input.json` → `expected.json`.
- **Coverage expectation:** behaviour changes ship with tests; the three release gates below are
  required-green on every PR touching published packages.

## Boundaries

### Always
- Run `pnpm typecheck && pnpm lint && pnpm test` before pushing.
- Add a **changeset** to any PR touching `packages/cli/**`, `packages/drift-engine/**`, or
  `packages/action-core/**` (CI enforces). Prefix the summary with an impact marker:
  `[cli]` / `[drift-engine]` / `[skill]` / `[action-core]`.
- Keep `@delfini/drift-engine` pure: **no I/O, no LLM client, no credentials, no `fetch`, no
  `process.env`.** Only runtime deps are `zod` + `picomatch`. (ESLint `no-restricted-imports`
  enforces this on `drift-engine/src/**`.)
- Keep `@delfini/cli` deterministic: **it NEVER calls an LLM.** LLM dispatch happens in the host
  coding agent. (ESLint blocks `@anthropic-ai/sdk`, `openai`, `@langchain/*` in cli + drift-engine.)
- Build in dependency order (drift-engine → action-core → cli → action).
- Use named exports and kebab-case file names.

### Ask first
- Adding any runtime dependency to `@delfini/drift-engine` (breaks the no-I/O charter / parity).
- Changing the canonical prompt (`packages/drift-engine/src/prompt.md`) — fires the snapshot gate;
  re-snapshotting must be deliberate and reviewed.
- Schema changes to `analysisSchema` or the public barrel surface.
- Changing CI workflows, release gates, or the changesets config.
- Anything that would alter `buildPrompt` default-path output (the byte-identical baseline).

### Never
- Commit secrets or LLM provider keys.
- Hand-edit `CHANGELOG.md` files or package `version` fields (changesets generates both).
- Add `fs`/`child_process`/`http`/`https`/`process.env`/LLM-client imports to `drift-engine`.
- Make `@delfini/cli` call an LLM.
- Weaken, skip, or delete a release gate to make CI pass.
- Have the standalone Action call the hosted Delfini platform — and if a workspace token is
  supplied (`delfini_workspace_token` / `DELFINI_WORKSPACE_TOKEN`), it must **hard-fail**, not
  silently run standalone.

## Success Criteria (for changes to this repo)

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.
- [ ] **Gate A** — drift-engine prompt-snapshot parity: `pnpm --filter @delfini/drift-engine test`.
- [ ] **Gate B-lite** — Lite action + action-core suites: `pnpm --filter @delfini/action test` and
      `pnpm --filter @delfini/action-core test`.
- [ ] **Gate C** — bundled-CLI parity: `pnpm --filter @delfini/cli test` (after drift-engine + cli
      builds).
- [ ] A changeset is present if a published package changed.
- [ ] drift-engine still imports nothing outside `zod` + `picomatch`.
- [ ] The two surfaces still produce identical findings for identical input (parity holds).

## Scope

This spec covers **only** the `delfini-oss` monorepo (the Skill, the standalone Action, and the
shared cores). The **hosted Delfini platform** (`Legends-of-Tech/delfini-platform` — workspace-
managed doc scope, hosted review surface, Approve-and-Commit, the "Full" action artifact) is a
separate private repository and is explicitly **out of scope** here. Where the OSS code references
platform contracts (e.g. the `FR88d`/`FR88g` intake/config wire shapes, "Full mode"), it does so
only to draw the boundary — those code paths do not exist in this repo's artifacts.

## Key Invariants Glossary (FR / NFR / ADR)

The codebase cites requirement IDs in comments and tests. The authoritative catalogue lives in the
private `_bmad` planning record (symlinked, gitignored), so this glossary restates — faithfully —
what the OSS code actually enforces, so the repo is self-describing without that record. If code
and this glossary ever disagree, the code (and its tests) win; fix the glossary.

| ID | Invariant (as enforced in this repo) |
|---|---|
| **FR139 / NFR44** | `@delfini/drift-engine` is pure logic, and `buildPrompt`'s default-path output is **byte-identical** to the canonical snapshot. Enforced by `prompt-snapshot.test.ts` + ESLint import bans. The cross-cutting guarantee behind algorithm parity. |
| **FR140** | The `@delfini/cli` Skill is **deterministic and never calls an LLM** — git, file I/O, prompt assembly, validation, report rendering only. LLM dispatch happens in the host coding agent. ESLint blocks LLM-client imports. |
| **FR141** | The CLI surface: top-level `--version` / `--reset-scope`, subcommands `install` / `local-prepare` / `diff-status` / `local-finalize`. Handlers are thin shims over `runXxx` library functions; they set `process.exitCode`, never `process.exit()`. |
| **FR142 / FR143 / FR149** | `delfini install` scaffolds `.claude/skills/delfini/SKILL.md`, manages the `CLAUDE.md` auto-invoke marker block (tri-state: prompt / `--auto-invoke` / `--no-auto-invoke`), and appends `.delfini-trace/` to `.gitignore`. |
| **FR150** | **Section-granularity retrieval** — a positive `relevanceThreshold` reduces each doc to its relevant heading-delimited sections; docs with no surviving section are omitted. Threshold 0/undefined → whole-doc render (the NFR44 baseline). |
| **FR151** | **Deterministic diff pre-filter** (`filterDiff`) — opt-in (`--enable-diff-prefilter`) drop of lockfile/generated/vendored/fixture paths + whitespace-only/import-only hunks before prompt assembly. Default off → byte-identical baseline. |
| **FR152** | **Ranked-fill prompt budget** — with both a positive threshold and `promptTokenBudget`, retained sections are ranked most-relevant-first and included while the running token total stays at-or-below budget; the rest surface as `droppedSections` from `buildPromptWithDrops`. |
| **Diff gate** | **Always-on diff-side relevance gating** (`gateDiffByRelevance`, docs/ideas/token-diet-symmetric-retrieval.md) — hunks scoring below `--diff-keep-threshold` (default: the effective relevance threshold) against every retained doc section are dropped before prompt assembly; weakly-linked hunks lose excess context; in-scope doc edits, new files, and dependency manifests always survive. Drops are reported (stderr `diff gate:` line, `_diffGateResult` trace sibling, Action `core.warning`) — never silent. The gate stands down rather than emit an empty diff, and the accepted lexical-recall hole is pinned by the committed `lexically-invisible` fixture. |
| **FR88 (+ FR88d/FR88g)** | The structured single-call findings contract / analysis schema. `FR88d`/`FR88g` are **platform** wire contracts (intake POST / doc-scope fetch) — named here only to mark the boundary; absent from OSS artifacts. |
| **FR134** | Runtime mode selection — **retired**. The OSS action is Lite-only; there is no mode branch. A supplied workspace token triggers the hard-fail guard (below). |
| **FR135** | The **Lite pipeline** — standalone analysis with no platform: doc scope from the `doc_scope` input only, GitHub check state from the verdict, one rich PR comment as the sole finding surface. |
| **FR136** | The rich structured-findings **PR comment formatter** (`lite-comment-formatter.ts`). |
| **NFR40** | Token efficiency of the assembled prompt (measured; see `token-efficiency` fixtures). |
| **NFR49** | Relevance retrieval is **default-ON** at the CLI call-site (`DEFAULT_RELEVANCE_THRESHOLD`), while `runLocalPrepare` stays a pure pass-through. |
| **ADR-2026-06-01** | **`picomatch@4` is the single glob dialect** for the doc-scope algebra across all surfaces (engine, CLI, action-core) — dialect-parity tests enforce agreement. |
| **PRD v6.5** | Baseline product revision: "no LLM calls from `packages/cli`"; introduces `narrativeOnlyContradictions` (drift the LLM found but with no actionable doc patch → surfaced under "Manual review required", not dropped). |
| **Story 3.9b** | Absolute **original-file line-number prefixing** (`N: `) so the LLM emits real line numbers; `quotedDocText` excludes the prefix so the reconciler can `indexOf` it in the raw body. |
| **No-fabrication principle** | A finding whose `quotedDocText` (contradiction) or `anchorSection` heading (addition) cannot be located in the doc body is **dropped** in `validateAndReconcile`. The reconciler's located line numbers are the source of truth; the LLM's emitted numbers are advisory. |
| **Workspace-token hard-fail guard (AC4)** | If `delfini_workspace_token` (input) or `DELFINI_WORKSPACE_TOKEN` (env) is supplied to the standalone action, it **fails loud** before any pipeline work — never silently downgrades to a Lite run. |
```
