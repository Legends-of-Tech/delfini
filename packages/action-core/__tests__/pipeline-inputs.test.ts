import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as core from '@actions/core'
import { readPipelineInputs } from '../src/pipeline-inputs.js'

// readPipelineInputs reads its values via @actions/core.getInput; mock it so we
// can drive each input directly. `warning` is mocked to a no-op spy.
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  warning: vi.fn(),
}))

const getInput = core.getInput as unknown as ReturnType<typeof vi.fn>

function mockInputs(map: Record<string, string>): void {
  getInput.mockImplementation((name: string) => map[name] ?? '')
}

describe('readPipelineInputs — ignore_code_scope', () => {
  beforeEach(() => {
    getInput.mockReset()
    process.env.GITHUB_TOKEN = 'token'
  })

  it('defaults to [] when the input is omitted (ignore nothing, no docs/-style fallback)', () => {
    mockInputs({})
    expect(readPipelineInputs().ignoreCodeScope).toEqual([])
  })

  it('splits a comma-delimited list and normalises via the shared engine algebra', () => {
    mockInputs({ ignore_code_scope: 'src/generated/**, db/migrations/' })
    expect(readPipelineInputs().ignoreCodeScope).toEqual(['src/generated/**', 'db/migrations'])
  })

  it('splits a newline-delimited list', () => {
    mockInputs({ ignore_code_scope: 'src/generated/**\nvendor/\nbuild' })
    expect(readPipelineInputs().ignoreCodeScope).toEqual(['src/generated/**', 'vendor', 'build'])
  })

  it('dedupes and canonicalises (trailing slash / ./ / // collapse)', () => {
    mockInputs({ ignore_code_scope: 'src//generated/, ./src/generated, build, build/' })
    expect(readPipelineInputs().ignoreCodeScope).toEqual(['src/generated', 'build'])
  })

  it('a whitespace/delimiter-only input collapses to [] (ignore nothing)', () => {
    mockInputs({ ignore_code_scope: '  , ,\n ' })
    expect(readPipelineInputs().ignoreCodeScope).toEqual([])
  })

  it('does not disturb the doc_scope default when only ignore_code_scope is set', () => {
    mockInputs({ ignore_code_scope: 'gen/**' })
    const inputs = readPipelineInputs()
    expect(inputs.docScope).toEqual(['docs'])
    expect(inputs.ignoreCodeScope).toEqual(['gen/**'])
  })
})
