// Story P3.9.2a AC3 — ncc-dist prompt.md asset check (release gate).
//
// Usage: node scripts/check-dist-prompt-asset.mjs <distDir>
//   e.g. node scripts/check-dist-prompt-asset.mjs apps/action/dist
//        node scripts/check-dist-prompt-asset.mjs apps/action-full/dist
//
// Verifies that the ncc build relocated drift-engine's prompt.md into the
// action's dist/ and that the bundle is wired to read it at runtime:
//   1. dist/ contains at least one .md asset BYTE-IDENTICAL to
//      packages/drift-engine/src/prompt.md (webpack 5 emits `new URL(<lit>,
//      import.meta.url)` references as content-hashed assets — the filename
//      is not stable, the content is);
//   2. dist/index.js references that emitted asset filename (the rewritten
//      `new URL(/* asset import */ ...)` expression), proving the bundled
//      loadTemplate() resolves the relocated file rather than a path that
//      only exists in the source tree.
//
// Exit 0 on pass; exit 1 with a diagnostic on any failure.

import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { exit } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const distDir = process.argv[2]
if (!distDir) {
  console.error('usage: node scripts/check-dist-prompt-asset.mjs <distDir>')
  exit(2)
}

// Resolve the canonical template through drift-engine's package export — the
// same resolution the action-core build copy uses (no repo-relative source
// path). The require context is packages/action-core (which declares the
// dependency); the repo root does not depend on drift-engine, so resolving
// from this script's own location would fail under pnpm's strict layout.
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(
  pathToFileURL(join(here, '..', 'packages', 'action-core', 'package.json')),
)
const promptPath = require.resolve('@delfini/drift-engine/prompt.md')
const promptContent = readFileSync(promptPath)

const mdFiles = readdirSync(distDir).filter((f) => f.endsWith('.md'))
if (mdFiles.length === 0) {
  console.error(
    `FAIL: no .md asset found in ${distDir} — ncc did not relocate prompt.md. ` +
      'The orchestrator template reference is no longer asset-traceable ' +
      '(it must stay `new URL(<static literal>, import.meta.url)`).',
  )
  exit(1)
}

const matching = mdFiles.filter((f) =>
  readFileSync(join(distDir, f)).equals(promptContent),
)
if (matching.length === 0) {
  console.error(
    `FAIL: ${distDir} contains .md asset(s) [${mdFiles.join(', ')}] but none is ` +
      'byte-identical to packages/drift-engine prompt.md — the relocated asset is stale ' +
      'or belongs to something else. Rebuild @delfini/action-core (its build copies the ' +
      'template) and the action bundle.',
  )
  exit(1)
}

const bundle = readFileSync(join(distDir, 'index.js'), 'utf8')
const referenced = matching.filter((f) => bundle.includes(f))
if (referenced.length === 0) {
  console.error(
    `FAIL: prompt.md asset [${matching.join(', ')}] is present in ${distDir} but ` +
      'dist/index.js never references it — the bundled loadTemplate() cannot read it.',
  )
  exit(1)
}

console.log(
  `PASS: ${distDir} carries prompt.md as [${referenced.join(', ')}] ` +
    `(${promptContent.length} bytes, byte-identical to drift-engine) and the bundle references it.`,
)
