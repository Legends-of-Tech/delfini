import { describe, expect, it } from 'vitest'
import { buildUnifiedDiff } from '../src/diff-builder.js'
import type { ChangedFile } from '../src/github-client-shared.js'

describe('buildUnifiedDiff', () => {
  it('returns empty string for zero files', () => {
    expect(buildUnifiedDiff([])).toBe('')
  })

  it('skips files without a patch', () => {
    const files: ChangedFile[] = [
      { filename: 'binary.bin', status: 'modified' },
      { filename: 'renamed-no-content.ts', status: 'renamed' },
    ]

    expect(buildUnifiedDiff(files)).toBe('')
  })

  it('synthesises diff --git header and a/b prefixes for a modified file', () => {
    const files: ChangedFile[] = [
      {
        filename: 'src/api.ts',
        status: 'modified',
        patch: '@@ -1,3 +1,3 @@\n-old\n+new\n context',
      },
    ]

    const out = buildUnifiedDiff(files)

    expect(out).toContain('diff --git a/src/api.ts b/src/api.ts')
    expect(out).toContain('--- a/src/api.ts')
    expect(out).toContain('+++ b/src/api.ts')
    expect(out).toContain('@@ -1,3 +1,3 @@')
  })

  it('uses /dev/null for added files', () => {
    const files: ChangedFile[] = [
      { filename: 'new.ts', status: 'added', patch: '@@ -0,0 +1,1 @@\n+hi' },
    ]

    const out = buildUnifiedDiff(files)

    expect(out).toContain('--- /dev/null')
    expect(out).toContain('+++ b/new.ts')
  })

  it('uses /dev/null for removed files', () => {
    const files: ChangedFile[] = [
      { filename: 'gone.ts', status: 'removed', patch: '@@ -1,1 +0,0 @@\n-bye' },
    ]

    const out = buildUnifiedDiff(files)

    expect(out).toContain('--- a/gone.ts')
    expect(out).toContain('+++ /dev/null')
  })

  it('produces exactly one diff --git header per patched file (matches prompt-builder counter)', () => {
    const files: ChangedFile[] = [
      { filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+A' },
      { filename: 'b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+B' },
      { filename: 'binary.png', status: 'modified' },
      { filename: 'c.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-c' },
    ]

    const out = buildUnifiedDiff(files)
    const headerCount = out.match(/^diff --git /gm)?.length ?? 0
    expect(headerCount).toBe(3)
  })
})
