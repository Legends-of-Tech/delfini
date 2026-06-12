import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Writable } from 'node:stream'

import { runLocalFinalize } from '../src/commands/local-finalize.js'

// ---------------------------------------------------------------------------
// Helpers — real fs temp dirs
// ---------------------------------------------------------------------------

interface TempRoot {
  root: string
  cleanup: () => Promise<void>
}

async function makeTempRoot(): Promise<TempRoot> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delfini-cli-local-finalize-'))
  return {
    root,
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

/**
 * Write `.delfini-trace/analysis-input.json` for the test. Most tests pass
 * a single doc whose content is whatever the test needs for line-grounding.
 */
async function writeAnalysisInput(
  root: string,
  docs: Array<{ path: string; content: string; frontMatterLineCount?: number }>,
): Promise<void> {
  const traceDir = path.join(root, '.delfini-trace')
  await fs.mkdir(traceDir, { recursive: true })
  const analysisInput = {
    diff: '',
    docs: docs.map((d) => ({
      path: d.path,
      content: d.content,
      frontMatterLineCount: d.frontMatterLineCount ?? 0,
    })),
    prMetadata: {
      owner: 'local',
      repo: 'test',
      prNumber: 0,
      headSha: 'abc',
      baseSha: 'def',
      title: 'Local /delfini run',
    },
  }
  await fs.writeFile(
    path.join(traceDir, 'analysis-input.json'),
    `${JSON.stringify(analysisInput, null, 2)}\n`,
    'utf8',
  )
}

async function writeFindings(root: string, findings: unknown): Promise<string> {
  const traceDir = path.join(root, '.delfini-trace')
  await fs.mkdir(traceDir, { recursive: true })
  const filePath = path.join(traceDir, 'findings.json')
  await fs.writeFile(filePath, JSON.stringify(findings, null, 2), 'utf8')
  return filePath
}

// ---------------------------------------------------------------------------
// Test fixtures — finding payloads
// ---------------------------------------------------------------------------

const DOC_CONTENT = `# Architecture\n\nWe use Postgres for storage.\nWe use Redis for caching.\nWe use Vite for builds.\n`
//                      L1            L2  L3                                L4                          L5

interface DriftFindingFixture {
  targetDocPath: string
  targetSection: string
  targetLineStart: number
  targetLineEnd: number
  whatChanged: string
  whatContradicts: string
  proposedReplacement: string
  severity: 'High' | 'Medium' | 'Low'
  confidence: number
  quotedDocText: string
}

function driftFinding(overrides: Partial<DriftFindingFixture> = {}): DriftFindingFixture {
  return {
    targetDocPath: 'docs/arch.md',
    targetSection: 'Storage',
    targetLineStart: 3,
    targetLineEnd: 3,
    whatChanged: 'Switched from Postgres to MySQL',
    whatContradicts: 'Doc claims Postgres',
    proposedReplacement: 'We use MySQL for storage.',
    severity: 'High',
    confidence: 5,
    quotedDocText: 'We use Postgres for storage.',
    ...overrides,
  }
}

function additiveFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetDocPath: 'docs/arch.md',
    anchorSection: 'Architecture',
    insertionMode: 'after',
    proposedContent: 'We now use Kafka for messaging.',
    severity: 'Medium',
    confidence: 4,
    whatChanged: 'Added Kafka',
    rationaleForAddition: 'New foundational tech',
    ...overrides,
  }
}

function clarificationFinding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    whatChanged: 'Added a new auth flow',
    naturalHomeDoc: 'docs/arch.md',
    naturalHomeSection: 'Authentication',
    question: 'Should this be documented under Authentication or Security?',
    proposedReplacement: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC3 — Exit codes
// ---------------------------------------------------------------------------

describe('runLocalFinalize — exit codes (AC3)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('exits 0 when there are zero findings', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.9,
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(0)
  })

  it('exits 1 when there is at least one drift finding', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding()],
      additions: [],
      rawConfidence: 0.9,
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
  })

  it('exits 1 when there is at least one additive finding (no drift)', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [additiveFinding()],
      rawConfidence: 0.85,
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
  })

  it('exits 0 when only clarification findings (no drift, no additive)', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.7,
      clarifyingQuestions: [clarificationFinding()],
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(0)
  })

  it('exits 1 when drift + clarification (clarification is informational only)', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding()],
      additions: [],
      rawConfidence: 0.9,
      clarifyingQuestions: [clarificationFinding()],
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC2 — Schema-validation failure (exit 3)
// ---------------------------------------------------------------------------

describe('runLocalFinalize — schema-validation failure (AC2)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('exits 3 on malformed JSON in findings file', async () => {
    const traceDir = path.join(temp.root, '.delfini-trace')
    await fs.mkdir(traceDir, { recursive: true })
    const findingsPath = path.join(traceDir, 'findings.json')
    await fs.writeFile(findingsPath, '{not valid json', 'utf8')

    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(3)
    const payload = JSON.parse(stderr.text()) as {
      error: string
      issues: Array<{ path: string; message: string }>
    }
    expect(payload.error).toBe('schema_validation')
    expect(payload.issues).toHaveLength(1)
    expect(payload.issues[0]!.message).toMatch(/JSON/i)
  })

  it('exits 3 when severity is invalid; issues[0].path is contradictions.0.severity', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [{ ...driftFinding(), severity: 'critical' }],
      additions: [],
      rawConfidence: 0.9,
    })

    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(3)
    const payload = JSON.parse(stderr.text()) as {
      error: string
      issues: Array<{ path: string; message: string }>
    }
    expect(payload.error).toBe('schema_validation')
    expect(payload.issues[0]!.path).toBe('contradictions.0.severity')
  })

  it('exits 3 when analysis-input.json is missing; message names the missing path', async () => {
    // Wipe the analysis-input.json the beforeEach helper wrote.
    await fs.rm(path.join(temp.root, '.delfini-trace', 'analysis-input.json'), { force: true })

    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.9,
    })

    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(3)
    const payload = JSON.parse(stderr.text()) as {
      error: string
      issues: Array<{ path: string; message: string }>
    }
    expect(payload.error).toBe('schema_validation')
    expect(payload.issues[0]!.message).toMatch(/analysis-input\.json/)
  })

  it('exits 3 when clarifyingQuestions entry is shape-invalid', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.9,
      clarifyingQuestions: [{ whatChanged: '', naturalHomeDoc: 'x', naturalHomeSection: 'y', question: 'z', proposedReplacement: null }],
    })

    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(3)
    const payload = JSON.parse(stderr.text()) as {
      error: string
      issues: Array<{ path: string; message: string }>
    }
    expect(payload.error).toBe('schema_validation')
    expect(payload.issues[0]!.path).toMatch(/^clarifyingQuestions\./)
  })
})

// ---------------------------------------------------------------------------
// AC1 + AC10 — report.md write + stdout mirror
// ---------------------------------------------------------------------------

describe('runLocalFinalize — report.md write + stdout mirror (AC1, AC10)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('writes report.md to .delfini-trace/ and mirrors to stdout', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding()],
      additions: [],
      rawConfidence: 0.9,
    })

    const stdout = makeCapture()
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: stdout.stream,
      stderr: makeCapture().stream,
    })

    const reportPath = path.join(temp.root, '.delfini-trace', 'report.md')
    const fileContent = readFileSync(reportPath, 'utf8')
    expect(fileContent).toMatch(/^# Delfini drift analysis/)
    // stdout received the same content (with a trailing newline tolerated).
    expect(stdout.text().trimEnd()).toBe(fileContent.trimEnd())
  })
})

// ---------------------------------------------------------------------------
// AC4 + AC5 + AC6 — Section headings + summary + drift/additive rendering
// ---------------------------------------------------------------------------

describe('runLocalFinalize — report structure (AC4, AC5, AC6)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('empty findings → summary line + no section headings, plus "No apply-eligible findings."', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.5,
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const reportPath = path.join(temp.root, '.delfini-trace', 'report.md')
    const content = readFileSync(reportPath, 'utf8')
    expect(content).toContain('0 drift, 0 additive, 0 clarification finding(s).')
    expect(content).toContain('No apply-eligible findings.')
    expect(content).not.toContain('## Apply-eligible findings')
    expect(content).not.toContain('## Manual review required')
  })

  it('drift-only → summary + Apply-eligible heading + indexed [1]', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding()],
      additions: [],
      rawConfidence: 0.9,
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('1 drift, 0 additive, 0 clarification finding(s).')
    expect(content).toContain('## Apply-eligible findings')
    expect(content).toContain('### [1] [H] drift: docs/arch.md:3-3')
    expect(content).not.toContain('## Manual review required')
  })

  it('mixed drift + additive → drift indexed first, additive continues numbering', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding(), driftFinding({ quotedDocText: 'We use Redis for caching.', proposedReplacement: 'We use Memcached for caching.' })],
      additions: [additiveFinding()],
      rawConfidence: 0.9,
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('2 drift, 1 additive, 0 clarification finding(s).')
    expect(content).toContain('### [1] [H] drift: docs/arch.md:3-3')
    expect(content).toContain('### [2] [H] drift: docs/arch.md:4-4')
    expect(content).toContain('### [3] [M] additive: docs/arch.md — insert after line 1')
  })

  it('severity icons map [High|Medium|Low] → [H]/[M]/[L]', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [
        driftFinding({ severity: 'High' }),
        driftFinding({
          severity: 'Medium',
          quotedDocText: 'We use Redis for caching.',
          proposedReplacement: 'We use Memcached for caching.',
        }),
        driftFinding({
          severity: 'Low',
          quotedDocText: 'We use Vite for builds.',
          proposedReplacement: 'We use Rollup for builds.',
        }),
      ],
      additions: [],
      rawConfidence: 0.9,
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toMatch(/\[1\] \[H\]/)
    expect(content).toMatch(/\[2\] \[M\]/)
    expect(content).toMatch(/\[3\] \[L\]/)
  })
})

// ---------------------------------------------------------------------------
// AC7 — Clarification rendering
// ---------------------------------------------------------------------------

describe('runLocalFinalize — clarification rendering (AC7, FR147)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('clarification-only → Manual review required heading + no index prefix', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.7,
      clarifyingQuestions: [clarificationFinding()],
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('## Manual review required')
    expect(content).toContain('### Clarification: docs/arch.md — Authentication')
    // Must NOT carry an apply-eligible numeric prefix like "### [1]".
    expect(content).not.toMatch(/### \[\d+\] .*Clarification/)
    expect(content).toContain('0 drift, 0 additive, 1 clarification finding(s).')
  })

  it('clarification with null proposedReplacement omits the Suggested replacement block', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.7,
      clarifyingQuestions: [clarificationFinding({ proposedReplacement: null })],
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).not.toContain('**Suggested replacement (optional):**')
  })

  it('clarification with non-null proposedReplacement includes the Suggested replacement block', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.7,
      clarifyingQuestions: [clarificationFinding({ proposedReplacement: 'Document it under Security.' })],
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('**Suggested replacement (optional):**')
    expect(content).toContain('Document it under Security.')
  })
})

// ---------------------------------------------------------------------------
// AC8 — Reconciled line numbers (NOT raw LLM claims)
// ---------------------------------------------------------------------------

describe('runLocalFinalize — reconciled line numbers (AC8)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('overrides LLM-claimed line range with the reconciled range derived from quotedDocText', async () => {
    // Doc body: "We use Postgres for storage." is at line 3 (per DOC_CONTENT).
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])

    const findingsPath = await writeFindings(temp.root, {
      contradictions: [
        driftFinding({ targetLineStart: 999, targetLineEnd: 999 }), // LLM lied
      ],
      additions: [],
      rawConfidence: 0.9,
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('docs/arch.md:3-3')
    expect(content).not.toContain('999')
  })
})

// ---------------------------------------------------------------------------
// AC9 — NFR46 determinism
// ---------------------------------------------------------------------------

describe('runLocalFinalize — determinism (AC9, NFR46)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('two runs with identical inputs produce byte-identical report.md', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding()],
      additions: [additiveFinding()],
      rawConfidence: 0.9,
      clarifyingQuestions: [clarificationFinding()],
    })

    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const first = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')

    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const second = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')

    expect(second).toBe(first)
  })

  it('report contains no timestamp / date / random-ish markers', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding()],
      additions: [],
      rawConfidence: 0.9,
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    // No ISO timestamps (YYYY-MM-DDTHH:MM:SS-style).
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    // No "Generated at" / "Generated on".
    expect(content).not.toMatch(/[Gg]enerated\s+(at|on)/)
  })

  it('report uses LF line endings exclusively', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding()],
      additions: [],
      rawConfidence: 0.9,
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).not.toMatch(/\r\n/)
  })

  it('snapshot — pinned shape for a mixed-finding fixture', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [
        driftFinding({
          severity: 'High',
          confidence: 5,
          quotedDocText: 'We use Postgres for storage.',
          proposedReplacement: 'We use MySQL for storage.',
        }),
      ],
      additions: [
        additiveFinding({
          severity: 'Medium',
          confidence: 4,
          anchorSection: 'Architecture',
          insertionMode: 'before',
          proposedContent: 'We now use Kafka for messaging.',
        }),
      ],
      rawConfidence: 0.9,
      clarifyingQuestions: [
        clarificationFinding({
          whatChanged: 'Added a new auth flow',
          naturalHomeDoc: 'docs/arch.md',
          naturalHomeSection: 'Authentication',
          question: 'Where should this live?',
          proposedReplacement: null,
        }),
      ],
    })
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// Unified-diff renderer (P3.x — UX cleanup task 6)
// ---------------------------------------------------------------------------

describe('renderer — unified diff fence for apply-eligible findings', () => {
  it('renders single-line drift as a ```diff fence with one - and one + line', async () => {
    const temp = await makeTempRoot()
    try {
      await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
      const findings = {
        contradictions: [
          {
            targetDocPath: 'docs/arch.md',
            targetSection: 'Storage',
            targetLineStart: 3,
            targetLineEnd: 3,
            whatChanged: 'Switched to PostgreSQL 17',
            whatContradicts: 'Doc still says Postgres without version',
            quotedDocText: 'We use Postgres for storage.',
            proposedReplacement: 'We use PostgreSQL 17 for storage.',
            severity: 'High',
            confidence: 5,
          },
        ],
        additions: [],
        rawConfidence: 0.9,
      }
      const findingsPath = await writeFindings(temp.root, findings)
      await runLocalFinalize({
        findingsPath,
        repoRoot: temp.root,
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
      })
      const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
      expect(content).toContain('**Proposed change:**')
      expect(content).toContain('```diff')
      expect(content).toContain('- We use Postgres for storage.')
      expect(content).toContain('+ We use PostgreSQL 17 for storage.')
      // Old separated-block labels are gone for drift findings.
      expect(content).not.toContain('**Quoted doc text:**')
      expect(content).not.toContain('**Proposed replacement:**')
    } finally {
      await temp.cleanup()
    }
  })

  it('renders single-line additive as a ```diff fence with + line only (no - lines)', async () => {
    const temp = await makeTempRoot()
    try {
      await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
      const findings = {
        contradictions: [],
        additions: [
          {
            targetDocPath: 'docs/arch.md',
            // 'Architecture' is the only heading in DOC_CONTENT; reconciler drops additives whose anchorSection can't be located.
            anchorSection: 'Architecture',
            anchorLine: 1,
            insertionMode: 'before',
            proposedContent: 'We now use Kafka for messaging.',
            whatChanged: 'Added Kafka',
            rationaleForAddition: 'Eventing not documented yet',
            severity: 'Medium',
            confidence: 4,
          },
        ],
        rawConfidence: 0.9,
      }
      const findingsPath = await writeFindings(temp.root, findings)
      await runLocalFinalize({
        findingsPath,
        repoRoot: temp.root,
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
      })
      const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
      expect(content).toContain('**Proposed addition (insert before line 1):**')
      expect(content).toContain('```diff')
      expect(content).toContain('+ We now use Kafka for messaging.')
      // Additive has no prior text, so no `- ` lines should appear inside its diff fence.
      // (We can't assert `not.toContain('- ')` globally — drift findings elsewhere in the
      // report may carry `- ` lines. Anchor on the heading proximity instead.)
      const additiveStart = content.indexOf('### [1] [M] additive:')
      expect(additiveStart).toBeGreaterThanOrEqual(0)
      const additiveBlock = content.slice(additiveStart)
      // Strip everything after the closing diff fence — the slice past that may include trailing sections.
      const fenceClose = additiveBlock.indexOf('```', additiveBlock.indexOf('```diff') + '```diff'.length)
      const additiveFenced = additiveBlock.slice(0, fenceClose)
      expect(additiveFenced).not.toMatch(/^- /m)
      // Old separated-block label gone for additives too.
      expect(content).not.toContain('**Proposed content:**')
    } finally {
      await temp.cleanup()
    }
  })

  it('renders multi-line drift replacements with - / + on every line of each side', async () => {
    const temp = await makeTempRoot()
    try {
      await writeAnalysisInput(temp.root, [
        { path: 'docs/arch.md', content: '# Title\n\nA\nB\nC\nD\n' },
      ])
      const findings = {
        contradictions: [
          {
            targetDocPath: 'docs/arch.md',
            targetSection: 'Body',
            targetLineStart: 3,
            targetLineEnd: 4,
            whatChanged: 'Switch A/B → X/Y',
            whatContradicts: 'Code now uses X/Y',
            quotedDocText: 'A\nB',
            proposedReplacement: 'X\nY',
            severity: 'High',
            confidence: 5,
          },
        ],
        additions: [],
        rawConfidence: 0.9,
      }
      const findingsPath = await writeFindings(temp.root, findings)
      await runLocalFinalize({
        findingsPath,
        repoRoot: temp.root,
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
      })
      const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
      // Every line on each side carries the diff prefix — no stray bare lines.
      expect(content).toContain('- A\n- B\n+ X\n+ Y')
    } finally {
      await temp.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Code-review B5 / E14 — drift-engine reconciliation warnings on stderr
// ---------------------------------------------------------------------------

describe('runLocalFinalize — reconciliation warnings surfaced to stderr (code-review B5)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('warns to stderr when a drift finding cites doc text that cannot be located', async () => {
    // quotedDocText does NOT exist in the doc body → reconcileLineNumbers
    // drops the finding and emits a warning via onWarn.
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [
        driftFinding({
          quotedDocText: 'This text does not appear anywhere in the doc',
        }),
      ],
      additions: [],
      rawConfidence: 0.9,
    })

    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    // Finding was dropped → no apply-eligible findings → exit 0.
    expect(code).toBe(0)
    // Warning surfaced to stderr with a leading marker so it isn't
    // mistaken for the schema_validation JSON payload.
    expect(stderr.text()).toMatch(/⚠️/)
    expect(stderr.text()).toMatch(/quotedDocText not found/)
  })

  it('warns to stderr when an additive anchor section cannot be located', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [],
      additions: [
        additiveFinding({
          anchorSection: 'NonExistentSection',
        }),
      ],
      rawConfidence: 0.9,
    })

    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(0)
    expect(stderr.text()).toMatch(/anchor section heading not found/)
  })
})

// ---------------------------------------------------------------------------
// Narrative-only drift rendering (post-v6.5 Skill UX fix)
//
// When the LLM emits a contradiction with `proposedReplacement: null`, the
// drift-engine routes it onto `AnalysisResult.narrativeOnlyContradictions`
// instead of `contradictions`. The CLI surfaces these under "Manual review
// required" — they are real drifts the user needs to triage manually but
// are NOT apply-eligible (no concrete doc patch).
// ---------------------------------------------------------------------------

describe('runLocalFinalize — narrative-only drift rendering', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('routes a null-proposedReplacement contradiction into Manual review required', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding({ proposedReplacement: null as unknown as string })],
      additions: [],
      rawConfidence: 0.9,
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    // Exit 1: narrative-only drift is something the user must act on.
    expect(code).toBe(1)
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    // Count line includes narrative-only in the drift total.
    expect(content).toContain('1 drift, 0 additive, 0 clarification finding(s).')
    // Apply-eligible section is absent / empty.
    expect(content).not.toContain('## Apply-eligible findings')
    expect(content).toContain('No apply-eligible findings.')
    // Manual review section surfaces the narrative-only entry with no index prefix.
    expect(content).toContain('## Manual review required')
    expect(content).toContain('### [H] narrative-only drift: docs/arch.md:3-3')
    expect(content).not.toMatch(/### \[\d+\] .*narrative-only/)
    // No Proposed replacement block (null was the original signal).
    expect(content).not.toContain('**Proposed replacement:**')
    // Resolution guidance is present.
    expect(content).toContain('**Resolution:**')
  })

  it('routes an empty-string proposedReplacement into Manual review required', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding({ proposedReplacement: '' })],
      additions: [],
      rawConfidence: 0.9,
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('### [H] narrative-only drift: docs/arch.md:3-3')
  })

  it('does NOT route a no-op (byte-equal) replacement to narrative-only — that remains a silent drop', async () => {
    // proposedReplacement equals quotedDocText → reconcile filter drops it
    // entirely (stale-comment noise), not routed to narrative-only.
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [
        driftFinding({
          proposedReplacement: 'We use Postgres for storage.',
          quotedDocText: 'We use Postgres for storage.',
        }),
      ],
      additions: [],
      rawConfidence: 0.9,
    })
    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(0)
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('0 drift, 0 additive, 0 clarification finding(s).')
    expect(content).not.toContain('## Manual review required')
    // Byte-equal drop still warns on stderr (existing observability contract).
    expect(stderr.text()).toMatch(/byte-equal to quotedDocText/)
  })

  it('renders narrative-only alongside apply-eligible drift — drift count is the sum', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [
        // Apply-eligible drift.
        driftFinding(),
        // Narrative-only drift (different quote so it grounds on a different line).
        driftFinding({
          proposedReplacement: null as unknown as string,
          quotedDocText: 'We use Redis for caching.',
          targetSection: 'Caching',
        }),
      ],
      additions: [],
      rawConfidence: 0.9,
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    // Total drift count = 1 apply-eligible + 1 narrative-only.
    expect(content).toContain('2 drift, 0 additive, 0 clarification finding(s).')
    // Both sections present.
    expect(content).toContain('## Apply-eligible findings')
    expect(content).toContain('### [1] [H] drift: docs/arch.md:3-3')
    expect(content).toContain('## Manual review required')
    expect(content).toContain('### [H] narrative-only drift: docs/arch.md:4-4')
  })

  it('renders narrative-only and clarifications in the same Manual review section (narrative-only first)', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding({ proposedReplacement: null as unknown as string })],
      additions: [],
      rawConfidence: 0.8,
      clarifyingQuestions: [clarificationFinding()],
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
    const content = readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
    expect(content).toContain('1 drift, 0 additive, 1 clarification finding(s).')
    expect(content).toContain('## Manual review required')
    // Narrative-only entry appears BEFORE the clarification entry in the section.
    const narrativeIdx = content.indexOf('### [H] narrative-only drift:')
    const clarificationIdx = content.indexOf('### Clarification:')
    expect(narrativeIdx).toBeGreaterThan(-1)
    expect(clarificationIdx).toBeGreaterThan(-1)
    expect(narrativeIdx).toBeLessThan(clarificationIdx)
  })

  it('null-proposedReplacement does NOT emit a stderr warning (route ≠ drop)', async () => {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [driftFinding({ proposedReplacement: null as unknown as string })],
      additions: [],
      rawConfidence: 0.9,
    })
    const stderr = makeCapture()
    await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    // Pre-fix behaviour was "Reconciliation dropped finding ... proposedReplacement is empty";
    // post-fix that path routes to narrative-only instead and the warning is suppressed
    // (the finding is now visible to the user in report.md, so the warning is redundant).
    expect(stderr.text()).not.toMatch(/proposedReplacement is empty/)
  })
})

// ---------------------------------------------------------------------------
// P3.3.3 — apply-eligible vs manual-review segregation (cross-layer)
//
// Integration guards for the FR146/FR147 no-fabrication invariant. The
// renderer (this file) and the SKILL.md apply-UX digest (skill-template.test.ts)
// must agree on one thing: only apply-eligible findings carry a numeric index,
// and only their headings match the digest-count regex the SKILL.md uses to
// derive N/X/Y. If a manual-review heading ever matched that regex, a
// clarification or narrative-only drift could be counted as apply-eligible and
// offered for auto-apply — the exact leak FR147 forbids.
// ---------------------------------------------------------------------------

describe('runLocalFinalize — index integrity across all four finding kinds (P3.3.3, FR147)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  // The exact heading shape the SKILL.md Apply-UX digest counts:
  // `### [<n>] [<severity>] (drift|additive):` — index-first, severity-second.
  // Kept verbatim here so this test fails if the renderer ever drifts from the
  // shape the protocol's digest derivation depends on.
  const DIGEST_HEADING_RE = /^### \[\d+\] \[[HML]\] (drift|additive):/

  async function renderFourKindReport(): Promise<string> {
    const findingsPath = await writeFindings(temp.root, {
      contradictions: [
        // Apply-eligible drift (L3 'We use Postgres for storage.').
        driftFinding(),
        // Narrative-only drift (null replacement, L4 'We use Redis for caching.').
        driftFinding({
          proposedReplacement: null as unknown as string,
          quotedDocText: 'We use Redis for caching.',
          targetSection: 'Caching',
        }),
      ],
      additions: [additiveFinding()],
      rawConfidence: 0.9,
      clarifyingQuestions: [clarificationFinding()],
    })
    const code = await runLocalFinalize({
      findingsPath,
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(1)
    return readFileSync(path.join(temp.root, '.delfini-trace', 'report.md'), 'utf8')
  }

  it('only drift+additive headings carry continuous one-based indices', async () => {
    const content = await renderFourKindReport()
    const headings = content.split('\n').filter((l) => l.startsWith('### '))
    const indexed = headings.filter((h) => DIGEST_HEADING_RE.test(h))
    // Exactly the two apply-eligible findings get an index, in order.
    expect(indexed).toHaveLength(2)
    expect(indexed[0]).toMatch(/^### \[1\] \[H\] drift: docs\/arch\.md:3-3/)
    expect(indexed[1]).toMatch(/^### \[2\] \[M\] additive: docs\/arch\.md/)
  })

  it('manual-review headings exist but never match the SKILL digest regex', async () => {
    const content = await renderFourKindReport()
    const headings = content.split('\n').filter((l) => l.startsWith('### '))
    const narrative = headings.find((h) => h.includes('narrative-only drift'))
    const clarification = headings.find((h) => h.startsWith('### Clarification:'))
    // Both manual-review headings are present in the report…
    expect(narrative).toBe('### [H] narrative-only drift: docs/arch.md:4-4')
    expect(clarification).toBe('### Clarification: docs/arch.md — Authentication')
    // …and neither is counted by the apply-eligible digest regex.
    expect(DIGEST_HEADING_RE.test(narrative!)).toBe(false)
    expect(DIGEST_HEADING_RE.test(clarification!)).toBe(false)
  })

  it('apply-eligible and manual-review entries live under distinct section headings', async () => {
    const content = await renderFourKindReport()
    const applyIdx = content.indexOf('## Apply-eligible findings')
    const manualIdx = content.indexOf('## Manual review required')
    expect(applyIdx).toBeGreaterThan(-1)
    expect(manualIdx).toBeGreaterThan(applyIdx)
    // The two indexed findings sit in the apply-eligible section (before the
    // Manual review heading); the clarification sits after it.
    expect(content.indexOf('### [1] [H] drift:')).toBeGreaterThan(applyIdx)
    expect(content.indexOf('### [1] [H] drift:')).toBeLessThan(manualIdx)
    expect(content.indexOf('### Clarification:')).toBeGreaterThan(manualIdx)
  })

  it('produces a byte-identical report on a re-run with the same four-kind input (NFR46)', async () => {
    const first = await renderFourKindReport()
    const second = await renderFourKindReport()
    expect(second).toBe(first)
  })
})

// ---------------------------------------------------------------------------
// AC1 — Path resolution
// ---------------------------------------------------------------------------

describe('runLocalFinalize — findings path resolution (AC1)', () => {
  let temp: TempRoot

  beforeEach(async () => {
    temp = await makeTempRoot()
    await writeAnalysisInput(temp.root, [{ path: 'docs/arch.md', content: DOC_CONTENT }])
  })

  afterEach(async () => {
    await temp.cleanup()
  })

  it('accepts a relative findings path resolved against repoRoot', async () => {
    await writeFindings(temp.root, {
      contradictions: [],
      additions: [],
      rawConfidence: 0.9,
    })
    const code = await runLocalFinalize({
      findingsPath: '.delfini-trace/findings.json', // relative
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: makeCapture().stream,
    })
    expect(code).toBe(0)
  })

  it('exits 3 when the findings file does not exist', async () => {
    const stderr = makeCapture()
    const code = await runLocalFinalize({
      findingsPath: path.join(temp.root, '.delfini-trace', 'findings.json'), // missing
      repoRoot: temp.root,
      stdout: makeCapture().stream,
      stderr: stderr.stream,
    })
    expect(code).toBe(3)
    const payload = JSON.parse(stderr.text()) as { error: string }
    expect(payload.error).toBe('schema_validation')
  })
})
