import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// =====================================================================
// Bundled-install regression smoke (P3.9.3 AC8.1 fallout).
//
// `delfini install` resolves templates/ relative to import.meta.url — and the
// module DEPTH differs between the source layout (src/commands/, two levels
// up) and the tsup bundle (dist/cli.js, ONE level up). A fixed `../../`
// passed every source-mode test while `npx @delfini/cli install` was broken
// in every published release up to 0.1.1 (resolved
// node_modules/@delfini/templates — ENOENT). This smoke runs install through
// the REAL bin entry (bin/delfini.mjs → dist/cli.js), so a depth regression
// in the bundled layout fails here before it ships.
//
// Requires a built dist/ (`pnpm --filter @delfini/cli build`) — same
// precondition as bundled-parity.test.ts (gate C runs post-build in CI).
// =====================================================================

const here = dirname(fileURLToPath(import.meta.url))
const binEntry = resolve(here, '..', 'bin', 'delfini.mjs')
const distBundle = resolve(here, '..', 'dist', 'cli.js')

describe.skipIf(!existsSync(distBundle))('bundled install smoke (bin → dist/cli.js)', () => {
  it('scaffolds .claude/skills/delfini/SKILL.md in a scratch git repo via the bundle', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'delfini-bundled-install-'))
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', scratch, ...args], { stdio: 'pipe' })
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@delfini.local')
      git('config', 'user.name', 'Delfini Test')
      writeFileSync(join(scratch, 'README.md'), '# scratch\n')
      git('add', '.')
      git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init')

      const out = execFileSync('node', [binEntry, 'install', scratch, '--no-auto-invoke'], {
        stdio: 'pipe',
        encoding: 'utf8',
      })

      expect(existsSync(join(scratch, '.claude', 'skills', 'delfini', 'SKILL.md'))).toBe(true)
      expect(out).toContain('SKILL.md')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
