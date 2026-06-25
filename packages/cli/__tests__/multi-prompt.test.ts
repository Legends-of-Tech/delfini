// End-to-end multi-prompt wiring (docs/ideas/multi-prompt-diff-analysis.md):
// an over-budget diff makes `local-prepare` split into N budget-sized prompts
// (chunks.json + analysis-prompt-<k>.md), and `local-finalize` on the trace
// DIRECTORY reconciles each chunk's findings against the full docs and merges.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Writable } from 'node:stream'
import simpleGit, { type SimpleGit } from 'simple-git'

import { runLocalPrepare } from '../src/commands/local-prepare.js'
import { runLocalFinalize } from '../src/commands/local-finalize.js'

interface TempRepo {
  root: string
  git: SimpleGit
  commit: (message: string, files: Record<string, string>) => Promise<void>
  cleanup: () => Promise<void>
}

async function makeTempRepo(): Promise<TempRepo> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delfini-cli-multi-'))
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

const GUIDE = `# Reference

## Modules

The moduleHandler in src/modules/dispatch.ts processes 100 events per tick.
Each src/modules/mod file registers a moduleHandler at startup.
`

// A contradiction whose quotedDocText is a verbatim ## Modules line so the
// reconciler can ground it. rawConfidence is 0..1 per analysisSchema.
function findingsFor(quote: string, replacement: string): string {
  return JSON.stringify({
    contradictions: [
      {
        targetDocPath: 'docs/guide.md',
        targetSection: '## Modules',
        targetLineStart: 5,
        targetLineEnd: 5,
        whatChanged: 'moduleHandler event budget changed in src/modules',
        whatContradicts: 'doc states a stale value',
        proposedReplacement: replacement,
        severity: 'High',
        confidence: 4,
        quotedDocText: quote,
      },
    ],
    additions: [],
    rawConfidence: 0.9,
  })
}

const QUOTE_A = 'The moduleHandler in src/modules/dispatch.ts processes 100 events per tick.'
const QUOTE_B = 'Each src/modules/mod file registers a moduleHandler at startup.'

describe('multi-prompt end-to-end (local-prepare split → local-finalize merge)', () => {
  let repo: TempRepo
  const TRACE = '.delfini-trace'

  beforeEach(async () => {
    repo = await makeTempRepo()
    // v0 of 30 module files + the doc. Each file references the identifiers the
    // ## Modules section names, so its hunk routes to that section.
    const files: Record<string, string> = { 'docs/guide.md': GUIDE }
    for (let i = 0; i < 30; i++) {
      files[`src/modules/mod-${i}.ts`] =
        `export const moduleHandler = registerModuleHandler(${i})\n// moduleHandler dispatch under src/modules\n`
    }
    await repo.commit('initial', files)
    // v1 in the working tree → the analysed (local) diff.
    for (let i = 0; i < 30; i++) {
      await fs.writeFile(
        path.join(repo.root, `src/modules/mod-${i}.ts`),
        `export const moduleHandler = registerModuleHandler(${i} + 1)\n// moduleHandler dispatch under src/modules\n`,
        'utf8',
      )
    }
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('local-prepare splits an over-budget diff into a chunks.json manifest + per-chunk prompts', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      relevanceThreshold: 5,
      // Above the ~7.5k template floor (so chunks fit) but below template + the
      // full 30-file diff (so the single prompt overflows and must split).
      promptTokenBudget: 9000,
      stderr: stderr.stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const manifestPath = path.join(repo.root, TRACE, 'chunks.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      chunkCount: number
      prompts: string[]
    }
    expect(manifest.chunkCount).toBeGreaterThanOrEqual(2)
    expect(manifest.prompts).toHaveLength(manifest.chunkCount)
    // Every promised prompt file exists and carries the analysis template.
    for (const p of manifest.prompts) {
      const promptPath = path.join(repo.root, TRACE, p)
      expect(existsSync(promptPath)).toBe(true)
      expect(readFileSync(promptPath, 'utf8')).toContain('<document path="docs/guide.md">')
    }
    expect(stderr.text()).toContain('split into')
  })

  it('local-finalize on the trace dir reconciles every chunk, merges + dedups, exit 1', async () => {
    await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      relevanceThreshold: 5,
      promptTokenBudget: 9000,
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    const manifest = JSON.parse(
      readFileSync(path.join(repo.root, TRACE, 'chunks.json'), 'utf8'),
    ) as { chunkCount: number }

    // Simulate subagent output: chunk 0 finds drift on BOTH doc lines; chunk 1
    // re-finds line A (the same section was rendered into both chunks). Merge
    // must dedup line A → exactly two contradictions survive.
    const writeFindings = async (k: number, content: string): Promise<void> => {
      await fs.writeFile(path.join(repo.root, TRACE, `findings-${k}.json`), content, 'utf8')
    }
    await writeFindings(
      0,
      JSON.stringify({
        contradictions: [
          JSON.parse(findingsFor(QUOTE_A, 'The moduleHandler in src/modules/dispatch.ts processes 200 events per tick.')).contradictions[0],
          JSON.parse(findingsFor(QUOTE_B, 'Each src/modules/mod file registers two moduleHandlers at startup.')).contradictions[0],
        ],
        additions: [],
        rawConfidence: 0.9,
      }),
    )
    await writeFindings(
      1,
      findingsFor(QUOTE_A, 'The moduleHandler in src/modules/dispatch.ts processes 200 events per tick.'),
    )
    for (let k = 2; k < manifest.chunkCount; k++) {
      await writeFindings(k, JSON.stringify({ contradictions: [], additions: [], rawConfidence: 0.1 }))
    }

    const stdout = makeCapture()
    const code = await runLocalFinalize({
      repoRoot: repo.root,
      findingsPath: TRACE, // directory → multi-mode
      stdout: stdout.stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
    const report = stdout.text()
    expect(report).toContain('# Delfini drift analysis')
    // Two distinct drift findings survived (line A deduped across chunks).
    expect(report).toContain('2 drift, 0 additive')
    expect(report).toMatch(/\[1\] \[H\] drift: docs\/guide\.md/)
    expect(report).toMatch(/\[2\] \[H\] drift: docs\/guide\.md/)
  })

  it('local-finalize multi-mode reports per-chunk schema failures (exit 3, failedChunks)', async () => {
    await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      relevanceThreshold: 5,
      promptTokenBudget: 9000,
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    const manifest = JSON.parse(
      readFileSync(path.join(repo.root, TRACE, 'chunks.json'), 'utf8'),
    ) as { chunkCount: number }

    // chunk 0 valid; chunk 1 malformed (missing required fields).
    await fs.writeFile(
      path.join(repo.root, TRACE, 'findings-0.json'),
      JSON.stringify({ contradictions: [], additions: [], rawConfidence: 0.1 }),
      'utf8',
    )
    await fs.writeFile(
      path.join(repo.root, TRACE, 'findings-1.json'),
      JSON.stringify({ contradictions: [{ targetDocPath: 'docs/guide.md' }], additions: [], rawConfidence: 0.1 }),
      'utf8',
    )
    for (let k = 2; k < manifest.chunkCount; k++) {
      await fs.writeFile(
        path.join(repo.root, TRACE, `findings-${k}.json`),
        JSON.stringify({ contradictions: [], additions: [], rawConfidence: 0.1 }),
        'utf8',
      )
    }

    const stderr = makeCapture()
    const code = await runLocalFinalize({
      repoRoot: repo.root,
      findingsPath: TRACE,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(3)
    const payload = JSON.parse(stderr.text()) as {
      error: string
      failedChunks: { chunk: number }[]
    }
    expect(payload.error).toBe('schema_validation')
    expect(payload.failedChunks.map((f) => f.chunk)).toContain(1)
  })
})
