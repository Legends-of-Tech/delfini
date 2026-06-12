import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resolvePromptTemplatePath } from '../src/commands/local-prepare'

// Regression coverage for the bundled-`prompt.md` resolution bug.
//
// drift-engine is pure-logic and ships its canonical template at
// `src/prompt.md`. The CLI must load that template at runtime to call
// `buildPrompt(input, template)`. Two layouts exist:
//   - SOURCE (tsx / vitest): the running module is
//     `packages/cli/src/commands/local-prepare.ts`, and the template lives at
//     `packages/drift-engine/src/prompt.md` (up 3 dirs).
//   - BUNDLED (tsup `dist/cli.js`, monorepo OR published @delfini/cli tarball):
//     the running module is one dir shallower (`dist/cli.js`), AND
//     `@delfini/drift-engine` is `private:true` / never on npm, so the ONLY
//     copy of the template a published CLI has is the one tsup copies to
//     `dist/prompt.md` next to `cli.js`.
//
// A single fixed relative path cannot serve both layouts (different module
// depth) — the resolver tries the bundled-adjacent copy first, then the
// monorepo source fallback.

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'delfini-prompt-res-'))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('resolvePromptTemplatePath — layout-aware prompt.md resolution', () => {
  it('BUNDLED layout: returns the dist-adjacent ./prompt.md next to cli.js', () => {
    // <tmp>/dist/cli.js  +  <tmp>/dist/prompt.md
    const root = makeTmpDir()
    const distDir = join(root, 'dist')
    mkdirSync(distDir, { recursive: true })
    const cliJs = join(distDir, 'cli.js')
    const promptMd = join(distDir, 'prompt.md')
    writeFileSync(cliJs, '// bundle', 'utf8')
    writeFileSync(promptMd, '# bundled template', 'utf8')

    const resolved = resolvePromptTemplatePath(pathToFileURL(cliJs))
    expect(resolved).toBe(promptMd)
    expect(readFileSync(resolved, 'utf8')).toBe('# bundled template')
  })

  it('SOURCE layout: falls back to ../../../drift-engine/src/prompt.md when no dist-adjacent copy exists', () => {
    // <tmp>/packages/cli/src/commands/local-prepare.ts
    // <tmp>/packages/drift-engine/src/prompt.md
    const root = makeTmpDir()
    const moduleFile = join(root, 'packages', 'cli', 'src', 'commands', 'local-prepare.ts')
    mkdirSync(dirname(moduleFile), { recursive: true })
    writeFileSync(moduleFile, '// source', 'utf8')

    const sourcePrompt = join(root, 'packages', 'drift-engine', 'src', 'prompt.md')
    mkdirSync(dirname(sourcePrompt), { recursive: true })
    writeFileSync(sourcePrompt, '# source template', 'utf8')

    const resolved = resolvePromptTemplatePath(pathToFileURL(moduleFile))
    expect(resolved).toBe(sourcePrompt)
    expect(readFileSync(resolved, 'utf8')).toBe('# source template')
  })

  it('prefers the dist-adjacent copy over the source fallback when both exist', () => {
    // Bundled-adjacent copy must win — it is the authoritative shipped asset.
    const root = makeTmpDir()
    const moduleFile = join(root, 'packages', 'cli', 'src', 'commands', 'local-prepare.ts')
    mkdirSync(dirname(moduleFile), { recursive: true })
    writeFileSync(moduleFile, '// source', 'utf8')
    const adjacent = join(root, 'packages', 'cli', 'src', 'commands', 'prompt.md')
    writeFileSync(adjacent, '# adjacent', 'utf8')
    const sourcePrompt = join(root, 'packages', 'drift-engine', 'src', 'prompt.md')
    mkdirSync(dirname(sourcePrompt), { recursive: true })
    writeFileSync(sourcePrompt, '# source', 'utf8')

    const resolved = resolvePromptTemplatePath(pathToFileURL(moduleFile))
    expect(resolved).toBe(adjacent)
  })

  it('throws a clear, candidate-listing error when no template is found anywhere', () => {
    const root = makeTmpDir()
    const moduleFile = join(root, 'dist', 'cli.js')
    mkdirSync(dirname(moduleFile), { recursive: true })
    writeFileSync(moduleFile, '// bundle', 'utf8')

    expect(() => resolvePromptTemplatePath(pathToFileURL(moduleFile))).toThrowError(
      /prompt template/i,
    )
  })
})

// Build-dependent assertion (mirrors NFR44 gate C's build-first contract):
// after `pnpm --filter @delfini/cli build`, tsup MUST have copied the
// drift-engine template to `dist/prompt.md`, byte-identical to the source —
// otherwise a published @delfini/cli (which has no drift-engine source on disk)
// cannot run `local-prepare` at all.
describe('bundled asset — dist/prompt.md ships with the CLI', () => {
  const DIST_CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const DIST_PROMPT = fileURLToPath(new URL('../dist/prompt.md', import.meta.url))
  const SOURCE_PROMPT = fileURLToPath(
    new URL('../../drift-engine/src/prompt.md', import.meta.url),
  )

  beforeAll(() => {
    if (!existsSync(DIST_CLI)) {
      throw new Error(
        `Bundled dist not found at ${DIST_CLI}. Run \`pnpm --filter @delfini/cli build\` first.`,
      )
    }
  })

  it('dist/prompt.md exists next to the bundled cli.js', () => {
    expect(existsSync(DIST_PROMPT)).toBe(true)
  })

  it('dist/prompt.md is byte-identical to drift-engine/src/prompt.md', () => {
    expect(readFileSync(DIST_PROMPT, 'utf8')).toBe(readFileSync(SOURCE_PROMPT, 'utf8'))
  })
})
