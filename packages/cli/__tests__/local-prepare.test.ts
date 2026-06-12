import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Writable } from 'node:stream'
import simpleGit, { type SimpleGit } from 'simple-git'

import { writeDocScope } from '../src/doc-scope.js'
import {
  PROMPT_TOKEN_BUDGET,
  runLocalPrepare,
  zodToJsonSchema,
} from '../src/commands/local-prepare.js'
import { analysisSchema } from '@delfini/drift-engine'

// ---------------------------------------------------------------------------
// Helpers — real fs + real git temp repos
// ---------------------------------------------------------------------------

interface TempRepo {
  root: string
  git: SimpleGit
  /** Create files and `git add . && git commit`. Returns the commit SHA. */
  commit: (message: string, files: Record<string, string>) => Promise<string>
  cleanup: () => Promise<void>
}

async function makeTempRepo(): Promise<TempRepo> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delfini-cli-local-prepare-'))
  const git = simpleGit({ baseDir: root })
  await git.init()
  // CI-safe author info.
  await git.addConfig('user.email', 'test@delfini.local')
  await git.addConfig('user.name', 'Delfini Test')
  // Avoid `gpgsign` prompts.
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
      const sha = await git.revparse(['HEAD'])
      return sha.trim()
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** Capture-to-string writable for stderr/stdout assertions. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLocalPrepare — exit 2 when no scope', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'README.md': '# Hello\n' })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('returns 2 when no --scope and no persisted doc-scope.json (NFR47 mode 5)', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      stderr: stderr.stream,
      base: 'HEAD',
    })
    expect(code).toBe(2)
    expect(stderr.text()).toMatch(/No doc-scope configured/)
  })

  it('does NOT write any .delfini-trace/ files on exit 2', async () => {
    await runLocalPrepare({
      repoRoot: repo.root,
      stderr: makeCapture().stream,
      base: 'HEAD',
    })
    const tracePath = path.join(repo.root, '.delfini-trace')
    await expect(fs.access(tracePath)).rejects.toThrow()
  })
})

describe('runLocalPrepare — persisted doc-scope path (AC2)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', {
      'docs/architecture.md': '# Arch\n\nFoo.\n',
      'README.md': '# Hello\n',
    })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('reads persisted doc-scope.json when no --scope flag', async () => {
    await writeDocScope(['docs/'], { repoRoot: repo.root })
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      base: 'HEAD',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as { docs: Array<{ path: string }> }
    expect(parsed.docs.map((d) => d.path)).toEqual(['docs/architecture.md'])
  })
})

describe('runLocalPrepare — --scope override (AC3)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', {
      'docs/foo.md': '# Foo\n',
      'specs/bar.md': '# Bar\n',
    })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('overrides persisted scope without modifying doc-scope.json', async () => {
    // Seed persisted scope with one entry.
    await writeDocScope(['docs/'], { repoRoot: repo.root })
    const scopePath = path.join(repo.root, '.claude', 'skills', 'delfini', 'doc-scope.json')
    const before = readFileSync(scopePath, 'utf8')

    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['specs/'],
      base: 'HEAD',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    // doc-scope.json untouched.
    const after = readFileSync(scopePath, 'utf8')
    expect(after).toBe(before)

    // Analysis input reflects the override, not the persisted value.
    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as { docs: Array<{ path: string }> }
    expect(parsed.docs.map((d) => d.path)).toEqual(['specs/bar.md'])
  })

  it('accepts comma-separated string', async () => {
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: 'docs/, specs/',
      base: 'HEAD',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as { docs: Array<{ path: string }> }
    expect(parsed.docs.map((d) => d.path).sort()).toEqual(['docs/foo.md', 'specs/bar.md'])
  })
})

describe('runLocalPrepare — missing-path warnings (AC6, NFR47 mode 6)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'docs/exists.md': '# Real\n' })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('logs exact "⚠️ Skipped" warning and continues', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/exists.md', 'docs/missing.md'],
      base: 'HEAD',
      stderr: stderr.stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)
    expect(stderr.text()).toContain('⚠️ Skipped: `docs/missing.md` (no longer exists)')

    // Surviving path still in the input.
    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as { docs: Array<{ path: string }> }
    expect(parsed.docs.map((d) => d.path)).toEqual(['docs/exists.md'])
  })
})

describe('runLocalPrepare — diff computation (AC7)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('captures diff between two commits when --base points to the first (--diff-source committed)', async () => {
    const firstSha = await repo.commit('initial', {
      'src/foo.ts': 'export const x = 1\n',
      'docs/spec.md': '# Spec\n',
    })
    await repo.commit('change', {
      'src/foo.ts': 'export const x = 2\n',
    })

    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: firstSha,
      // P3.2.8: the default diff source is now `local` (working tree vs HEAD);
      // this test exercises the committed-vs-base delta explicitly.
      diffSource: 'committed',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as { diff: string }
    expect(parsed.diff).toContain('foo.ts')
    expect(parsed.diff).toMatch(/-export const x = 1/)
    expect(parsed.diff).toMatch(/\+export const x = 2/)
  })
})

describe('runLocalPrepare — --diff-source selection (P3.2.8)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  /** Read back the analysed diff from the written analysis-input.json. */
  function readDiff(): string {
    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    return (JSON.parse(inputJson) as { diff: string }).diff
  }

  /**
   * Builds a repo with a committed delta (k 0→1), a working-tree change
   * (k 1→2), and an untracked file. Returns the first commit's SHA (the base
   * for committed/both). Scope is `docs/` so the run does not exit 2.
   */
  async function seedThreeWayScenario(): Promise<string> {
    const firstSha = await repo.commit('initial', {
      'docs/spec.md': '# Spec\n',
      'src/keep.ts': 'export const k = 0\n',
    })
    // Committed delta on top of base.
    await repo.commit('commit delta', { 'src/keep.ts': 'export const k = 1\n' })
    // Working-tree (unstaged) change.
    await fs.writeFile(
      path.join(repo.root, 'src', 'keep.ts'),
      'export const k = 2\n',
      'utf8',
    )
    // Untracked new file.
    await fs.writeFile(
      path.join(repo.root, 'src', 'new.ts'),
      'export const n = 9\n',
      'utf8',
    )
    return firstSha
  }

  it('committed: captures the HEAD-vs-base delta, excludes working-tree + untracked', async () => {
    const firstSha = await seedThreeWayScenario()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: firstSha,
      diffSource: 'committed',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)
    const diff = readDiff()
    expect(diff).toMatch(/\+export const k = 1/)
    expect(diff).not.toContain('export const k = 2')
    expect(diff).not.toContain('new.ts')
  })

  it('local: captures working-tree changes + untracked, excludes the committed-only delta', async () => {
    const firstSha = await seedThreeWayScenario()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: firstSha,
      diffSource: 'local',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)
    const diff = readDiff()
    // Working tree is k 1→2 vs HEAD; the committed 0→1 transition is invisible.
    expect(diff).toMatch(/\+export const k = 2/)
    expect(diff).not.toMatch(/export const k = 0/)
    // Untracked file appears as an added-file diff with its content.
    expect(diff).toContain('new.ts')
    expect(diff).toContain('export const n = 9')
  })

  it('both: captures the committed delta + working-tree + untracked', async () => {
    const firstSha = await seedThreeWayScenario()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: firstSha,
      diffSource: 'both',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)
    const diff = readDiff()
    // Working tree vs base = k 0→2: both endpoints visible.
    expect(diff).toMatch(/-export const k = 0/)
    expect(diff).toMatch(/\+export const k = 2/)
    expect(diff).toContain('new.ts')
  })

  it('defaults to local when --diff-source is omitted', async () => {
    const firstSha = await seedThreeWayScenario()

    const codeDefault = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: firstSha,
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(codeDefault).toBe(0)
    const defaultDiff = readDiff()

    const codeLocal = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: firstSha,
      diffSource: 'local',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(codeLocal).toBe(0)
    expect(readDiff()).toBe(defaultDiff)
  })

  it('includes an untracked-only file in the local diff (no tracked changes)', async () => {
    await repo.commit('initial', { 'docs/spec.md': '# Spec\n' })
    await fs.writeFile(
      path.join(repo.root, 'src-new.md'),
      '# Brand new doc\n',
      'utf8',
    )
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      diffSource: 'local',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)
    const diff = readDiff()
    expect(diff).toContain('src-new.md')
    expect(diff).toContain('# Brand new doc')
  })

  it('default-branch collapse: committed is empty and both === local when base ≈ HEAD', async () => {
    // Single commit on the default branch; base resolves to HEAD, so the
    // committed-vs-base range is empty and `both` collapses to `local`.
    await repo.commit('initial', {
      'docs/spec.md': '# Spec\n',
      'src/keep.ts': 'export const k = 0\n',
    })
    await fs.writeFile(
      path.join(repo.root, 'src', 'keep.ts'),
      'export const k = 2\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(repo.root, 'src', 'new.ts'),
      'export const n = 9\n',
      'utf8',
    )

    const runWith = async (diffSource: 'local' | 'committed' | 'both'): Promise<string> => {
      const code = await runLocalPrepare({
        repoRoot: repo.root,
        scope: ['docs/'],
        base: 'HEAD',
        diffSource,
        stderr: makeCapture().stream,
        stdout: makeCapture().stream,
      })
      expect(code).toBe(0)
      return readDiff()
    }

    const committed = await runWith('committed')
    const local = await runWith('local')
    const both = await runWith('both')

    expect(committed.trim()).toBe('')
    expect(both).toBe(local)
  })

  it('throws a clear error on an invalid --diff-source value', async () => {
    await repo.commit('initial', { 'docs/spec.md': '# Spec\n' })
    await expect(
      runLocalPrepare({
        repoRoot: repo.root,
        scope: ['docs/'],
        base: 'HEAD',
        // Intentionally invalid — exercises the defensive guard.
        diffSource: 'bogus' as unknown as 'local',
        stderr: makeCapture().stream,
        stdout: makeCapture().stream,
      }),
    ).rejects.toThrow(/diff-source/i)
  })
})

describe('runLocalPrepare — prompt-too-large gate (AC9, NFR47 mode 4)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'docs/spec.md': '# Spec\n\nSome content.\n' })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('exits 4 with prompt_too_large JSON when budget exceeded', async () => {
    const stdout = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      // Tiny budget — any prompt will overflow.
      promptTokenBudget: 1,
      stderr: makeCapture().stream,
      stdout: stdout.stream,
    })
    expect(code).toBe(4)

    const payload = JSON.parse(stdout.text())
    expect(payload).toMatchObject({
      error: 'prompt_too_large',
      suggestion: expect.stringContaining('Narrow your doc-scope'),
    })
    expect(typeof payload.estimatedTokens).toBe('number')
    expect(payload.estimatedTokens).toBeGreaterThan(0)
  })

  it('does NOT write trace files when over budget', async () => {
    await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      promptTokenBudget: 1,
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    const tracePath = path.join(repo.root, '.delfini-trace')
    await expect(fs.access(tracePath)).rejects.toThrow()
  })
})

describe('runLocalPrepare — trace artefacts (AC10)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', {
      'docs/arch.md': '# Architecture\n\nLine two.\n',
    })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('writes the three expected files to .delfini-trace/', async () => {
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const traceDir = path.join(repo.root, '.delfini-trace')
    const entries = await fs.readdir(traceDir)
    expect(entries.sort()).toEqual(['analysis-input.json', 'analysis-prompt.md', 'schema.json'])
  })

  it('analysis-input.json carries the AnalysisInput shape with synthetic prMetadata', async () => {
    await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as {
      diff: string
      docs: Array<{ path: string; content: string; frontMatterLineCount: number }>
      prMetadata: { owner: string; prNumber: number; title: string }
    }
    expect(parsed.prMetadata.owner).toBe('local')
    expect(parsed.prMetadata.prNumber).toBe(0)
    expect(parsed.prMetadata.title).toBe('Local /delfini run')
    expect(parsed.docs[0]).toMatchObject({
      path: 'docs/arch.md',
      frontMatterLineCount: 0,
    })
    expect(parsed.docs[0]?.content).toContain('# Architecture')
  })

  it('analysis-prompt.md contains substituted doc content', async () => {
    await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    const promptText = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-prompt.md'),
      'utf8',
    )
    // The prompt-builder prefixes each doc line with "N: ".
    expect(promptText).toMatch(/1: # Architecture/)
    // Synthetic prMetadata makes it into the prompt header.
    expect(promptText).toContain('Local /delfini run')
  })

  it('schema.json is a valid JSON-Schema derivation of analysisSchema', async () => {
    await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    const schemaJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'schema.json'),
      'utf8',
    )
    const schema = JSON.parse(schemaJson) as Record<string, unknown>
    expect(schema.type).toBe('object')
    // analysisSchema = { contradictions, additions, rawConfidence }
    expect((schema.properties as Record<string, unknown>).contradictions).toBeDefined()
    expect((schema.properties as Record<string, unknown>).additions).toBeDefined()
    expect((schema.properties as Record<string, unknown>).rawConfidence).toBeDefined()
    expect(schema.required).toEqual(
      expect.arrayContaining(['contradictions', 'additions', 'rawConfidence']),
    )
  })
})

describe('runLocalPrepare — empty-scope-after-normalisation (code-review M1)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', { 'README.md': '# Hello\n' })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('treats --scope "" (empty string) as no-scope and exits 2', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: '',
      base: 'HEAD',
      stderr: stderr.stream,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toMatch(/No doc-scope configured/)
  })

  it('treats --scope ", ," (only whitespace + commas) as no-scope and exits 2', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ', , ',
      base: 'HEAD',
      stderr: stderr.stream,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toMatch(/No doc-scope configured/)
  })

  it('treats --scope [] (empty array) as no-scope and exits 2', async () => {
    const stderr = makeCapture()
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: [],
      base: 'HEAD',
      stderr: stderr.stream,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toMatch(/No doc-scope configured/)
  })
})

describe('runLocalPrepare — race-during-read graceful skip (code-review M2)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', {
      'docs/a.md': '# A\n',
      'docs/b.md': '# B\n',
    })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('warns and continues when a doc disappears between expand and read', async () => {
    // Pre-flight: prove both files exist.
    expect((await fs.readdir(path.join(repo.root, 'docs'))).sort()).toEqual([
      'a.md',
      'b.md',
    ])

    // Race: delete b.md via a spy that fires inside the expansion step.
    // Simpler approach: intercept expandDocScope's output by deleting b.md
    // *before* runLocalPrepare runs but *after* the expansion would have
    // picked it up — we achieve this by re-creating the file via the
    // simple-git tree-state path, then deleting via fs after the commit
    // is in place. Since expandDocScope reads the working tree at
    // runLocalPrepare time, we instead use a smaller scope and rely on
    // expansion ordering: delete b.md inside the same tick to simulate a
    // hand-edit during the brief window between expansion and read.
    //
    // Practical test: pre-stage expansion to include both, then drop one
    // file just before runLocalPrepare hits readDocs. We can't easily
    // intercept mid-run from a test, so we test the equivalent narrower
    // race by deleting a file that expandDocScope would have included via
    // a glob *if* a glob result references a non-existent file. tinyglobby
    // won't return a path that doesn't exist at expand time, so the only
    // way to surface this race is to substitute a path that fs.stat
    // confirms exists (via expandDocScope's directory walk) and then
    // remove it before fs.readFile runs.
    //
    // We use a custom seam: monkey-patch fs.readFile to simulate ENOENT
    // on the second call. Avoids racing the actual filesystem.
    const realReadFile = fs.readFile
    let callIndex = 0
    const fsAny = fs as unknown as { readFile: typeof realReadFile }
    fsAny.readFile = (async (p: string, enc?: BufferEncoding) => {
      callIndex += 1
      if (callIndex === 1) {
        // First call: simulate ENOENT (race-induced delete).
        const err = new Error(`ENOENT: simulated race`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return realReadFile(p, enc)
    }) as typeof realReadFile

    try {
      const stderr = makeCapture()
      const code = await runLocalPrepare({
        repoRoot: repo.root,
        scope: ['docs/'],
        base: 'HEAD',
        stderr: stderr.stream,
        stdout: makeCapture().stream,
      })
      expect(code).toBe(0)
      // One file got skipped; warning surfaced.
      expect(stderr.text()).toMatch(/⚠️ Skipped: `docs\//)

      const inputJson = readFileSync(
        path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
        'utf8',
      )
      const parsed = JSON.parse(inputJson) as { docs: Array<{ path: string }> }
      // Only one doc survives.
      expect(parsed.docs.length).toBe(1)
    } finally {
      fsAny.readFile = realReadFile
    }
  })
})

describe('runLocalPrepare — sanity / module exports', () => {
  it('exports PROMPT_TOKEN_BUDGET as a positive number', () => {
    expect(PROMPT_TOKEN_BUDGET).toBeGreaterThan(0)
    expect(typeof PROMPT_TOKEN_BUDGET).toBe('number')
  })
})

describe('runLocalPrepare — --relevance-threshold flag', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('drops below-threshold docs from the rendered prompt', async () => {
    await repo.commit('initial', {
      'docs/relevant.md': 'src/x.ts is documented here.',
      'docs/unrelated.md': '# Unrelated\n\nNothing matches.',
      'src/x.ts': 'export const a = 1\n',
    })
    // Modify x.ts so the diff between baseRef=HEAD~1 and HEAD is non-empty.
    await repo.commit('change x.ts', {
      'src/x.ts': 'export const a = 2\n',
    })
    const baseRef = await repo.git.raw(['rev-parse', 'HEAD~1'])
    await writeDocScope(['docs/'], { repoRoot: repo.root })

    const exitCode = await runLocalPrepare({
      base: baseRef.trim(),
      // Relevance scoring keys off the committed delta here (changes are
      // committed, not in the working tree) — pin the committed diff source.
      diffSource: 'committed',
      relevanceThreshold: 5,
      repoRoot: repo.root,
    })
    expect(exitCode).toBe(0)
    const prompt = readFileSync(
      path.join(repo.root, '.delfini-trace/analysis-prompt.md'),
      'utf8',
    )
    expect(prompt).toContain('<document path="docs/relevant.md">')
    expect(prompt).not.toContain('<document path="docs/unrelated.md">')
  })

  it('includes every doc when --relevance-threshold is omitted (default no-op)', async () => {
    await repo.commit('initial', {
      'docs/relevant.md': 'src/x.ts is documented here.',
      'docs/unrelated.md': '# Unrelated',
      'src/x.ts': 'export const a = 1\n',
    })
    await repo.commit('change x.ts', {
      'src/x.ts': 'export const a = 2\n',
    })
    const baseRef = await repo.git.raw(['rev-parse', 'HEAD~1'])
    await writeDocScope(['docs/'], { repoRoot: repo.root })

    const exitCode = await runLocalPrepare({
      base: baseRef.trim(),
      // Committed delta (see sibling test) — the relevance gate is omitted so
      // every doc is included regardless of diff source.
      diffSource: 'committed',
      repoRoot: repo.root,
    })
    expect(exitCode).toBe(0)
    const prompt = readFileSync(
      path.join(repo.root, '.delfini-trace/analysis-prompt.md'),
      'utf8',
    )
    expect(prompt).toContain('<document path="docs/relevant.md">')
    expect(prompt).toContain('<document path="docs/unrelated.md">')
  })
})

// ---------------------------------------------------------------------------
// zodToJsonSchema — the inline walker
// ---------------------------------------------------------------------------

describe('zodToJsonSchema', () => {
  it('produces a JSON Schema object for analysisSchema', () => {
    const schema = zodToJsonSchema(analysisSchema) as {
      type: string
      properties: Record<string, { type?: string }>
      required: string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.properties.contradictions?.type).toBe('array')
    expect(schema.properties.additions?.type).toBe('array')
    expect(schema.properties.rawConfidence?.type).toBe('number')
    expect(schema.required).toEqual(
      expect.arrayContaining(['contradictions', 'additions', 'rawConfidence']),
    )
  })

  it('encodes nullable strings as `["string","null"]` (proposedReplacement on Contradiction)', () => {
    const schema = zodToJsonSchema(analysisSchema) as {
      properties: {
        contradictions: {
          items: {
            properties: { proposedReplacement: { type: string[] | string } }
          }
        }
      }
    }
    const proposedReplacement =
      schema.properties.contradictions.items.properties.proposedReplacement
    expect(proposedReplacement.type).toEqual(['string', 'null'])
  })

  it('encodes severity enum values', () => {
    const schema = zodToJsonSchema(analysisSchema) as {
      properties: {
        contradictions: {
          items: {
            properties: { severity: { enum: string[]; type: string } }
          }
        }
      }
    }
    const severity = schema.properties.contradictions.items.properties.severity
    expect(severity.type).toBe('string')
    expect(severity.enum).toEqual(['High', 'Medium', 'Low'])
  })

  it('marks integer fields with `type: "integer"` and min/max bounds', () => {
    const schema = zodToJsonSchema(analysisSchema) as {
      properties: {
        contradictions: {
          items: {
            properties: {
              confidence: { type: string; minimum: number; maximum: number }
            }
          }
        }
      }
    }
    const confidence = schema.properties.contradictions.items.properties.confidence
    expect(confidence.type).toBe('integer')
    expect(confidence.minimum).toBe(1)
    expect(confidence.maximum).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Story P3.7.2 / FR151 — diff pre-filter (--enable-diff-prefilter)
// ---------------------------------------------------------------------------

describe('runLocalPrepare — diff pre-filter (P3.7.2)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
    await repo.commit('initial', {
      'docs/architecture.md': '# Arch\n\nDescribes the foo module.\n',
      'src/foo.ts': "export function foo() { return 1 }\n",
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    })
    // Make a follow-up commit that touches both the lockfile and a source
    // file, so the diff against HEAD~1 contains both.
    await repo.commit('churn', {
      'src/foo.ts': "export function foo() { return 2 }\n",
      'pnpm-lock.yaml': "lockfileVersion: '9.1'\n",
    })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('default (gate off) — analysis-input.json has NO _filterResult field', async () => {
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD~1',
      diffSource: 'committed',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as {
      diff: string
      _filterResult?: unknown
    }
    expect(parsed._filterResult).toBeUndefined()
    // Lockfile diff is present in the analysis input.
    expect(parsed.diff).toContain('pnpm-lock.yaml')
  })

  it('with gate on — lockfile dropped from diff, _filterResult records it', async () => {
    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD~1',
      diffSource: 'committed',
      enableDiffPreFilter: true,
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(inputJson) as {
      diff: string
      _filterResult: {
        droppedPaths: Array<{ path: string; reason: string }>
        droppedHunks: Array<{ path: string; reason: string }>
        keptDiff: string
      }
    }
    expect(parsed._filterResult).toBeDefined()
    expect(parsed._filterResult.droppedPaths).toEqual([
      { path: 'pnpm-lock.yaml', reason: 'lockfile' },
    ])
    expect(parsed.diff).not.toContain('pnpm-lock.yaml')
    expect(parsed.diff).toContain('src/foo.ts')
  })
})

// ---------------------------------------------------------------------------
// Story P3.7.3 / FR152 — ranked-fill prompt budget
// ---------------------------------------------------------------------------

describe('runLocalPrepare — ranked-fill prompt budget (P3.7.3)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('default path (no --relevance-threshold) — oversized prompt still exits 4 (unchanged from baseline)', async () => {
    // Generate a doc fixture that overflows a tiny budget when retrieval is
    // off. Without --relevance-threshold, ranked-fill is inactive — the
    // exit-4 fast-path fires as before.
    await repo.commit('initial', {
      'docs/relevant.md': 'src/x.ts is here.',
      'src/x.ts': 'export const a = 1\n',
    })
    await repo.commit('change x.ts', { 'src/x.ts': 'export const a = 2\n' })
    const baseRef = await repo.git.raw(['rev-parse', 'HEAD~1'])
    await writeDocScope(['docs/'], { repoRoot: repo.root })

    const stdout = makeCapture()
    const exitCode = await runLocalPrepare({
      base: baseRef.trim(),
      diffSource: 'committed',
      repoRoot: repo.root,
      // Tiny budget — even the small prompt overflows.
      promptTokenBudget: 1,
      stdout: stdout.stream,
      stderr: makeCapture().stream,
    })
    expect(exitCode).toBe(4)
    const payload = JSON.parse(stdout.text())
    expect(payload.error).toBe('prompt_too_large')
    // Updated suggestion mentions the new "non-doc payload" semantics.
    expect(payload.suggestion).toContain('over budget even before any doc sections fit')
  })

  it('with --relevance-threshold + tiny budget that fits at least one section — ranked-fill drops + exit 0 + stderr header + trace record', async () => {
    // Two docs: one matches the diff strongly (high score), one matches weakly.
    // Tiny budget forces ranked-fill to drop the weak one. Use LARGE sections
    // (~1 KB each) so the section cost dominates the per-section measurement
    // fudge and the budget-vs-section arithmetic is robust to small drift.
    const strongFiller = 'authenticate(user) appears in src/auth.ts and authenticate(user). '.repeat(20)
    const weakFiller = 'See src/util.ts for the helper. '.repeat(20)
    await repo.commit('initial', {
      'docs/strong.md': `## Strong\n${strongFiller}`,
      'docs/weak.md': `## Weak\n${weakFiller}`,
      'src/auth.ts': 'export const a = 1\n',
      'src/util.ts': 'export const b = 1\n',
    })
    await repo.commit('change both', {
      'src/auth.ts': 'export const a = 2 // authenticate(user)\n',
      'src/util.ts': 'export const b = 2 // helper(x)\n',
    })
    const baseRef = await repo.git.raw(['rev-parse', 'HEAD~1'])
    await writeDocScope(['docs/'], { repoRoot: repo.root })

    // Two-pass measurement: first run unbounded to discover the actual
    // assembled-prompt cost, then re-run with a budget that leaves room for
    // ~one section but not both. Robust against template-size drift.
    await runLocalPrepare({
      base: baseRef.trim(),
      diffSource: 'committed',
      relevanceThreshold: 5,
      repoRoot: repo.root,
      stderr: makeCapture().stream,
    })
    const fullPrompt = readFileSync(
      path.join(repo.root, '.delfini-trace/analysis-prompt.md'),
      'utf8',
    )
    // Each filler section is ~700 chars → ~200 tokens render cost. Reducing
    // the budget by ~250 tokens guarantees at least one section is dropped.
    const fullCost = Math.ceil(fullPrompt.length / 3.5)
    const tightBudget = fullCost - 250

    const stderr = makeCapture()
    const exitCode = await runLocalPrepare({
      base: baseRef.trim(),
      diffSource: 'committed',
      relevanceThreshold: 5,
      promptTokenBudget: tightBudget,
      repoRoot: repo.root,
      stderr: stderr.stream,
    })
    expect(exitCode).toBe(0)
    // Stderr header surfaces the drop in human-readable form.
    expect(stderr.text()).toMatch(/dropped \d+ section\(s\) — over prompt budget/)
    // Trace JSON carries the structured record.
    const traceText = readFileSync(
      path.join(repo.root, '.delfini-trace/analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(traceText)
    expect(parsed._rankedFillResult).toBeDefined()
    expect(Array.isArray(parsed._rankedFillResult.droppedSections)).toBe(true)
    expect(parsed._rankedFillResult.droppedSections.length).toBeGreaterThan(0)
    // Each dropped entry carries the cross-doc docPath.
    for (const entry of parsed._rankedFillResult.droppedSections) {
      expect(typeof entry.docPath).toBe('string')
      expect(typeof entry.startLineIndex).toBe('number')
      expect(typeof entry.score).toBe('number')
    }
  })

  it('with --relevance-threshold + generous budget — ranked-fill no-op, NO _rankedFillResult in trace', async () => {
    await repo.commit('initial', {
      'docs/relevant.md': 'src/x.ts is documented here.',
      'src/x.ts': 'export const a = 1\n',
    })
    await repo.commit('change x.ts', { 'src/x.ts': 'export const a = 2\n' })
    const baseRef = await repo.git.raw(['rev-parse', 'HEAD~1'])
    await writeDocScope(['docs/'], { repoRoot: repo.root })

    const stderr = makeCapture()
    const exitCode = await runLocalPrepare({
      base: baseRef.trim(),
      diffSource: 'committed',
      relevanceThreshold: 5,
      // Default PROMPT_TOKEN_BUDGET (150k) — generous; no drops expected.
      repoRoot: repo.root,
      stderr: stderr.stream,
    })
    expect(exitCode).toBe(0)
    // No header emitted when nothing was dropped.
    expect(stderr.text()).not.toContain('dropped')
    const traceText = readFileSync(
      path.join(repo.root, '.delfini-trace/analysis-input.json'),
      'utf8',
    )
    const parsed = JSON.parse(traceText)
    // AC6: presence-as-signal — key is absent, not `{ droppedSections: [] }`.
    expect(parsed._rankedFillResult).toBeUndefined()
  })

  it('with --relevance-threshold but a tiny budget where NO section fits → exit 4 with updated suggestion', async () => {
    await repo.commit('initial', {
      'docs/relevant.md': 'src/x.ts is documented here.',
      'src/x.ts': 'export const a = 1\n',
    })
    await repo.commit('change x.ts', { 'src/x.ts': 'export const a = 2\n' })
    const baseRef = await repo.git.raw(['rev-parse', 'HEAD~1'])
    await writeDocScope(['docs/'], { repoRoot: repo.root })

    const stdout = makeCapture()
    const exitCode = await runLocalPrepare({
      base: baseRef.trim(),
      diffSource: 'committed',
      relevanceThreshold: 5,
      // Budget so tight the non-doc payload itself overflows.
      promptTokenBudget: 1,
      repoRoot: repo.root,
      stdout: stdout.stream,
      stderr: makeCapture().stream,
    })
    expect(exitCode).toBe(4)
    const payload = JSON.parse(stdout.text())
    expect(payload.error).toBe('prompt_too_large')
    expect(payload.suggestion).toContain('over budget even before any doc sections fit')
  })
})

// ---------------------------------------------------------------------------
// SKILL.md template regression — exit-4 wording sync (Story P3.7.3 AC7)
// ---------------------------------------------------------------------------

describe('SKILL.md template — exit-4 wording (P3.7.3 AC7)', () => {
  it('the exit-4 bullet reflects ranked-fill semantics, not the legacy hard-fail', () => {
    const templatePath = path.join(
      __dirname,
      '..',
      'templates',
      'SKILL.md',
    )
    const content = readFileSync(templatePath, 'utf8')
    // New wording mentions "non-doc prompt payload" or "ranked-fill" —
    // both must surface so a fresh `delfini install` scaffolds the
    // amended FR141 / NFR47 mode #4 protocol step.
    expect(content).toContain('non-doc prompt payload exceeds budget')
    expect(content).toContain('ranked-fill')
    // No stale "estimated prompt-token count exceeds budget" standalone —
    // that wording lived under the legacy hard-fail interpretation.
    expect(content).not.toMatch(/estimated prompt-token count exceeds budget\)?\s*\*\*/)
  })
})

describe('runLocalPrepare — working-tree doc read invariant (P3.7.4 / FR153)', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  /** Read back the assembled docs[] from the written analysis-input.json. */
  function readDocs(): { path: string; content: string }[] {
    const inputJson = readFileSync(
      path.join(repo.root, '.delfini-trace', 'analysis-input.json'),
      'utf8',
    )
    return (JSON.parse(inputJson) as { docs: { path: string; content: string }[] }).docs
  }

  const HEAD_BODY = '# Spec\n\nThe doc body at HEAD.\n'
  const BASE_BODY = '# Spec\n\nThe doc body at base.\n'
  const WORKING_TREE_BODY = '# Spec\n\nThe doc body in the working tree.\n'

  /**
   * Seeds a doc whose content differs across base, HEAD, and the working tree,
   * so a doc-read sourced from a git object (base or HEAD) would be observably
   * different from a working-tree read. Returns the base commit SHA.
   *
   *   base commit:  docs/spec.md = BASE_BODY     (+ src/keep.ts = 0)
   *   HEAD commit:  docs/spec.md = HEAD_BODY     (+ src/keep.ts = 1)
   *   working tree: docs/spec.md = WORKING_TREE_BODY (unstaged)
   */
  async function seedDivergentDoc(): Promise<string> {
    const baseSha = await repo.commit('base', {
      'docs/spec.md': BASE_BODY,
      'src/keep.ts': 'export const k = 0\n',
    })
    await repo.commit('head', {
      'docs/spec.md': HEAD_BODY,
      'src/keep.ts': 'export const k = 1\n',
    })
    await fs.writeFile(path.join(repo.root, 'docs', 'spec.md'), WORKING_TREE_BODY, 'utf8')
    return baseSha
  }

  for (const diffSource of ['local', 'committed', 'both'] as const) {
    it(`reads doc bodies from the working tree under --diff-source ${diffSource}`, async () => {
      const baseSha = await seedDivergentDoc()
      const code = await runLocalPrepare({
        repoRoot: repo.root,
        scope: ['docs/'],
        base: baseSha,
        diffSource,
        stderr: makeCapture().stream,
        stdout: makeCapture().stream,
      })
      expect(code).toBe(0)

      const docs = readDocs()
      const spec = docs.find((d) => d.path === 'docs/spec.md')
      expect(spec).toBeDefined()
      // The doc body is ALWAYS the working tree — never the committed-at-HEAD
      // object, never the committed-at-base object — regardless of which diff
      // the --diff-source value selects.
      expect(spec?.content).toBe(WORKING_TREE_BODY)
      expect(spec?.content).not.toContain('at HEAD')
      expect(spec?.content).not.toContain('at base')
    })
  }

  it('writes byte-identical doc content across every --diff-source value (regression guard)', async () => {
    const baseSha = await seedDivergentDoc()
    const contents: string[] = []
    for (const diffSource of ['local', 'committed', 'both'] as const) {
      const code = await runLocalPrepare({
        repoRoot: repo.root,
        scope: ['docs/'],
        base: baseSha,
        diffSource,
        stderr: makeCapture().stream,
        stdout: makeCapture().stream,
      })
      expect(code).toBe(0)
      const spec = readDocs().find((d) => d.path === 'docs/spec.md')
      contents.push(spec?.content ?? '<missing>')
    }
    // All three runs read the same working-tree bytes — the doc-read does not
    // depend on --diff-source. A future rewire of readDocs to a git-object read
    // for one diffSource would break this assertion.
    expect(new Set(contents).size).toBe(1)
  })

  it('reads an untracked-only doc (no git object at all) from the working tree', async () => {
    // The purest form of the invariant: a doc that exists ONLY in the working
    // tree — never committed, so there is no HEAD:<doc> or base:<doc> git
    // object to read. A `git show HEAD:<doc>` reimplementation of readDocs
    // would throw "exists on disk, but not in HEAD" here rather than silently
    // returning stale bytes — this case localizes that regression mode.
    await repo.commit('init', { 'src/keep.ts': 'export const k = 0\n' })
    await fs.mkdir(path.join(repo.root, 'docs'), { recursive: true })
    await fs.writeFile(path.join(repo.root, 'docs', 'untracked.md'), WORKING_TREE_BODY, 'utf8')

    const code = await runLocalPrepare({
      repoRoot: repo.root,
      scope: ['docs/'],
      base: 'HEAD',
      diffSource: 'local',
      stderr: makeCapture().stream,
      stdout: makeCapture().stream,
    })
    expect(code).toBe(0)

    const spec = readDocs().find((d) => d.path === 'docs/untracked.md')
    expect(spec).toBeDefined()
    expect(spec?.content).toBe(WORKING_TREE_BODY)
  })
})
