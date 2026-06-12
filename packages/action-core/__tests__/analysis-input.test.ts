import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { buildAnalysisInput } from '../src/analysis-input.js'
import type { ChangedFile, PrContext } from '../src/github-client-shared.js'

// `@actions/github` reads PR metadata off process.env.GITHUB_*. The function
// only reads `github.context.payload.pull_request?.title`, which is undefined
// in the Vitest environment — that's fine; we assert title === ''.

const ctx: PrContext = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  headSha: 'abc1234',
  baseSha: 'def5678',
  prNumber: 7,
} as PrContext

const codeFile: ChangedFile = {
  filename: 'src/foo.ts',
  status: 'modified',
  patch: '@@ -1,3 +1,3 @@\n export function foo() {\n-  return 1\n+  return 2\n }',
}

const lockfile: ChangedFile = {
  filename: 'pnpm-lock.yaml',
  status: 'modified',
  patch: "@@ -1,3 +1,3 @@\n-lockfileVersion: '9.0'\n+lockfileVersion: '9.1'\n packages:",
}

describe('buildAnalysisInput — P3.7.2 diff pre-filter', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    const core = await import('@actions/core')
    infoSpy = vi.spyOn(core, 'info').mockImplementation(() => {
      // swallow
    })
  })

  afterEach(() => {
    infoSpy.mockRestore()
  })

  it('default (options omitted) — diff includes lockfile, no info log emitted', () => {
    const input = buildAnalysisInput(ctx, [codeFile, lockfile], [])
    expect(input.diff).toContain('pnpm-lock.yaml')
    expect(input.diff).toContain('src/foo.ts')
    // No `Delfini diff pre-filter dropped` summary line.
    const summaryCalls = infoSpy.mock.calls.filter((args) =>
      String(args[0]).startsWith('Delfini diff pre-filter dropped'),
    )
    expect(summaryCalls).toHaveLength(0)
  })

  it('enableDiffPreFilter: false — same as default, byte-identical diff', () => {
    const a = buildAnalysisInput(ctx, [codeFile, lockfile], [])
    const b = buildAnalysisInput(ctx, [codeFile, lockfile], [], { enableDiffPreFilter: false })
    expect(b.diff).toBe(a.diff)
  })

  it('enableDiffPreFilter: true — drops lockfile, keeps src/foo.ts, logs summary', () => {
    const input = buildAnalysisInput(ctx, [codeFile, lockfile], [], {
      enableDiffPreFilter: true,
    })
    expect(input.diff).not.toContain('pnpm-lock.yaml')
    expect(input.diff).toContain('src/foo.ts')
    // Summary log shows lockfile=1.
    const summary = infoSpy.mock.calls
      .map((args) => String(args[0]))
      .find((s) => s.startsWith('Delfini diff pre-filter dropped'))
    expect(summary).toBeDefined()
    expect(summary).toContain('lockfiles=1')
  })

  it('PR metadata is unchanged when the gate runs', () => {
    const input = buildAnalysisInput(ctx, [codeFile], [], { enableDiffPreFilter: true })
    expect(input.prMetadata).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      prNumber: 7,
      headSha: 'abc1234',
      baseSha: 'def5678',
    })
  })
})
