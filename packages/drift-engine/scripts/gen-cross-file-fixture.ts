// THROWAWAY GENERATOR — emits the committed cross-file stress fixture under
// __tests__/fixtures/cross-file/case-01-session-ttl/. Run once to (re)generate;
// the STATIC json/README it writes are what tests + the spike consume (so they
// never depend on this script at runtime). Excluded from the published tarball
// (package.json `"files"` = dist/src.prompt.md/README), same as measure-tokens.ts.
//
//   node --import tsx packages/drift-engine/scripts/gen-cross-file-fixture.ts
//
// WHY a generator and not hand-written JSON: the fixture is a realistic
// multi-file PR whose `expected.json` must carry the EXACT `startLineIndex` of
// the anchor heading (the retention gate matches on it). Computing that from the
// assembled doc content here removes the #1 hand-authoring error. Readable
// template strings beat a 30KB escaped JSON blob for review + future edits.

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../__tests__/fixtures/cross-file/case-01-session-ttl')

// -- Diff construction helpers -----------------------------------------------
// Hunk line-number headers are plausible but not byte-exact: the relevance
// scorer keys on file PATHS + IDENTIFIERS, not on @@ math, so approximate ranges
// are fine for this fixture's purpose (routing + chunking, not patch application).

function fileDiff(path: string, hunks: string[][], startLine = 10): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ].join('\n')
  const body = hunks
    .map((lines, i) => {
      const at = startLine + i * 20
      const span = lines.length
      return `@@ -${at},${span} +${at},${span} @@\n${lines.join('\n')}`
    })
    .join('\n')
  return `${header}\n${body}`
}

// -- The cross-file finding (anchor: ## Session Tokens) ----------------------
// issuer.ts now mints a 7200s TTL; validator.ts still rejects anything over
// 3600s. Neither hunk alone contradicts the doc — the doc says the two MUST
// agree at 3600, and the drift is only visible when BOTH hunks are seen with
// the ## Session Tokens section. This is the finding chunking must not split.

const issuer = fileDiff('src/auth/issuer.ts', [
  [
    ' export function issueSessionToken(userId: string): SessionToken {',
    '-  const ttlSeconds = 3600',
    '+  const ttlSeconds = 7200',
    '   const expiresAt = now() + ttlSeconds * 1000',
    '   return new SessionToken({ userId, expiresAt, ttlSeconds })',
    ' }',
  ],
])

const validator = fileDiff('src/auth/validator.ts', [
  [
    ' export function validateSessionToken(token: SessionToken): boolean {',
    '   const ageSeconds = (now() - token.issuedAt) / 1000',
    '-  // reject tokens older than the documented 3600s ceiling',
    '+  // reject tokens older than the 3600s ceiling (see auth-architecture.md)',
    '   return ageSeconds <= 3600 && !isRevoked(token.id)',
    ' }',
  ],
])

// -- Spread findings (different anchor sections) -----------------------------

const rotation = fileDiff('src/auth/rotation.ts', [
  [
    ' export function rotateToken(token: SessionToken): SessionToken {',
    '-  const rotationIntervalSeconds = 900',
    '+  const rotationIntervalSeconds = 1800',
    '   if (tokenAge(token) < rotationIntervalSeconds) return token',
    '   return reissue(token)',
    ' }',
  ],
])

const rateLimit = fileDiff('src/auth/rate-limit.ts', [
  [
    ' export function checkRateLimit(userId: string): boolean {',
    '-  const maxRequestsPerMinute = 100',
    '+  const maxRequestsPerMinute = 200',
    '   return currentRate(userId) <= maxRequestsPerMinute',
    ' }',
  ],
])

// -- Concentrated cluster (anchor: ## Session Tokens) ------------------------
// A repo-wide rename SessionToken -> SessionTicket. Every hunk references the
// SessionToken/SessionTicket identifiers named in the ## Session Tokens
// section, so ALL of these route to that one section — the realistic "big
// refactor of one heavily-documented subsystem" that concentrates load on a
// single atomic section and drives the over-budget wall.

const RENAME_FILES = [
  'src/auth/store.ts',
  'src/auth/middleware.ts',
  'src/auth/context.ts',
  'src/auth/guards.ts',
  'src/auth/refresh.ts',
  'src/auth/introspect.ts',
  'src/auth/session-cache.ts',
  'src/auth/types.ts',
  'src/auth/serialize.ts',
  'src/auth/cookie.ts',
]

const renames = RENAME_FILES.map((p) =>
  fileDiff(p, [
    [
      `-import { SessionToken } from './types'`,
      `+import { SessionTicket } from './types'`,
      ' ',
      `-export function load(id: string): SessionToken | null {`,
      `+export function load(id: string): SessionTicket | null {`,
      `-  return cache.get(id) as SessionToken | null`,
      `+  return cache.get(id) as SessionTicket | null`,
      ' }',
    ],
  ]),
)

const diff = [issuer, validator, rotation, rateLimit, ...renames].join('\n') + '\n'

// -- Docs (source of truth) --------------------------------------------------

const authArchitecture = `# Authentication Architecture

This document is the source of truth for the session-auth subsystem. It is
reviewed on every change to \`src/auth/\`.

## Session Tokens

A \`SessionToken\` is the credential minted on login. The \`issueSessionToken\`
function in \`src/auth/issuer.ts\` mints tokens with a fixed **3600-second TTL**.
The \`validateSessionToken\` function in \`src/auth/validator.ts\` enforces the
same ceiling: a token older than 3600 seconds is rejected.

These two functions MUST agree on the 3600-second TTL. If the issuer mints a
longer-lived token than the validator accepts, sessions appear valid to the
client but are rejected mid-flight — an inconsistency that only shows up when
both \`src/auth/issuer.ts\` and \`src/auth/validator.ts\` are read together.

## Token Rotation

\`rotateToken\` in \`src/auth/rotation.ts\` reissues a token once it crosses the
rotation interval of **900 seconds**. Rotation is silent to the client.

## Rate Limiting

\`checkRateLimit\` in \`src/auth/rate-limit.ts\` caps each user at **100 requests
per minute**. Exceeding the cap returns HTTP 429.

## Revocation

\`revokeToken\` in \`src/auth/revocation.ts\` adds a token id to the revocation
set. \`validateSessionToken\` consults this set on every check.
`

const apiReference = `# API Reference

## POST /sessions

Creates a session and returns a \`SessionToken\`. The token TTL is governed by
the issuer (see auth-architecture.md).

## DELETE /sessions/:id

Revokes the session id. Idempotent.

## GET /sessions/:id

Returns session metadata for an active token.
`

const dataModel = `# Data Model

## SessionRecord

Persisted row backing each \`SessionToken\`. Columns: id, userId, issuedAt,
expiresAt.

## AuditLog

Append-only log of issue / validate / revoke events.
`

// -- Compute the anchor section's startLineIndex (the retention gate keys on it) --

function startLineIndexOf(content: string, heading: string): number {
  const idx = content.split('\n').findIndex((l) => l.trim() === heading)
  if (idx === -1) throw new Error(`heading not found: ${heading}`)
  return idx
}

const ANCHOR_HEADING = '## Session Tokens'
const anchorStartLine = startLineIndexOf(authArchitecture, ANCHOR_HEADING)

const input = {
  diff,
  docs: [
    { path: 'docs/auth-architecture.md', content: authArchitecture, frontMatterLineCount: 0 },
    { path: 'docs/api-reference.md', content: apiReference, frontMatterLineCount: 0 },
    { path: 'docs/data-model.md', content: dataModel, frontMatterLineCount: 0 },
  ],
  prMetadata: {
    owner: 'delfini-fixtures',
    repo: 'cross-file',
    prNumber: 1,
    headSha: '0000000000000000000000000000000000000001',
    baseSha: '0000000000000000000000000000000000000002',
    title: 'Bump session TTL to 7200s and rename SessionToken -> SessionTicket',
  },
}

const expected = {
  // Base shape (compatible with the token-efficiency retention-gate tooling).
  groundTruthDocPath: 'docs/auth-architecture.md',
  groundTruthSection: { startLineIndex: anchorStartLine, headingText: ANCHOR_HEADING },

  // Extended cross-file labeling — what the multi-prompt design must preserve.
  crossFileFinding: {
    anchorDocPath: 'docs/auth-architecture.md',
    anchorSection: ANCHOR_HEADING,
    contributingFiles: ['src/auth/issuer.ts', 'src/auth/validator.ts'],
    description:
      'issuer.ts mints a 7200s TTL while validator.ts still rejects >3600s; the doc requires both to agree at 3600s. The contradiction is only detectable when both hunks are co-located with the ## Session Tokens section.',
  },

  // The concentrated cluster that drives the over-budget-single-section wall:
  // all rename hunks route to the SAME anchor section.
  concentratedCluster: {
    anchorSection: ANCHOR_HEADING,
    rename: 'SessionToken -> SessionTicket',
    fileCount: RENAME_FILES.length,
    files: RENAME_FILES,
  },

  // Spread findings — distinct anchor sections, should chunk cleanly.
  spreadFindings: [
    { anchorSection: '## Token Rotation', files: ['src/auth/rotation.ts'], drift: '900s -> 1800s' },
    { anchorSection: '## Rate Limiting', files: ['src/auth/rate-limit.ts'], drift: '100rpm -> 200rpm' },
  ],
}

const readme = `# cross-file / case-01-session-ttl

A realistic session-auth refactor PR built to validate the **doc-section-sharded
multi-prompt design** (\`docs/ideas/multi-prompt-diff-analysis.md\`). Unlike the
\`token-efficiency\` fixtures (one finding, one file ↔ one section), this fixture
carries all three structures the chunking design must handle:

1. **A genuine cross-file finding** (the load-bearing case for "preserve every
   cross-file finding"). \`src/auth/issuer.ts\` bumps the session TTL to 7200s
   while \`src/auth/validator.ts\` still rejects tokens older than 3600s. The
   \`## Session Tokens\` section of \`docs/auth-architecture.md\` states the two
   MUST agree at 3600s. **No single hunk contradicts the doc** — the drift is
   only visible when both hunks are read together with that section. A chunking
   scheme that splits the two files into different prompts LOSES this finding.

2. **A concentrated single-section cluster** (the over-budget wall). A repo-wide
   \`SessionToken\` → \`SessionTicket\` rename across ${RENAME_FILES.length} files,
   every hunk routing to the SAME \`## Session Tokens\` section. Because a section
   is the atomic unit, its hunks cannot spread across chunks — at a tight budget
   this section + its hunks overflow a single prompt, the exact case where
   "preserve every cross-file finding" becomes impossible and the design must
   sub-split + surface loudly.

3. **Spread findings** (clean fan-out). \`rotation.ts\` (900→1800s) and
   \`rate-limit.ts\` (100→200rpm) drift against DIFFERENT sections (\`## Token
   Rotation\`, \`## Rate Limiting\`), so they distribute across chunks without
   contention.

\`expected.json\` labels all of the above. The base \`groundTruthDocPath\` +
\`groundTruthSection\` keys match the \`token-efficiency\` retention-gate shape;
the \`crossFileFinding\` / \`concentratedCluster\` / \`spreadFindings\` keys are the
extended labeling this design needs.

Regenerate with:
\`node --import tsx packages/drift-engine/scripts/gen-cross-file-fixture.ts\`
`

mkdirSync(OUT, { recursive: true })
writeFileSync(resolve(OUT, 'analysis-input.json'), JSON.stringify(input, null, 2) + '\n')
writeFileSync(resolve(OUT, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
writeFileSync(resolve(OUT, 'README.md'), readme)

process.stdout.write(
  `wrote cross-file/case-01-session-ttl: anchor '${ANCHOR_HEADING}' @ line ${anchorStartLine}, ` +
    `${input.docs.length} docs, ${RENAME_FILES.length + 4} changed files\n`,
)
