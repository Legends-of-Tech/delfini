# Delfini

Doc-drift detection for software teams: catch pull requests whose code changes contradict your
project's source-of-truth documentation — before they merge.

This is the open-source Delfini monorepo (Apache-2.0). It contains four workspace packages:

| Package | What it is | Distribution |
|---|---|---|
| [`packages/drift-engine`](./packages/drift-engine) | Pure-logic drift-analysis core (prompt assembly, schema, reconciliation, doc-scope algebra). No I/O, no LLM client. | npm: [`@delfini/drift-engine`](https://www.npmjs.com/package/@delfini/drift-engine) |
| [`packages/cli`](./packages/cli) | The Delfini Skill CLI — local drift detection inside your coding agent (Claude Code), using the agent's existing LLM tokens. Deterministic; never calls an LLM itself. | npm: [`@delfini/cli`](https://www.npmjs.com/package/@delfini/cli) |
| [`packages/action-core`](./packages/action-core) | Shared analysis-pipeline core of the Delfini GitHub Action (doc reader, smart-skip, analysis-input assembly, orchestrator adapters). | npm: [`@delfini/action-core`](https://www.npmjs.com/package/@delfini/action-core) |
| [`apps/action`](./apps/action) | The standalone Delfini GitHub Action — analyses a PR in CI with your own LLM provider key and posts a rich structured-findings comment. | GitHub Action (subdirectory `uses:` reference — see below). Never published to npm. |

All three npm packages ship from this repo via [changesets](./.changeset/README.md). The Skill
(CLI) and the Action share `@delfini/drift-engine` as their analysis core, so a finding the Skill
surfaces locally is the same finding the Action surfaces on the eventual PR — algorithm parity
by construction.

## Quick start — the Skill (local drift detection in Claude Code)

```bash
# Zero-install, always-fresh (recommended)
npx @delfini/cli install .
```

That scaffolds `.claude/skills/delfini/SKILL.md` into your repo. From then on, `/delfini` inside
Claude Code runs local drift detection against your working tree — no Delfini API key, no GitHub
App, no new credentials: the analysis runs on your coding agent's existing LLM tokens. See
[`packages/cli/README.md`](./packages/cli/README.md) for the full subcommand reference.

## Quick start — the GitHub Action (drift detection in CI)

The Action is consumed as a **monorepo-subdirectory reference**:

```yaml
- name: Run Delfini
  uses: Legends-of-Tech/delfini/apps/action@<tag>
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
    LLM_PROVIDER: anthropic
  with:
    doc_scope: |
      docs
      README.md
      docs/adr/**/*.md
    enforcement: warning
```

`doc_scope` accepts a newline- or comma-delimited list of entries; each entry may be a directory
(recursive `.md` scan), a single file, or a glob (picomatch@4 dialect). It defaults to `docs/`
when omitted. See [`apps/action/README.md`](./apps/action/README.md) for the full input/env
reference and doc-exclusion semantics.

> **Marketplace listing:** a monorepo-subdirectory action cannot be listed on the GitHub
> Marketplace, so Delfini is not Marketplace-listed for now. A single-action mirror repository is
> the deferred mechanism if a Marketplace listing is added later. Pin to a release tag via the
> subdirectory `uses:` reference above.

### This action is standalone by design (the workspace-token hard-fail guard)

This open-source action runs entirely standalone: it reads docs and diff from your repo, calls
your own LLM provider key, and posts its findings as a single rich PR comment. It makes **no**
calls to the hosted Delfini platform.

If a Delfini workspace token is supplied (a `delfini_workspace_token` input or a
`DELFINI_WORKSPACE_TOKEN` env var), the action **hard-fails with a misconfiguration error**
rather than silently running standalone. Pairing with the hosted Delfini platform
(workspace-managed doc scope, hosted review surface, Approve-and-Commit) is a separate
distribution that ships with the Delfini platform — see the Delfini platform documentation for
that setup. The hosted platform is developed in a separate private repository
(`Legends-of-Tech/delfini-platform`).

## Repository layout

```
apps/action/            The standalone GitHub Action (ncc-bundled; dist/ built at release tags)
packages/drift-engine/  Pure-logic analysis core (published: @delfini/drift-engine)
packages/action-core/   Shared Action pipeline core (published: @delfini/action-core)
packages/cli/           The Skill CLI (published: @delfini/cli; bundles drift-engine via tsup)
scripts/                Release-gate scan scripts (Lite-dist scan, action-core tarball scan)
.changeset/             Release machinery (changesets config + impact-tag changelog formatter)
.claude/skills/delfini/ The product Skill artefact (what `delfini install` scaffolds)
```

## Development

Requirements: Node.js 20+, [pnpm](https://pnpm.io/) 10+.

```bash
pnpm install

# Build (order matters: drift-engine → action-core → cli → action)
pnpm --filter @delfini/drift-engine build
pnpm --filter @delfini/action-core build
pnpm --filter @delfini/cli build
pnpm --filter @delfini/action build

# Verify
pnpm typecheck
pnpm lint
pnpm test
```

Three release gates are required-green on every PR touching the published packages
(see [`.github/workflows/cli-auto-release.yml`](./.github/workflows/cli-auto-release.yml)):

- **Gate A** — drift-engine prompt-snapshot parity (`pnpm --filter @delfini/drift-engine test`)
- **Gate B-lite** — Lite action + action-core suites (`pnpm --filter @delfini/action test` and
  `pnpm --filter @delfini/action-core test`)
- **Gate C** — bundled-CLI parity (`pnpm --filter @delfini/cli test`, after the drift-engine +
  cli builds)

Releases are automated with changesets — see [`.changeset/README.md`](./.changeset/README.md)
and [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE)
