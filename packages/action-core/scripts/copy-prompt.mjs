// Build-step copy of drift-engine's canonical prompt.md into this package's
// dist/, next to the compiled orchestrator (dist/adapters/single-call/).
//
// Why (Story P3.9.2a, AC3 — prompt.md dual-mode resolution): the orchestrator
// references the template via `new URL('./prompt.md', import.meta.url)` — the
// one shape BOTH consumption modes handle:
//   (a) plain node_modules resolution of the published tarball — the copied
//       file ships inside `dist/` (`files: ["dist"]`), adjacent to
//       orchestrator.js, so the relative URL resolves on disk; and
//   (b) ncc/webpack bundling by the action artifacts — webpack 5 natively
//       understands `new URL(<static literal>, import.meta.url)`, emits the
//       referenced file as a dist asset, and rewrites the URL expression
//       (verified: the bundle carries `new URL(__nccwpck_require__(<asset>),
//       __nccwpck_require__.b)`). Do NOT wrap the reference in fileURLToPath —
//       that masks the asset-reference shape webpack detects.
//
// The source is resolved THROUGH @delfini/drift-engine's package exports
// (`"./prompt.md": "./src/prompt.md"`) — never a repo-relative path — so the
// copy stays correct wherever drift-engine resolves from (workspace link in
// the monorepo, node_modules in any future layout). This kills the staleness
// risk called out in the story's Dev Notes: every build re-copies from the
// resolved drift-engine version.

import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const promptSrc = require.resolve('@delfini/drift-engine/prompt.md')

const here = dirname(fileURLToPath(import.meta.url))
const dest = join(here, '..', 'dist', 'adapters', 'single-call', 'prompt.md')

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(promptSrc, dest)
console.log(`copy-prompt: ${promptSrc} -> ${dest}`)
