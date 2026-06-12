import type { Addition, AnalysisResult, Contradiction, DocFile } from '@delfini/drift-engine'

// Story P2.3 — Lite-mode rich PR-comment formatter (FR136).
//
// Lite mode runs the Action standalone with no Delfini platform, so the
// structured per-finding detail must live in the PR comment itself — there is
// no hosted review surface to link out to. This module is the Lite-mode
// counterpart to the Full-mode thin-link `comment-formatter.ts`; the two are
// deliberately separate files so per-mode test fixtures stay clean.
//
// `formatLiteComment` is a pure, deterministic `LiteCommentInput -> string`
// function: no I/O, no Date.now(), no env, no randomness. Determinism is what
// lets P2.2's in-place comment upsert leave an unchanged re-run untouched. The
// hidden idempotency marker is appended by P2.2's pipeline, NOT here.

export type LiteCommentInput =
  | { kind: 'findings'; result: AnalysisResult; docScope: string }
  | { kind: 'pass'; docs: DocFile[]; docScope: string }

// Push-only footer — Lite workflows may not wire the `issue_comment` trigger,
// so there is no `/delfini` re-run hint and no `[View on Delfini →]` link.
const RERUN_FOOTER = '> Re-run this check by pushing a new commit to this branch.'

const NARRATIVE_ONLY_NOTE =
  '_No concrete replacement available — review and update this section manually._'

export function formatLiteComment(input: LiteCommentInput): string {
  switch (input.kind) {
    case 'findings':
      return renderFindings(input.result, input.docScope)
    case 'pass':
      return renderPass(input.docs, input.docScope)
  }
}

function renderFindings(result: AnalysisResult, docScope: string): string {
  const { contradictions } = result
  // `additions` is optional on AnalysisResult — coerce undefined to [] exactly
  // as pipeline.ts does. An additive-only PR must not produce a blank comment.
  const additions = result.additions ?? []
  const count = contradictions.length + additions.length
  const noun = count === 1 ? 'finding' : 'findings'

  const parts: string[] = [
    '## Delfini — Drift Detected',
    '',
    `**${count} ${noun}** found between this PR and your source-of-truth documents in \`${docScope}\`.`,
    '',
    '---',
    '',
  ]

  // Ordinals are continuous across the combined sequence: contradictions take
  // 1..C, additions take C+1..C+A — mirrors pipeline.ts's wire ordering.
  let index = 1
  for (const contradiction of contradictions) {
    parts.push(renderContradictionCard(contradiction, index), '', '---', '')
    index += 1
  }
  for (const addition of additions) {
    parts.push(renderAdditionCard(addition, index), '', '---', '')
    index += 1
  }

  parts.push(RERUN_FOOTER)

  return parts.join('\n')
}

function renderContradictionCard(c: Contradiction, index: number): string {
  const lines: string[] = [
    `### ${index}. \`${c.targetDocPath}\` — ${c.targetSection}`,
    '',
    `**Severity:** ${c.severity} · ${renderLineRange(c.targetLineStart, c.targetLineEnd)}`,
    '',
    `**What changed:** ${c.whatChanged}`,
    '',
    `**What the docs say:** ${c.whatContradicts}`,
  ]

  if (c.proposedReplacement !== null) {
    // Unified diff fence — `-` for the doc text being replaced, `+` for the
    // proposed replacement. Mirrors the CLI's `report.md` shape so a developer
    // sees the same format whether `/delfini` ran locally or in CI. NEVER a
    // ```suggestion tag (FR136); ```diff is a plain language hint, not a
    // GitHub-suggestion marker.
    lines.push('', '**Proposed change:**', '', '```diff')
    for (const line of c.quotedDocText.replace(/\r\n/g, '\n').split('\n')) {
      lines.push(`- ${line}`)
    }
    for (const line of c.proposedReplacement.replace(/\r\n/g, '\n').split('\n')) {
      lines.push(`+ ${line}`)
    }
    lines.push('```')
  } else {
    lines.push('', NARRATIVE_ONLY_NOTE)
  }

  return lines.join('\n')
}

function renderAdditionCard(a: Addition, index: number): string {
  const lines: string[] = [
    `### ${index}. \`${a.targetDocPath}\` — new content for "${a.anchorSection}"`,
    '',
    `**Severity:** ${a.severity} · **Insert ${a.insertionMode} line ${a.anchorLine}**`,
    '',
    `**What changed:** ${a.whatChanged}`,
    '',
    `**Why add this:** ${a.rationaleForAddition}`,
    '',
    // Unified diff fence with `+` lines only — additive findings have no
    // doc-side counterpart to replace. NEVER a ```suggestion tag (FR136).
    `**Proposed addition (insert ${a.insertionMode} line ${a.anchorLine}):**`,
    '',
    '```diff',
  ]
  for (const line of a.proposedContent.replace(/\r\n/g, '\n').split('\n')) {
    lines.push(`+ ${line}`)
  }
  lines.push('```')
  return lines.join('\n')
}

// Single-line findings render `**Line:** N`; multi-line findings render
// `**Lines:** N–M` joined with an en-dash (U+2013). A single-line finding must
// NOT render `87–87`.
function renderLineRange(start: number, end: number): string {
  if (start === end) {
    return `**Line:** ${start}`
  }
  return `**Lines:** ${start}–${end}`
}

function renderPass(docs: DocFile[], docScope: string): string {
  const count = docs.length
  const noun = count === 1 ? 'document' : 'documents'

  return [
    '## Delfini — PASS',
    '',
    `No drift detected between this PR and your source-of-truth documents in \`${docScope}\`.`,
    '',
    `${count} ${noun} checked.`,
  ].join('\n')
}
