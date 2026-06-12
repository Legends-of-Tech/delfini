import { isFileInDocScope } from '@delfini/drift-engine'

export interface SmartSkipOptions {
  // ADR-2026-06-01 / Story P2.6 — multi-path doc-scope. Routes through the
  // shared `isFileInDocScope` from `@delfini/drift-engine` so smart-skip's
  // FR57(b) "doc-only-in-scope" leg and the Lite doc reader's git-trees
  // matcher use ONE predicate against ONE picomatch@4 dialect — a file the
  // reader ingests and a file smart-skip treats as in-scope can never silently
  // diverge (the 23-row dialect-parity fixture in
  // `packages/drift-engine/__tests__/fixtures/doc-scope-dialect.json` gates
  // this).
  docScope: string[]
  skipTestFiles?: boolean
}

export interface SmartSkipResult {
  shouldSkip: boolean
  reason: string
}

type Category = 'dependency' | 'ci' | 'generated' | 'node_modules' | 'test'

const categoryLabels: Record<Category, string> = {
  dependency: 'dependency update',
  ci: 'CI config change',
  generated: 'generated file',
  node_modules: 'node_modules change',
  test: 'test file change',
}

const DEPENDENCY_BASENAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
])

function basename(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] ?? filePath
}

function classifyFile(filePath: string, skipTestFiles: boolean): Category | null {
  if (filePath.includes('node_modules/')) {
    return 'node_modules'
  }

  if (DEPENDENCY_BASENAMES.has(basename(filePath))) {
    return 'dependency'
  }

  if (filePath.startsWith('.github/') && (filePath.endsWith('.yml') || filePath.endsWith('.yaml'))) {
    return 'ci'
  }

  if (filePath.endsWith('.generated.ts') || filePath.endsWith('.gen.ts')) {
    return 'generated'
  }

  if (
    skipTestFiles &&
    (filePath.endsWith('.test.ts') || filePath.endsWith('.test.tsx') || filePath.endsWith('.spec.ts'))
  ) {
    return 'test'
  }

  return null
}

function formatReason(counts: Map<Category, number>): string {
  const parts: string[] = []

  for (const [category, count] of counts) {
    const label = categoryLabels[category]
    parts.push(`${count} ${label}${count > 1 ? 's' : ''}`)
  }

  return parts.join(', ')
}

export function classifyPr(changedFiles: string[], options: SmartSkipOptions): SmartSkipResult {
  if (changedFiles.length === 0) {
    return { shouldSkip: true, reason: 'No changed files detected' }
  }

  const skipTestFiles = options.skipTestFiles ?? false
  const counts = new Map<Category, number>()
  let docInScopeCount = 0

  for (const filePath of changedFiles) {
    // Story P2.6 — shared in-scope predicate (picomatch@4 dialect via
    // `@delfini/drift-engine`). Replaces the legacy private `isDocFile`
    // prefix check so smart-skip and the Lite reader's git-trees matcher
    // can never silently disagree on the same scope.
    if (isFileInDocScope(filePath, options.docScope)) {
      docInScopeCount += 1
      continue
    }

    const category = classifyFile(filePath, skipTestFiles)
    if (category === null) {
      return { shouldSkip: false, reason: 'Business-logic changes detected' }
    }

    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  let structurallyUninterestingCount = 0
  for (const count of counts.values()) {
    structurallyUninterestingCount += count
  }

  // FR57(b) v6.1 — every changed file is a doc-in-scope; smart-skip fires.
  if (docInScopeCount > 0 && structurallyUninterestingCount === 0) {
    const noun = docInScopeCount === 1 ? 'change' : 'changes'
    return { shouldSkip: true, reason: `${docInScopeCount} doc-only ${noun} in doc scope` }
  }

  // FR57(a) — pure structurally-uninteresting changes; existing skip path.
  if (docInScopeCount === 0) {
    return { shouldSkip: true, reason: formatReason(counts) }
  }

  // Mixed doc-in-scope + structurally-uninteresting. The two skip checks
  // are independent (FR57 v6.1) — a mixed PR satisfies neither, so analysis
  // runs.
  return { shouldSkip: false, reason: 'Mixed doc and non-doc changes detected' }
}
