// Story P3.9.2a AC7 — Lite-dist bundle-scan tripwire (release gate).
//
// Usage: node scripts/scan-lite-dist.mjs
//   (run after `pnpm --filter @delfini/action build`)
//
// The public Lite action's ncc bundle (apps/action/dist/index.js) must carry
// ZERO Full-only RUNTIME markers. Post-split the Full modules physically do
// not exist in the Lite tree (absence-by-construction); this scan is the
// release-time tripwire that catches any regression that reintroduces
// platform code into the public artifact.
//
// Runtime markers (Full-only, value-level — see the story's verified
// tripwire inventory):
//   - 'X-Delfini-Signature'   — the HMAC header literal (config-client /
//                               intake-client)
//   - routeStream / callIntakeSafely / buildIntakeInput — stream-routing
//                               export names (identifiers; this is why the
//                               scan comment-strips instead of minifying —
//                               a minifier would mangle them away)
//   - '/api/action-intake' + '/api/action-config' — the FR88d/FR88g fetch
//                               path literals
//
// ALLOWLIST (explicitly NOT markers — AC7):
//   - 'DELFINI_WORKSPACE_TOKEN' / 'delfini_workspace_token' — the AC4
//     hard-fail misconfiguration guard legitimately embeds both (it must
//     detect a mis-supplied token to fail loud). As a sanity check this scan
//     asserts they ARE present: their absence would mean the guard fell out
//     of the bundle.
//
// The scan reads ONLY the built bundle — never action.yml, README prose, or
// source comments (the bundle is comment-stripped before matching; the
// unminified ncc output retains source comments such as lite-pipeline.ts's
// `pending_review_exists` mention, which is prose, not runtime code).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exit } from 'node:process'
import { fileURLToPath } from 'node:url'
import { stripJsComments } from './strip-js-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'apps', 'action', 'dist', 'index.js')

const RUNTIME_MARKERS = [
  'X-Delfini-Signature',
  'routeStream',
  'callIntakeSafely',
  'buildIntakeInput',
  '/api/action-intake',
  '/api/action-config',
]

const ALLOWLIST_MUST_BE_PRESENT = ['DELFINI_WORKSPACE_TOKEN', 'delfini_workspace_token']

let raw
try {
  raw = readFileSync(bundlePath, 'utf8')
} catch {
  console.error(
    `FAIL: ${bundlePath} not found — build the Lite bundle first ` +
      '(pnpm --filter @delfini/action build).',
  )
  exit(2)
}

const stripped = stripJsComments(raw)

const hits = RUNTIME_MARKERS.filter((marker) => stripped.includes(marker))
if (hits.length > 0) {
  console.error(
    `FAIL: Full-only runtime marker(s) found in the comment-stripped Lite bundle: ` +
      `${hits.join(', ')}. The public Lite artifact must not contain platform code — ` +
      'see Story P3.9.2a AC7.',
  )
  exit(1)
}

const missingGuard = ALLOWLIST_MUST_BE_PRESENT.filter((s) => !stripped.includes(s))
if (missingGuard.length > 0) {
  console.error(
    `FAIL: expected guard string(s) missing from the Lite bundle: ${missingGuard.join(', ')}. ` +
      'The AC4 hard-fail misconfiguration guard must ship in the public artifact.',
  )
  exit(1)
}

console.log(
  `PASS: Lite bundle (${bundlePath}) is clean — 0/${RUNTIME_MARKERS.length} Full-only ` +
    'runtime markers after comment-strip; AC4 guard strings present.',
)
