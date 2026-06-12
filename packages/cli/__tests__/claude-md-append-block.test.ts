import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const TEMPLATE_PATH = resolve(HERE, '..', 'templates', 'claude-md-append-block.txt')

describe('claude-md-append-block template — auto-invoke instruction contract', () => {
  let content: string

  beforeAll(() => {
    content = readFileSync(TEMPLATE_PATH, 'utf8')
  })

  it('exists and is non-empty at packages/cli/templates/claude-md-append-block.txt', () => {
    expect(content.length).toBeGreaterThan(0)
  })

  // --- PRD v6.5.2: ship-it is not a Delfini trigger -------------------------

  it('contains no ship-it reference anywhere (PRD v6.5.2 — FR149 deleted)', () => {
    expect(content).not.toMatch(/ship-it/i)
  })

  it('uses no "shipping pass" / "ready to ship" framing (create-PR is the only trigger)', () => {
    expect(content).not.toMatch(/shipping pass/i)
    expect(content).not.toMatch(/ready to ship/i)
  })

  // --- Trigger framing: create-PR intent ------------------------------------

  it('names create-PR intent as the trigger', () => {
    expect(content).toMatch(/create-PR intent/)
    expect(content).toMatch(/open a PR/i)
  })

  it('forbids per-commit / mid-commit invocation (AC2)', () => {
    expect(content).toMatch(/every commit/i)
    expect(content).toMatch(/per-commit/i)
  })

  // --- Diff-source: create-PR auto analyses `both` silently (FR142/FR143) ----

  it('states a create-PR auto-invocation analyses `both` silently (AC3)', () => {
    // Co-located on one line so the assertion guards the actual association —
    // "create-PR auto-invocation … `both` … silent" — not three independent
    // whole-document token matches.
    expect(content).toMatch(/create-PR auto-invocation[^\n]*`both`[^\n]*silent/i)
  })

  it('mentions there is no diff-source prompt on the auto path', () => {
    // Must guard the actual "no prompt" clause — not just the word "silently",
    // which appears elsewhere and would make this assertion vacuous.
    expect(content).toMatch(/no local-vs-both prompt/i)
  })

  // --- Git-hook disclaimer (NG5) --------------------------------------------

  it('disclaims git-hook integration and references NG5 (AC4)', () => {
    expect(content).toMatch(/NG5/)
    expect(content).toMatch(/git[ -]hook/i)
  })

  it('clarifies "on PR creation" is intent recognition, not a git/GitHub event hook', () => {
    expect(content).toMatch(/intent recognition/i)
    expect(content).toMatch(/never a git (or|\/) ?github event hook/i)
  })

  // --- Marker-less invariant (AC5) ------------------------------------------

  it('contains NO marker token — install.ts wraps the markers at write time (AC5)', () => {
    // The body must ship marker-less. install.ts adds the
    // `<!-- delfini:auto-invoke-block-v1 -->` pair at write time; a marker in
    // the body would double-wrap the installed block.
    expect(content).not.toMatch(/delfini:auto-invoke-block/)
  })

  // --- Plain markdown prose, not JSON/YAML (AC6) ----------------------------

  it('is plain markdown prose with headings (not JSON/YAML)', () => {
    expect(content).toMatch(/^## /m)
    expect(content).toMatch(/^### /m)
    expect(() => JSON.parse(content)).toThrow()
  })

  it('points the host agent at the SKILL.md protocol (do not improvise)', () => {
    expect(content).toMatch(/\.claude\/skills\/delfini\/SKILL\.md/)
    expect(content).toMatch(/do not improvise/i)
  })
})
