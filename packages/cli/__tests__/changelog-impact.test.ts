import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// The CHANGELOG impact-tag formatter lives at repo-root `.changeset/changelog-impact.cjs`
// (changesets requires it from there per .changeset/config.json). It is release
// infrastructure co-owned with the CLI's release path (Story P3.5.4 AC4), so its
// pure helpers are unit-tested as part of the CLI suite — which is NFR44 gate C.
// We load it via createRequire (CommonJS) and exercise only the pure helpers; the
// network-bound getReleaseLine/getDependencyReleaseLine compositions are validated
// by the changesets `version` smoke (Story P3.5.4 Task 6), not here.
const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const impact = require(resolve(here, '../../../.changeset/changelog-impact.cjs'))

describe('changelog-impact formatter (P3.5.4 AC4)', () => {
  describe('tagForSummary', () => {
    it('maps [drift-engine] → 🔬 drift-engine and strips the marker', () => {
      expect(impact.tagForSummary('[drift-engine] Tighten the prompt')).toEqual({
        tag: '🔬 drift-engine',
        summary: 'Tighten the prompt',
      })
    })

    it('maps [skill] → 🔄 SKILL.md', () => {
      expect(impact.tagForSummary('[skill] Update protocol step 3').tag).toBe('🔄 SKILL.md')
    })

    it('maps [cli] → ⚙️ CLI', () => {
      expect(impact.tagForSummary('[cli] Add --diff-source flag').tag).toBe('⚙️ CLI')
    })

    it('is case-insensitive on the marker', () => {
      expect(impact.tagForSummary('[Drift-Engine] x').tag).toBe('🔬 drift-engine')
    })

    it('defaults to ⚙️ CLI with no marker and leaves the summary intact', () => {
      expect(impact.tagForSummary('Plain summary, no marker')).toEqual({
        tag: '⚙️ CLI',
        summary: 'Plain summary, no marker',
      })
    })

    it('defaults to ⚙️ CLI on an unknown marker and keeps the text verbatim', () => {
      expect(impact.tagForSummary('[unknown] keep me')).toEqual({
        tag: '⚙️ CLI',
        summary: '[unknown] keep me',
      })
    })

    it('tolerates empty and non-string summaries', () => {
      expect(impact.tagForSummary('').tag).toBe('⚙️ CLI')
      expect(impact.tagForSummary(undefined).tag).toBe('⚙️ CLI')
      expect(impact.tagForSummary(null).tag).toBe('⚙️ CLI')
    })
  })

  describe('prefixReleaseLine', () => {
    it('inserts the tag after the leading bullet', () => {
      expect(impact.prefixReleaseLine('\n\n- Some entry text', '⚙️ CLI')).toBe(
        '\n\n- ⚙️ CLI: Some entry text',
      )
    })

    it('preserves a bare leading bullet with no newlines', () => {
      expect(impact.prefixReleaseLine('- entry', '🔬 drift-engine')).toBe(
        '- 🔬 drift-engine: entry',
      )
    })

    it('only rewrites the leading bullet, not hyphens inside the entry text', () => {
      expect(impact.prefixReleaseLine('\n- a - b - c', '⚙️ CLI')).toBe('\n- ⚙️ CLI: a - b - c')
    })
  })

  it('exposes the changesets ChangelogFunctions surface (both bare and .default)', () => {
    expect(typeof impact.getReleaseLine).toBe('function')
    expect(typeof impact.getDependencyReleaseLine).toBe('function')
    expect(typeof impact.default.getReleaseLine).toBe('function')
    expect(typeof impact.default.getDependencyReleaseLine).toBe('function')
  })

  // The composition path is the actual contract with changesets — at `changeset
  // version` time it calls `getReleaseLine(changeset, type, changelogOpts)` and
  // expects a Promise<string> with the upstream output composed with our tag.
  // A regression in delegation/await/marker-stripping would slip past CI without
  // this. We stub @changesets/changelog-github via Node's require cache so the
  // formatter's lazy `require` resolves to a deterministic in-test fake.
  describe('getReleaseLine / getDependencyReleaseLine — composition with stubbed @changesets/changelog-github', () => {
    const upstreamStub = {
      getReleaseLine: async (changeset: any, _type: string) =>
        `\n\n- ${changeset.summary} (PR #${changeset.commit ?? 'X'})`,
      getDependencyReleaseLine: async (_csets: any, deps: any) =>
        `- Updated dependencies: ${deps.length} cascade(s)`,
    }
    const FORMATTER_PATH = resolve(here, '../../../.changeset/changelog-impact.cjs')
    const STUB_PATH = require.resolve('@changesets/changelog-github')

    // Reload the formatter against the stubbed upstream — its lazy `require` and
    // memoized `_github` mean we must purge BOTH cache entries before reload.
    function loadFormatterWithStub() {
      delete require.cache[FORMATTER_PATH]
      delete require.cache[STUB_PATH]
      require.cache[STUB_PATH] = {
        id: STUB_PATH,
        filename: STUB_PATH,
        loaded: true,
        exports: upstreamStub,
      } as NodeJS.Module
      return require(FORMATTER_PATH)
    }

    it('getReleaseLine strips the marker, delegates to upstream, and prepends the impact tag', async () => {
      const f = loadFormatterWithStub()
      const line = await f.getReleaseLine(
        { summary: '[drift-engine] Tighten the prompt', commit: 'abc123' },
        'minor',
        { repo: 'Legends-of-Tech/delfini' },
      )
      // Marker stripped from what upstream sees; tag prepended after upstream renders.
      expect(line).toBe('\n\n- 🔬 drift-engine: Tighten the prompt (PR #abc123)')
    })

    it('getReleaseLine defaults to ⚙️ CLI when no marker is present', async () => {
      const f = loadFormatterWithStub()
      const line = await f.getReleaseLine(
        { summary: 'Plain entry', commit: 'def456' },
        'patch',
        { repo: 'Legends-of-Tech/delfini' },
      )
      expect(line).toBe('\n\n- ⚙️ CLI: Plain entry (PR #def456)')
    })

    it('getReleaseLine does NOT mutate the caller-passed changeset object', async () => {
      const f = loadFormatterWithStub()
      const original = { summary: '[cli] Stable', commit: '789' }
      await f.getReleaseLine(original, 'patch', { repo: 'Legends-of-Tech/delfini' })
      // The wrapper Object.assigns a patched copy — caller's summary must survive.
      expect(original.summary).toBe('[cli] Stable')
    })

    it('getDependencyReleaseLine delegates unchanged (no surface tag prepended)', async () => {
      const f = loadFormatterWithStub()
      const line = await f.getDependencyReleaseLine([], [{ name: '@delfini/drift-engine' }], {
        repo: 'Legends-of-Tech/delfini',
      })
      // Internal-dep cascade lines pass through untagged by design.
      expect(line).toBe('- Updated dependencies: 1 cascade(s)')
    })
  })
})
