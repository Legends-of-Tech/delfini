# Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to manage versioning and
the changelog for the npm-published packages **`@delfini/cli`**, **`@delfini/drift-engine`**, and
**`@delfini/action-core`**.

## Prerequisites

- `pnpm` (already required to work in this repo)
- `gh` (GitHub CLI) — only required for the local maintainer release flow below, to source a
  GitHub token for `@changesets/changelog-github`. Install per [cli.github.com](https://cli.github.com/)
  and run `gh auth login` once.

## Scope: `@delfini/cli` + `@delfini/drift-engine` + `@delfini/action-core`

Changesets-tracked **published** packages:

- **`@delfini/cli`** — the npm-published CLI package. Bumped + released by changesets.
- **`@delfini/drift-engine`** — published to npm in its own right (`private: false` +
  `publishConfig.access: public`). It is **also** still bundled into `@delfini/cli` via tsup
  (`noExternal` — keep-bundling), so a drift-engine change ships both as its own
  `@delfini/drift-engine` release and inside the CLI's published artefact.
- **`@delfini/action-core`** — the shared Action analysis-pipeline core consumed by
  `apps/action` (the standalone Lite action in this repo) via `workspace:*`, and by the
  hosted Delfini platform at exact version pins.

Explicitly **untracked** (in [`config.json`](./config.json) `ignore`): `@delfini/action`.

`@delfini/action` ships as a GitHub Action (consumed via a
`uses: Legends-of-Tech/delfini/apps/action@<tag>` subdirectory reference, with `dist/` built at
release tags); it has no npm release cadence and changesets must not generate version bumps or
CHANGELOG entries for it.

> **Adding a new workspace package?** Any new package added to `pnpm-workspace.yaml` (`packages/*`
> or `apps/*`) is **tracked by changesets by default**. If the new package is internal and should
> never reach npm, add it to the `ignore` list in `config.json` in the same PR — otherwise a future
> `changeset version` will silently bump it and a future `changeset publish` will try to publish it.

## When do I need a changeset?

Add a changeset on any PR that changes:

- `packages/cli/**`
- `packages/drift-engine/**` (it's bundled into the CLI, so a change there ships in the CLI)
- `packages/action-core/**` (published in its own right; the Delfini platform pins it exactly)

A CI check (`.github/workflows/changeset-check.yml`) fails PRs touching those paths without a
pending changeset.

## How to add one

```bash
pnpm changeset
```

Pick the package(s) the change is user-visible in: `@delfini/cli` for CLI-surface changes,
`@delfini/drift-engine` for engine changes (it publishes in its own right —
`updateInternalDependencies: "patch"` auto-bumps the CLI alongside it, since drift-engine is
bundled into the CLI). Choose the semver bump (`patch` / `minor` / `major`) and write a short
**user-facing** summary (it becomes the CHANGELOG entry). Commit the generated
`.changeset/*.md` file with your PR.

For a change that genuinely needs no version bump (e.g. internal test-only refactor), create an
empty changeset:

```bash
pnpm changeset --empty
```

## Impact tags — prefix your summary with a `[marker]`

The generated `CHANGELOG.md` prepends a **surface impact tag** to every entry so readers can see at a
glance which part of the product moved:

| Marker (start of summary) | Rendered tag |
| --- | --- |
| `[drift-engine] …` | 🔬 drift-engine |
| `[skill] …` | 🔄 SKILL.md |
| `[cli] …` | ⚙️ CLI |
| `[action-core] …` | 🧩 action-core |
| _(no marker, or an unknown one)_ | ⚙️ CLI (default) |

So a changeset summary like `[drift-engine] Tighten the contradiction prompt` renders as
`- 🔬 drift-engine: Tighten the contradiction prompt`. The marker is **stripped** from the rendered
text — only the tag remains.

Why a summary marker and not the changed file paths? At changelog-generation time the changelog
function only sees the changeset summary + commit, **not** the diff; and every changeset is authored
as a `@delfini/cli` bump (drift-engine is bundled into the CLI), so neither the paths nor the package
can identify the surface. The marker is the one deterministic signal. The mapping lives in
[`changelog-impact.cjs`](./changelog-impact.cjs) (a thin wrapper over `@changesets/changelog-github`,
wired via the `changelog` field in [`config.json`](./config.json)).

## Maintainer release flow

Releases are normally fully automated: merging a PR with a changeset to `main` makes
`.github/workflows/cli-auto-release.yml` open (or update) a "Version Packages" PR; merging that
PR auto-publishes to npm. The manual fallback (`.github/workflows/cli-release.yml`,
`workflow_dispatch`) and the local commands below exist for recovery scenarios.

```bash
pnpm version-packages   # changeset version — consumes pending changesets, bumps the package.json(s), writes CHANGELOG.md
# review the version bump + CHANGELOG, commit
DELFINI_PUBLISH_OK=1 pnpm release   # changeset publish — publishes the unpublished versions to npm
```

`pnpm release` (`changeset publish`) is the byte-identical publish command used by the automated
pipeline and the manual fallback workflow.

> **Why `DELFINI_PUBLISH_OK=1`?** `packages/cli/package.json` has a `prepublishOnly` guard that
> blocks accidental direct `npm publish` invocations (e.g. muscle memory in `packages/cli/`). The
> legitimate changesets-driven path sets the env var to bypass the guard. The release workflows set
> it too.

## `GITHUB_TOKEN` is required for `changeset version`

`@changesets/changelog-github` calls the GitHub API to resolve commit → PR → author links when
generating the changelog. `pnpm version-packages` therefore needs a `GITHUB_TOKEN` in the
environment (a classic PAT with read access to the repo is enough; locally you can use
`GITHUB_TOKEN=$(gh auth token)`). In CI the token is provided automatically. Without it,
`changeset version` errors with "Please provide a GitHub token".

## Local validate-then-revert smoke test

To verify the infrastructure end-to-end **without** touching npm:

```bash
pnpm install

# 1. confirm the config validates and the pending changesets are recognised
pnpm exec changeset status

# 2. exercise the version bump path (writes CHANGELOG via the github changelog generator)
GITHUB_TOKEN=$(gh auth token) pnpm version-packages

# 3. validate the publish path on the built bundle (no network call)
pnpm --filter @delfini/drift-engine build
pnpm --filter @delfini/cli build
( cd packages/cli && npm publish --dry-run )

# REVERT — do NOT commit any of the above:
git restore .changeset packages/cli/package.json packages/cli/CHANGELOG.md
```

> **`changeset publish --dry-run` does NOT exist** — `@changesets/cli` only ships `--tag` / `--otp`
> / `--no-git-tag`. The smoke test uses `npm publish --dry-run` on the built bundle instead, which
> exercises the same publishability constraints (scope, access, file manifest) with no network
> call.

> **Critical:** `pnpm version-packages` consumes (deletes) every pending `.changeset/*.md`,
> including any real pending entry. Always `git restore .changeset` after the smoke test so pending
> changesets survive for the next real release. The smoke test is for validation only — commit
> only the infrastructure, never the smoke-test version bump or generated CHANGELOG. Consider
> running the smoke test in a `git worktree` to isolate it from your working tree.
