# @delfini/cli

The plumbing layer of the Delfini Skill — local drift detection inside your coding agent (Claude Code), using the agent's existing LLM tokens. The CLI is deterministic and **never calls an LLM**; the host coding agent does, via the skill protocol scaffolded by `delfini install`.

## Installation

**Recommended: `npx @delfini/cli`** — zero install, always resolves the latest published version, no global PATH pollution. Fits the run-on-each-PR cadence of `/delfini`.

```bash
# Recommended — zero-install per invocation
npx @delfini/cli <subcommand>

# Alternative — global install (for offline / latency-sensitive teams)
npm install -g @delfini/cli

# In-repo dev iteration (when working on @delfini/cli itself)
pnpm install
pnpm --filter @delfini/cli build      # required once — bin/delfini.mjs imports from dist/
pnpm exec tsx packages/cli/bin/delfini.mjs <subcommand>
```

## Quick start

```bash
delfini install .
```

That scaffolds `.claude/skills/delfini/SKILL.md`, appends a `/delfini` auto-invocation block to `CLAUDE.md` (creating it if absent), and adds `.delfini-trace/` to `.gitignore`. From then on, invoking `/delfini` inside Claude Code drives the skill protocol — the host agent runs `delfini local-prepare`, dispatches a Claude subagent against the prepared prompt, runs `delfini local-finalize` on the subagent's findings, renders the report, and offers an apply UX.

## Subcommand reference

### `delfini install <path> [--tool <agent>]`

Idempotently scaffold the Skill into a target repo.

- `<path>` — repo root or any subdirectory; the install resolves up to the git root.
- `--tool <agent>` — coding-agent target. **Only `CLAUDE` is valid in V1** (design-spec NG2 — Claude-only by design); `CLAUDE` is the default.
- Writes: `.claude/skills/delfini/SKILL.md` (overwrites — the documented upgrade path); `CLAUDE.md` marker block (creates the file if absent; never duplicates on re-run); `.gitignore` appends `.delfini-trace/` if not already present.
- Exit codes: `0` success; non-zero on `--tool` other than `CLAUDE`, on a target outside a git repo, or on a filesystem write failure.

### `delfini local-prepare [--scope <paths>] [--base <ref>]`

Assemble the analysis input for the host agent to dispatch to a Claude subagent.

- `--scope <paths>` — comma-separated list overriding the persisted `.claude/skills/delfini/doc-scope.json`. Per-run only — does not modify the persisted file.
- `--base <ref>` — diff base ref. Defaults to `git merge-base HEAD origin/main`.
- `--relevance-threshold <N>` — render only the doc **sections** scoring at/above N against the diff, most-relevant-first up to the prompt budget. See [`@delfini/drift-engine`](../drift-engine/README.md#relevance-gating-opt-in)'s relevance-gating documentation for the scoring contract. **Default: `5` (token-efficient retrieval on)** — a measured ~40%+ prompt-token reduction on doc-heavy runs. Pass `--relevance-threshold 0` to disable retrieval and embed every in-scope doc whole. Example: `delfini local-prepare --relevance-threshold 8`.
- Writes three files to `.delfini-trace/`: `analysis-input.json`, `analysis-prompt.md`, `schema.json`.
- Exit codes:
  - `0` — success.
  - `2` — no doc-scope configured AND no `--scope` flag (NFR47 mode 5).
  - `4` — non-doc prompt payload alone exceeds the budget — i.e. the filtered diff + schema + instructions do not fit, or no doc section fits after ranked-fill (NFR47 mode 4); emits a `prompt_too_large` JSON payload on stdout suggesting a narrower scope, a smaller PR, or a smaller diff. Doc-only overflow no longer hard-fails: when `--relevance-threshold` is set, retained sections that exceed the budget are ranked-filled (most-relevant-first) and the run exits `0` with a `dropped N section(s) — over prompt budget` line on stderr.

### `delfini local-finalize <findings.json>`

Validate the subagent's findings, reconcile line numbers, render the report.

- `<findings.json>` — path to the subagent's output (the host agent writes it to `.delfini-trace/findings.json` per the skill protocol). Relative paths resolve against the repo root.
- Reads `.delfini-trace/analysis-input.json` to recover the docs array.
- Writes `.delfini-trace/report.md`; prints the same content to stdout.
- Exit codes:
  - `0` — no apply-eligible findings (drift + additive both empty; clarifications may still be reported informationally).
  - `1` — at least one drift or additive finding.
  - `3` — schema validation failure (NFR47 mode 1); emits a `{"error":"schema_validation","issues":[...]}` payload on stderr.

### `delfini --reset-scope`

Delete `.claude/skills/delfini/doc-scope.json`. Silent no-op if the file is absent or the current directory is outside a git repo. Exit code: `0`.

### `delfini --version`

Print the `@delfini/cli` version and exit. Exit code: `0`.

## Dev workflow

```bash
# Build (required before running bin/delfini.mjs under node)
pnpm --filter @delfini/cli build

# Type-check
pnpm --filter @delfini/cli typecheck

# Lint
pnpm --filter @delfini/cli lint

# Run the unit + integration test suite (vitest)
pnpm --filter @delfini/cli test

# Smoke-test the published artefact locally
pnpm --filter @delfini/cli build
cd packages/cli
npm pack
npm install -g ./delfini-cli-*.tgz
delfini --version
npm uninstall -g @delfini/cli
```

The vitest suite targets the TypeScript source directly (no build required). The `node bin/delfini.mjs ...` path imports the compiled `dist/cli.js`, so a build is required for manual bin invocation between source edits.

## What the CLI does NOT do

- **Never calls an LLM.** All LLM dispatch happens inside the skill protocol via the host coding agent's `Agent` tool (FR145). The CLI ships no Anthropic / OpenAI / LangChain client and reads no LLM API key.
- Never pushes to a remote, never opens or comments on PRs, never modifies anything outside the working tree.
- Never integrates with CI; the Delfini GitHub Action (`@delfini/action`) is a separate product that shares the underlying analysis algorithm via `@delfini/drift-engine`.

## Architecture

The CLI is one of three Delfini surfaces — the Skill (this package + `packages/drift-engine`), the Action (`apps/action`), and the hosted Web platform (`apps/web`). The Skill and the Action share `@delfini/drift-engine` as their analysis core, so a finding the Skill surfaces locally matches the finding the Action would surface on the eventual PR.

See the repository root README and the package source for the full design.
