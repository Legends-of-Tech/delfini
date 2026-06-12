import { describe, it, expect, vi } from 'vitest'
import {
  parseFrontMatter,
  stripFrontMatter,
} from '../src/doc-exclusion'

describe('parseFrontMatter', () => {
  it('returns ignore=false when no front-matter present', () => {
    const result = parseFrontMatter('# Plain doc\n\nNo front-matter here.')
    expect(result.ignore).toBe(false)
    expect(result.body).toContain('# Plain doc')
  })

  it('returns ignore=false when delfini key is absent', () => {
    const result = parseFrontMatter('---\ntitle: Guide\n---\n# Guide')
    expect(result.ignore).toBe(false)
    expect(result.body.trim()).toBe('# Guide')
  })

  it('recognises shorthand "delfini: ignore"', () => {
    const result = parseFrontMatter('---\ndelfini: ignore\n---\n# Body')
    expect(result.ignore).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('recognises "delfini: skip" as an alias', () => {
    const result = parseFrontMatter('---\ndelfini: skip\n---\n# Body')
    expect(result.ignore).toBe(true)
  })

  it('is case-insensitive for shorthand string values', () => {
    const result = parseFrontMatter('---\ndelfini: IGNORE\n---\n')
    expect(result.ignore).toBe(true)
  })

  it('accepts boolean true as a coarse ignore flag', () => {
    const result = parseFrontMatter('---\ndelfini: true\n---\n')
    expect(result.ignore).toBe(true)
  })

  it('recognises verbose object with ignore=true and reason', () => {
    const yaml = [
      '---',
      'delfini:',
      '  ignore: true',
      '  reason: "aspirational draft, not yet ratified"',
      '---',
      '# Body',
    ].join('\n')
    const result = parseFrontMatter(yaml)
    expect(result.ignore).toBe(true)
    expect(result.reason).toBe('aspirational draft, not yet ratified')
  })

  it('accepts "skip: true" inside verbose object', () => {
    const yaml = '---\ndelfini:\n  skip: true\n---\n'
    const result = parseFrontMatter(yaml)
    expect(result.ignore).toBe(true)
  })

  it('returns ignore=false when verbose object has ignore=false', () => {
    const yaml = '---\ndelfini:\n  ignore: false\n---\n'
    const result = parseFrontMatter(yaml)
    expect(result.ignore).toBe(false)
  })

  it('fails open and warns on unrecognised string value', () => {
    const onWarn = vi.fn()
    const result = parseFrontMatter('---\ndelfini: maybe\n---\n', onWarn)
    expect(result.ignore).toBe(false)
    expect(onWarn).toHaveBeenCalled()
  })

  it('fails open on verbose object missing a boolean flag', () => {
    const onWarn = vi.fn()
    const result = parseFrontMatter(
      '---\ndelfini:\n  reason: "because"\n---\n',
      onWarn,
    )
    expect(result.ignore).toBe(false)
    expect(onWarn).toHaveBeenCalled()
  })

  it('fails open on malformed YAML front-matter', () => {
    const onWarn = vi.fn()
    const result = parseFrontMatter(
      '---\ndelfini: [unclosed\n---\n# Body',
      onWarn,
    )
    expect(result.ignore).toBe(false)
    expect(onWarn).toHaveBeenCalled()
  })

  it('drops empty reason strings', () => {
    const yaml = '---\ndelfini:\n  ignore: true\n  reason: ""\n---\n'
    const result = parseFrontMatter(yaml)
    expect(result.ignore).toBe(true)
    expect(result.reason).toBeUndefined()
  })
})

describe('parseFrontMatter — frontMatterLineCount (Story 3.9b)', () => {
  it('returns 0 when no front-matter is present', () => {
    expect(parseFrontMatter('# Plain doc\n\nBody.').frontMatterLineCount).toBe(0)
  })

  it('returns 3 for a single-line YAML block (--- + 1 line + ---)', () => {
    expect(parseFrontMatter('---\ntitle: Guide\n---\n# Body').frontMatterLineCount).toBe(3)
  })

  it('returns 5 for a 3-line YAML block (--- + 3 lines + ---)', () => {
    const yaml = '---\ntitle: Guide\nauthor: x\nversion: 2\n---\n# Body'
    expect(parseFrontMatter(yaml).frontMatterLineCount).toBe(5)
  })

  it('handles CRLF line endings', () => {
    const yaml = '---\r\ntitle: Guide\r\n---\r\n# Body'
    expect(parseFrontMatter(yaml).frontMatterLineCount).toBe(3)
  })

  it('returns 2 for an empty YAML block (--- + ---)', () => {
    expect(parseFrontMatter('---\n---\n# Body').frontMatterLineCount).toBe(2)
  })

  // Note: there's no clean "malformed YAML throws → catch path returns 0" test
  // here because gray-matter parses most malformed YAML permissively (it falls
  // back to a string-valued `data` rather than throwing). The malformed-input
  // contract is exercised by the existing 'fails open on malformed YAML
  // front-matter' test in the parent describe block.
})

describe('stripFrontMatter', () => {
  it('returns content without front-matter block', () => {
    const out = stripFrontMatter('---\ntitle: x\n---\n# Body\n')
    expect(out).not.toContain('---')
    expect(out).toContain('# Body')
  })

  it('returns original content when no front-matter present', () => {
    const out = stripFrontMatter('# Body')
    expect(out).toBe('# Body')
  })
})
