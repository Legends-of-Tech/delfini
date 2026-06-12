#!/usr/bin/env node
// Executable entry point for the `delfini` CLI.
//
// All routing logic lives in src/cli.ts (compiled to dist/cli.js — the
// published artefact). The .mjs extension here keeps this file ESM
// regardless of how the consumer's package.json declares "type".
//
// Imports from `../dist/cli.js`: that is the canonical published target.
// Published consumers (`npm install -g @delfini/cli`) only get `dist/` via
// the `"files"` allow-list in package.json. In-repo iteration must run
// `pnpm --filter @delfini/cli build` once so dist/ exists; thereafter
// `node packages/cli/bin/delfini.mjs ...` works from the repo root, and
// the vitest suite (which targets `src/` directly) does not need a build.
//
// `process.exitCode = 1` is used in preference to `process.exit(1)` so
// that pending stdout writes flush naturally as the event loop drains.

import { main } from '../dist/cli.js'

main(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
