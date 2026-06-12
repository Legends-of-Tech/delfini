import { describe, it, expect } from 'vitest'
import { classifyPr } from '../src/smart-skip'

describe('classifyPr', () => {
  // Story P2.6 — docScope is `string[]` (ADR-2026-06-01).
  const defaultOptions = { docScope: ['docs'] }

  it('returns skip with reason when file list is empty', () => {
    const result = classifyPr([], defaultOptions)

    expect(result).toEqual({
      shouldSkip: true,
      reason: 'No changed files detected',
    })
  })

  it('skips pure dependency changes', () => {
    const files = ['package.json', 'pnpm-lock.yaml']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toContain('2 dependency updates')
  })

  it('skips pure CI config changes', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/release.yaml']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toContain('2 CI config changes')
  })

  it('skips mixed dependency and CI config changes', () => {
    const files = ['package.json', 'yarn.lock', '.github/workflows/test.yml']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toContain('2 dependency updates')
    expect(result.reason).toContain('1 CI config change')
  })

  it('skips generated files only', () => {
    const files = ['src/routeTree.gen.ts', 'src/types.generated.ts']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toContain('2 generated files')
  })

  it('skips node_modules files', () => {
    const files = ['node_modules/lodash/index.js']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toContain('1 node_modules change')
  })

  it('does not skip when a business file is present among dependency changes', () => {
    const files = ['package.json', 'pnpm-lock.yaml', 'src/main.ts']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(false)
    expect(result.reason).toBe('Business-logic changes detected')
  })

  it('skips when only docs within docScope are changed', () => {
    const files = ['docs/api-reference.md']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe('1 doc-only change in doc scope')
  })

  it('skips when multiple docs within docScope are changed', () => {
    const files = ['docs/a.md', 'docs/b.md', 'docs/sub/c.md']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe('3 doc-only changes in doc scope')
  })

  it('does not skip when doc changes are mixed with dependency changes', () => {
    const files = ['package.json', 'docs/guide.md']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(false)
    expect(result.reason).toBe('Mixed doc and non-doc changes detected')
  })

  it('does not skip when doc-in-scope is mixed with multiple dependency updates', () => {
    const files = ['docs/api.md', 'package.json', 'pnpm-lock.yaml']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(false)
    expect(result.reason).toBe('Mixed doc and non-doc changes detected')
  })

  it('does not skip when doc-in-scope is mixed with business code', () => {
    const files = ['docs/api.md', 'src/main.ts']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(false)
    expect(result.reason).toBe('Business-logic changes detected')
  })

  it('does not skip test files by default', () => {
    const files = ['src/utils.test.ts']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(false)
    expect(result.reason).toBe('Business-logic changes detected')
  })

  it('skips test files when skipTestFiles is true', () => {
    const files = ['src/utils.test.ts', 'src/helper.spec.ts', 'src/component.test.tsx']
    const result = classifyPr(files, { ...defaultOptions, skipTestFiles: true })

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toContain('3 test file changes')
  })

  it('does not skip when business file is present even with skipTestFiles enabled', () => {
    const files = ['src/utils.test.ts', 'src/main.ts']
    const result = classifyPr(files, { ...defaultOptions, skipTestFiles: true })

    expect(result.shouldSkip).toBe(false)
    expect(result.reason).toBe('Business-logic changes detected')
  })

  it('handles nested docScope correctly', () => {
    const files = ['my-docs/sub/readme.md']
    const result = classifyPr(files, { docScope: ['my-docs'] })

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe('1 doc-only change in doc scope')
  })

  it('handles docScope with trailing slash', () => {
    const files = ['docs/readme.md']
    const result = classifyPr(files, { docScope: ['docs/'] })

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe('1 doc-only change in doc scope')
  })

  it('does not treat non-docScope .md files as doc changes', () => {
    const files = ['README.md']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(false)
    expect(result.reason).toBe('Business-logic changes detected')
  })

  it('handles deeply nested CI config files', () => {
    const files = ['.github/actions/custom/action.yml']
    const result = classifyPr(files, defaultOptions)

    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toContain('1 CI config change')
  })

})
