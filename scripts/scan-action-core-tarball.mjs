// Story P3.9.2a AC7 — @delfini/action-core tarball scan (release gate).
//
// Usage: node scripts/scan-action-core-tarball.mjs
//   (requires packages/action-core to be built — `pnpm --filter
//    @delfini/action-core build` — since the tarball packs dist/)
//
// The published @delfini/action-core tarball is the SECOND public artifact
// (outside the ncc Lite-dist scan) and needs its own gate. This script:
//   1. `pnpm pack`s packages/action-core into a temp dir (pnpm rewrites the
//      workspace: protocol to real versions, same as publish);
//   2. reads the tarball in-process (gunzip + minimal tar walk — no external
//      `tar` binary; GNU tar mis-parses Windows drive-letter paths) and scans
//      every packed .js AND .d.ts file (comment-stripped, same routine as the
//      Lite-dist scan) for the Full-only runtime markers;
//   3. verifies the hoisted PipelineDeps/PipelineInputs declarations carry no
//      platform-contract leak — the pipeline-inputs .d.ts must not contain
//      intake-types shapes or FR88d/FR88g wire fields.
//
// Exit 0 on pass; non-zero with a diagnostic on any failure.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { exit } from 'node:process'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { stripJsComments } from './strip-js-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const pkgDir = join(repoRoot, 'packages', 'action-core')

const RUNTIME_MARKERS = [
  'X-Delfini-Signature',
  'routeStream',
  'callIntakeSafely',
  'buildIntakeInput',
  '/api/action-intake',
  '/api/action-config',
]

// FR88d/FR88g wire-contract fields — none may appear in the hoisted
// pipeline-inputs declarations (AC7: "no intake-types shapes, no FR88d/FR88g
// wire fields in the public .d.ts").
const WIRE_FIELD_MARKERS = [
  'pending_review_exists',
  'review_url',
  'section_anchor',
  'target_doc_path',
  'IntakeFinding',
  'IntakeInput',
  'IntakeResponse',
]

// Minimal USTAR walk: 512-byte header blocks; name at 0..100 (+ optional
// 155-byte prefix at 345), size as octal at 124..136; content padded to the
// next 512-byte boundary. Sufficient for npm/pnpm-produced tarballs.
function* tarEntries(buffer) {
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    const typeflag = String.fromCharCode(header[156])
    const fullName = prefix ? `${prefix}/${name}` : name
    const content = buffer.subarray(offset + 512, offset + 512 + size)
    if (typeflag === '0' || typeflag === '\0') {
      yield { name: fullName, content }
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'delfini-action-core-scan-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', tmp], {
    cwd: pkgDir,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  const tarballName = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!tarballName) {
    console.error('FAIL: pnpm pack produced no tarball')
    exit(2)
  }
  const tarBuffer = gunzipSync(readFileSync(join(tmp, tarballName)))

  const scanned = []
  const failures = []
  for (const entry of tarEntries(tarBuffer)) {
    const name = entry.name // e.g. package/dist/index.js
    if (!name.endsWith('.js') && !name.endsWith('.d.ts')) continue
    scanned.push(name)
    const stripped = stripJsComments(entry.content.toString('utf8'))
    for (const marker of RUNTIME_MARKERS) {
      if (stripped.includes(marker)) {
        failures.push(`${name}: Full-only runtime marker '${marker}'`)
      }
    }
    if (name.includes('pipeline-inputs.d.ts')) {
      for (const marker of WIRE_FIELD_MARKERS) {
        if (stripped.includes(marker)) {
          failures.push(
            `${name}: hoisted PipelineInputs/PipelineDeps declarations leak the ` +
              `platform-contract field/shape '${marker}'`,
          )
        }
      }
    }
  }

  if (scanned.length === 0) {
    console.error(
      'FAIL: tarball contains no .js/.d.ts files — was packages/action-core built ' +
        'before packing? (pnpm --filter @delfini/action-core build)',
    )
    exit(2)
  }
  if (!scanned.some((f) => f.includes('pipeline-inputs.d.ts'))) {
    console.error('FAIL: pipeline-inputs.d.ts missing from the tarball — dist is incomplete.')
    exit(2)
  }
  if (!scanned.some((f) => f.includes('orchestrator'))) {
    console.error('FAIL: the single-call orchestrator is missing from the tarball.')
    exit(2)
  }

  if (failures.length > 0) {
    console.error('FAIL: @delfini/action-core tarball scan found Full-only leakage:')
    for (const f of failures) console.error(`  - ${f}`)
    exit(1)
  }

  console.log(
    `PASS: @delfini/action-core tarball (${tarballName}) is clean — scanned ${scanned.length} ` +
      `packed .js/.d.ts files, 0 Full-only runtime markers, hoisted pipeline-inputs ` +
      'declarations carry no platform-contract fields.',
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
