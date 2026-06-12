import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// =====================================================================
// Story P3.9.2a AC3 — pack-install smoke (release gate).
//
// Proves consumption mode (b): the PUBLISHED @delfini/action-core tarball,
// installed into a scratch project via plain node_modules resolution (no
// workspace links, no bundler), can import the package and resolve + read
// drift-engine's prompt.md. This is the exact mechanism delfini-web's Full
// action will rely on after the P3.9.4 exact-pin flip.
//
// Mechanics: `pnpm pack` rewrites `workspace:*` to the real drift-engine
// version (same as publish). BOTH tarballs (action-core + drift-engine) are
// packed locally and installed as direct file: deps — npm satisfies
// action-core's drift-engine dependency with the root-installed tarball copy
// (same version), so the smoke never needs the CURRENT drift-engine version
// to exist on the registry. This matters at publish time: the release gates
// run BEFORE the publish, so a version-bump commit would otherwise
// chicken-and-egg (the gate demanding from the registry the very version the
// gated publish is about to create — exactly how the 0.2.0 bump broke).
// Third-party runtime deps still come from the registry — this test REQUIRES
// network access and built dist/ for both packages. Opt out locally
// (offline) with DELFINI_SKIP_PACK_SMOKE=1 — CI always runs it.
// =====================================================================

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const driftEngineDir = resolve(here, '..', '..', 'drift-engine')

const skip = process.env.DELFINI_SKIP_PACK_SMOKE === '1'

describe.skipIf(skip)('pack-install smoke (AC3 — published-tarball consumption)', () => {
  it(
    'pnpm pack → npm install in a scratch project → import → loadPromptTemplate() is non-empty',
    () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delfini-pack-smoke-'))
      try {
        // 1. Pack BOTH built packages (workspace: protocol rewritten by pnpm).
        //    drift-engine is packed too so the scratch install resolves it
        //    from the local tarball, not the registry (pre-publish versions
        //    don't exist there yet — see the header).
        for (const dir of [pkgDir, driftEngineDir]) {
          execFileSync('pnpm', ['pack', '--pack-destination', tmp], {
            cwd: dir,
            stdio: 'pipe',
            shell: process.platform === 'win32',
          })
        }
        const tarballs = readdirSync(tmp).filter((f) => f.endsWith('.tgz'))
        const actionCoreTarball = tarballs.find((f) => f.startsWith('delfini-action-core-'))
        const driftEngineTarball = tarballs.find((f) => f.startsWith('delfini-drift-engine-'))
        expect(actionCoreTarball).toBeDefined()
        expect(driftEngineTarball).toBeDefined()

        // 2. Scratch project depending on both tarballs by file: path — the
        //    direct drift-engine entry satisfies action-core's dependency at
        //    the identical version, so npm never consults the registry for it.
        const scratch = join(tmp, 'scratch')
        execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(scratch)})`], {
          stdio: 'pipe',
        })
        writeFileSync(
          join(scratch, 'package.json'),
          JSON.stringify(
            {
              name: 'delfini-pack-smoke-scratch',
              private: true,
              type: 'module',
              dependencies: {
                '@delfini/action-core': `file:../${actionCoreTarball}`,
                '@delfini/drift-engine': `file:../${driftEngineTarball}`,
              },
            },
            null,
            2,
          ),
        )
        execFileSync(
          'npm',
          ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
          { cwd: scratch, stdio: 'pipe', shell: process.platform === 'win32' },
        )

        // 3. Import the installed package and read the template through the
        //    same code path the orchestrator uses at runtime.
        const probe =
          "import('@delfini/action-core').then((m) => {" +
          ' const t = m.loadPromptTemplate();' +
          " if (typeof t !== 'string' || t.length < 100) throw new Error('template empty');" +
          " console.log('PROMPT_OK ' + t.length);" +
          '})'
        const out = execFileSync('node', ['-e', probe], {
          cwd: scratch,
          stdio: 'pipe',
          encoding: 'utf8',
        })
        expect(out).toContain('PROMPT_OK')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    { timeout: 300_000 },
  )
})
