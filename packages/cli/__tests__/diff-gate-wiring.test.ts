// CLI wiring for the diff-side relevance gate
// (docs/ideas/token-diet-symmetric-retrieval.md): `runLocalPrepare` gates the
// analysed diff when BOTH `relevanceThreshold` and `diffKeepThreshold` are
// positive — dropping unlinked hunks from the prompt, reporting them on
// stderr, and writing the `_diffGateResult` trace sibling. The library-level
// default (either option absent) is observably no-op; the user-facing
// default-ON lives at the cli.ts flag layer (NFR49(b)), covered by the
// cross-flag-resolution case at the bottom.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Writable } from 'node:stream'
import simpleGit, { type SimpleGit } from 'simple-git'

import { runLocalPrepare } from '../src/commands/local-prepare.js'

interface TempRepo {
  root: string
  git: SimpleGit
  commit: (message: string, files: Record<string, string>) => Promise<void>
  cleanup: () => Promise<void>
}

async function makeTempRepo(): Promise<TempRepo> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delfini-cli-gate-'))
  const git = simpleGit({ baseDir: root })
  await git.init()
  await git.addConfig('user.email', 'test@delfini.local')
  await git.addConfig('user.name', 'Delfini Test')
  await git.addConfig('commit.gpgsign', 'false')
  return {
    root,
    git,
    async commit(message, files) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
      }
      await git.add('.')
      await git.commit(message)
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function makeCapture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      cb()
    },
  })
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

const GUIDE = `# Guide

## Modules

The moduleHandler in src/modules/dispatch.ts processes 100 events per tick.
`

interface GateTrace {
  keepThreshold: number
  keptByReason: Record<string, number>
  droppedHunks: { filePath: string; hunkHeader: string; maxScore: number }[]
  trimmedHunkCount: number
  contextLinesRemoved: number
}

describe('local-prepare diff-gate wiring', () => {
  let repo: TempRepo
  const TRACE = '.delfini-trace'

  beforeEach(async () => {
    repo = await makeTempRepo()
    // v0: the doc + a doc-linked module + a lexically-unrelated module. Both
    // code files are COMMITTED then modified in the working tree — an added
    // (untracked) file would hit the `new-file` structural keep instead of
    // exercising the drop path.
    await repo.commit('initial', {
      'docs/guide.md': GUIDE,
      'src/modules/dispatch.ts':
        'export const moduleHandler = register(100)\n',
      'src/tools/random.ts': 'export const shuffleDeck = () => 1\n',
    })
    await fs.writeFile(
      path.join(repo.root, 'src/modules/dispatch.ts'),
      'export const moduleHandler = register(200)\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(repo.root, 'src/tools/random.ts'),
      'export const shuffleDeck = () => 2\n',
      'utf8',
    )
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  function readTrace(name: string): string {
    return readFileSync(path.join(repo.root, TRACE, name), 'utf8')
  }

  it('drops unlinked hunks from prompt + input, reports on stderr, writes _diffGateResult', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      relevanceThreshold: 5,
      diffKeepThreshold: 5,
      stderr: stderr.stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const prompt = readTrace('analysis-prompt.md')
    expect(prompt).toContain('src/modules/dispatch.ts')
    expect(prompt).not.toContain('src/tools/random.ts')

    const input = JSON.parse(readTrace('analysis-input.json')) as {
      diff: string
      _diffGateResult?: GateTrace
    }
    expect(input.diff).toContain('src/modules/dispatch.ts')
    expect(input.diff).not.toContain('src/tools/random.ts')
    expect(input._diffGateResult).toBeDefined()
    const gate = input._diffGateResult as GateTrace
    expect(gate.keepThreshold).toBe(5)
    expect(gate.droppedHunks).toHaveLength(1)
    expect(gate.droppedHunks[0].filePath).toBe('src/tools/random.ts')
    expect(gate.droppedHunks[0].maxScore).toBeLessThan(5)
    // The dispatch.ts hunk scores ≥ 20 (path overlap + identifiers) → strong.
    expect(gate.keptByReason['linked-strong']).toBe(1)

    expect(stderr.text()).toContain(
      'diff gate: dropped 1 unrelated hunk(s) in 1 file(s), trimmed context on 0 hunk(s)',
    )
  })

  it('emits the token-breakdown observability line on single-prompt success', async () => {
    const stderr = makeCapture()
    await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      relevanceThreshold: 5,
      diffKeepThreshold: 5,
      stderr: stderr.stream,
      stdout: makeCapture().stream,
    })
    expect(stderr.text()).toMatch(
      /prompt ≈ [\d.]+k tokens \(docs ≈ [\d.]+k, diff ≈ [\d.]+k, template ≈ [\d.]+k\)/,
    )
  })

  it('library default (no diffKeepThreshold) is observably no-op — NFR49(b) pass-through', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      relevanceThreshold: 5,
      stderr: stderr.stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)
    expect(readTrace('analysis-prompt.md')).toContain('src/tools/random.ts')
    const input = JSON.parse(readTrace('analysis-input.json')) as Record<string, unknown>
    // Absent-key discipline: no `_diffGateResult: { droppedHunks: [] }`
    // falsely implying the gate ran.
    expect(input._diffGateResult).toBeUndefined()
    expect(stderr.text()).not.toContain('diff gate:')
  })

  it('requires BOTH thresholds — diffKeepThreshold without retrieval is no-op', async () => {
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      relevanceThreshold: 0,
      diffKeepThreshold: 5,
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)
    expect(readTrace('analysis-prompt.md')).toContain('src/tools/random.ts')
    const input = JSON.parse(readTrace('analysis-input.json')) as Record<string, unknown>
    expect(input._diffGateResult).toBeUndefined()
  })
})
