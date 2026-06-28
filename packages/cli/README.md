# @delfini/cli

The command-line companion for the **Delfini Skill** — local documentation-drift detection inside your coding agent ([Claude Code](https://claude.com/claude-code)).

[Delfini](https://github.com/Legends-of-Tech/delfini) detects when a code change has made your docs wrong and proposes the one-click fix. The Skill is the way to run that check *before you open a PR*, right in your editor. The CLI is deterministic and **never calls an LLM itself** — your coding agent does the analysis with its own tokens, which is why the Skill costs your team nothing new: no Delfini account, no API key, no GitHub App.

## Install

```bash
# Recommended — zero-install, always the latest version
npx @delfini/cli <subcommand>

# Or install globally
npm install -g @delfini/cli
```

## Quick start

```bash
delfini install .
```

This scaffolds `.claude/skills/delfini/SKILL.md` into your repo, offers to auto-invoke `/delfini` when you open a PR, and gitignores the per-run trace folder. From then on, running `/delfini` in Claude Code analyzes your working tree against your docs and offers to apply the fixes:

```
Apply all (a) / Pick subset (s) / Skip (n)?
```

Under the hood the coding agent runs `delfini local-prepare`, dispatches a subagent against the prepared prompt, runs `delfini local-finalize` on the findings, and applies the approved edits — all using your agent's existing tokens.

## Commands

### `delfini install <path>`

Scaffold the Skill into a repo (idempotent — safe to re-run).

- `<path>` — repo root or any subdirectory; resolves up to the git root.
- Writes `.claude/skills/delfini/SKILL.md`, appends a `/delfini` block to `CLAUDE.md` (creating it if absent, never duplicating), and adds `.delfini-trace/` to `.gitignore`.
- Always creates `.claude/skills/delfini/delfini-config.json` with both `doc_scope` and `ignore_code_scope` fields (empty arrays when prompts are skipped or stdin is non-TTY), giving the team a committed, hand-editable template.
- `--ignore-code-scope <paths>` — seed `ignore_code_scope` without prompting (mirrors `--scope`).

### `delfini local-prepare [--scope <paths>] [--ignore-code-scope <paths>] [--base <ref>] [--relevance-threshold <N>]`

Assemble the analysis input for the coding agent to dispatch.

- `--scope <paths>` — comma-separated paths overriding the persisted `doc_scope`, for this run only.
- `--ignore-code-scope <paths>` — comma-separated code paths whose changes are ignored for analysis (directories, files, or globs), overriding the persisted `ignore_code_scope` for this run only.
- `--base <ref>` — diff base ref. Defaults to `git merge-base HEAD origin/main`.
- `--relevance-threshold <N>` — render only the doc sections scoring at/above `N` against the diff, most-relevant-first up to the prompt budget. **Default `5`** (a measured ~40% prompt-token reduction on doc-heavy runs); pass `0` to embed every in-scope doc whole.
- Writes `analysis-input.json`, `analysis-prompt.md`, and `schema.json` to `.delfini-trace/`.

### `delfini local-finalize <findings.json>`

Validate the subagent's findings, reconcile line numbers, and render the report.

- Writes `.delfini-trace/report.md` and prints it to stdout.
- Exit code `0` when there are no drift/additive findings to apply, `1` when there are.

### `delfini diff-status`

Report the branch's change state as JSON (used by the Skill protocol to choose what to analyze).

### `delfini --reset-scope`

Delete the persisted `.claude/skills/delfini/delfini-config.json` (and any legacy `doc-scope.json`).

### `delfini --version`

Print the version.

## What the CLI does NOT do

- **Never calls an LLM.** All analysis is dispatched by your coding agent; the CLI ships no Anthropic / OpenAI / LangChain client and reads no API key.
- **Never touches the remote.** It doesn't push, open PRs, or comment — it only reads your working tree and writes the doc fixes you approve.
- **Doesn't run in CI.** The Delfini [GitHub Action](https://github.com/Legends-of-Tech/delfini) is the CI surface; it shares the same analysis core ([`@delfini/drift-engine`](https://www.npmjs.com/package/@delfini/drift-engine)), so a finding the Skill surfaces locally matches what the Action would surface on the PR.

## License

[Apache-2.0](https://github.com/Legends-of-Tech/delfini/blob/main/LICENSE)
