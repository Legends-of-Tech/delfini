import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const TRACE_DIR_NAME = '.delfini-trace'
const GITIGNORE_LINE = '.delfini-trace/'

export function ensureTraceDir(repoRoot: string): string {
  const tracePath = join(repoRoot, TRACE_DIR_NAME)
  if (existsSync(tracePath)) {
    const stat = statSync(tracePath)
    if (!stat.isDirectory()) {
      throw new Error(
        `ensureTraceDir: ${tracePath} exists but is not a directory. ` +
          `Remove or rename it so the CLI can create the trace directory.`,
      )
    }
    return tracePath
  }
  mkdirSync(tracePath, { recursive: true })
  return tracePath
}

export function appendToGitignore(repoRoot: string): { changed: boolean } {
  const gitignorePath = join(repoRoot, '.gitignore')
  const existed = existsSync(gitignorePath)
  const existingContent = existed ? readFileSync(gitignorePath, 'utf8') : ''

  const lines = existingContent.split(/\r?\n/)
  for (const line of lines) {
    if (line.trim() === GITIGNORE_LINE) {
      return { changed: false }
    }
  }

  const useCRLF = existingContent.includes('\r\n')
  const newline = useCRLF ? '\r\n' : '\n'

  if (!existed || existingContent.length === 0) {
    writeFileSync(gitignorePath, `${GITIGNORE_LINE}${newline}`)
    return { changed: true }
  }

  // `\r\n` also ends with `\n`, so checking the latter suffices.
  const endsWithNewline = existingContent.endsWith('\n')
  const prefix = endsWithNewline ? '' : newline
  appendFileSync(gitignorePath, `${prefix}${GITIGNORE_LINE}${newline}`)
  return { changed: true }
}

export function writeTraceFile(
  repoRoot: string,
  filename: string,
  content: string,
): string {
  validateBasename(filename)
  const traceDir = ensureTraceDir(repoRoot)
  const target = join(traceDir, filename)
  writeFileSync(target, content)
  return target
}

export function writeRetryAttemptFile(
  repoRoot: string,
  attemptNumber: 1 | 2,
  content: string,
): string {
  if (attemptNumber !== 1 && attemptNumber !== 2) {
    throw new Error(
      `writeRetryAttemptFile: attemptNumber must be 1 or 2, got ${String(attemptNumber)}`,
    )
  }
  return writeTraceFile(repoRoot, `findings-attempt-${attemptNumber}.json`, content)
}

function validateBasename(filename: string): void {
  if (filename.length === 0) {
    throw new Error('writeTraceFile: filename must not be empty')
  }
  if (filename === '.' || filename === '..') {
    throw new Error(`writeTraceFile: filename must not be "${filename}"`)
  }
  if (filename.includes('/') || filename.includes('\\')) {
    throw new Error(
      `writeTraceFile: filename must be a basename without path separators, got "${filename}"`,
    )
  }
}
