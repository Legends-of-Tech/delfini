# Delfini GitHub Action

Standalone doc-drift detection for pull requests: checks whether a PR's code changes contradict
the project's source-of-truth documentation and posts a single rich structured-findings comment
on the PR, plus a GitHub check.

This action runs entirely in your CI with your own LLM provider key. It makes **no calls to any
Delfini-hosted service**. See [`action.yml`](./action.yml) for the full input/env reference.

## Using the action

The action is consumed as a **monorepo-subdirectory reference** — pin to a release tag:

```yaml
- name: Run Delfini
  uses: Legends-of-Tech/delfini/apps/action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
    LLM_PROVIDER: anthropic
  with:
    doc_scope: docs
    enforcement: warning
```

The compiled `dist/` bundle is attached to release tags by the release process; `main` carries
source only. Do not pin to `@main`.

> **Marketplace listing:** a monorepo-subdirectory action cannot be listed on the GitHub
> Marketplace, so Delfini is not Marketplace-listed for now. A single-action mirror repository is
> the deferred mechanism if a listing is added later.

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `doc_scope` | no | `docs/` | Newline- or comma-delimited list of source-of-truth paths. Each entry may be a directory (recursive `.md` scan), a single file, or a glob (picomatch@4 dialect). |
| `enforcement` | no | `warning` | `required` blocks merge on FAIL; `warning` is advisory only. |
| `enable_diff_prefilter` | no | `false` | Opt-in deterministic diff pre-filter: drops lockfile/generated/vendored/fixture paths plus whitespace-only and import-only hunks before prompt assembly. |

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | yes | Used to read the PR and post the findings comment + check. |
| `LLM_API_KEY` | yes | API key for your LLM provider. |
| `LLM_PROVIDER` | no | `anthropic` (default) or `openai`. |
| `LLM_MODEL` | no | Overrides the provider's default model. |
| `LANGSMITH_API_KEY` / `LANGSMITH_TRACING` | no | Optional LangSmith tracing for debuggability. |

## This action is standalone by design (workspace-token hard-fail guard)

If a Delfini workspace token is supplied — a `delfini_workspace_token` input or a
`DELFINI_WORKSPACE_TOKEN` env var — this action **hard-fails with a misconfiguration error**
rather than silently running standalone. Pairing with the hosted Delfini platform
(workspace-managed doc scope, hosted review surface, Approve-and-Commit) is a separate
distribution that ships with the Delfini platform; see the Delfini platform documentation for
that setup.

## Selecting documents to analyze

Doc scope comes from the `doc_scope` input, defaulting to `docs/`.

**Multi-entry example** — point at multiple folders, a specific file, and a glob in one step:

```yaml
with:
  doc_scope: |
    docs
    packages/cli/README.md
    docs/adr/**/*.md
```

Repo-side configuration files (`.delfinidocs`, `.delfiniignore`) are **not** read. The only
repo-side mechanism that affects what gets analysed is per-file YAML front-matter (below) —
visible in the doc's own diff, so there's no out-of-band side-channel for excluding
source-of-truth content.

## Excluding individual documents from analysis

Within the configured scope, YAML front-matter lets you mark a single file as
not-source-of-truth so Delfini doesn't spend LLM tokens on it.

**Shorthand:**

```markdown
---
delfini: ignore
---

# Speculative Future Architecture

This document is an early sketch, not ratified.
```

**Verbose, with a reason field for future maintainers:**

```markdown
---
delfini:
  ignore: true
  reason: Early sketch — not ratified; do not treat as source of truth.
---
```

## How it relates to the other Delfini surfaces

The action shares its analysis core (`@delfini/drift-engine`) and pipeline core
(`@delfini/action-core`) with the Delfini Skill CLI (`@delfini/cli`), so a finding the Skill
surfaces locally is the same finding this action surfaces on the eventual PR — algorithm parity
by construction. All three packages ship from this repository.
