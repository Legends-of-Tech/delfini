#!/usr/bin/env node
// prepublishOnly guard for @delfini/cli (Story P3.5.3 / P3.5.2).
//
// Blocks accidental direct `npm publish` invocations (e.g. muscle memory in
// packages/cli/) that would burn a registry version slot before the planned
// changesets-driven publish runs.
//
// The legitimate publish paths set DELFINI_PUBLISH_OK=1 to bypass:
//   - Local maintainer release: `DELFINI_PUBLISH_OK=1 pnpm release` (repo root).
//   - CI workflow_dispatch fallback: `.github/workflows/cli-release.yml`.
//   - P3.5.4 on-merge auto-release pipeline.
//
// NOTE: this script is intentionally a standalone file rather than an inline
// `node -e "..."` block in package.json. The inline form embedded backticks
// (around command names like `npm publish`) inside the script text, which
// POSIX shells on Linux interpret as command substitution before node sees
// the string — breaking the script in any non-Windows CI environment.

if (!process.env.DELFINI_PUBLISH_OK) {
  console.error(
    '\n  Direct npm publish is blocked.' +
      '\n  Use `pnpm release` from the repo root (changesets-driven).' +
      '\n  Story P3.5.2 owns the first publish; do not bypass.' +
      '\n  Override for legitimate publish paths: set DELFINI_PUBLISH_OK=1.\n',
  )
  process.exit(1)
}
