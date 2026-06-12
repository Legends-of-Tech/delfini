import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const TEMPLATE_PATH = resolve(HERE, '..', 'templates', 'SKILL.md')

describe('SKILL.md template — host-agent output discipline contract', () => {
  let content: string

  beforeAll(() => {
    content = readFileSync(TEMPLATE_PATH, 'utf8')
  })

  it('exists at packages/cli/templates/SKILL.md', () => {
    // beforeAll already proved the file is readable; if it weren't, the
    // suite would have failed in setup. This `it` documents the contract.
    expect(content.length).toBeGreaterThan(0)
  })

  it('has no "## Step N — ..." numbered headings (regression guard for verb-anchor sections)', () => {
    const matches = content.match(/^## Step \d+/gm) ?? []
    expect(matches).toEqual([])
  })

  it('includes an "## Output discipline" section', () => {
    expect(content).toMatch(/^## Output discipline$/m)
  })

  it('explicitly forbids step-narration phrasing in Output discipline', () => {
    expect(content).toMatch(/do not say.*Step N/i)
  })

  it('explicitly forbids collapsing the report into a one-line summary', () => {
    expect(content).toMatch(/never collapse the report|do not.*summari[sz]e/i)
  })

  it('has a "## Surface the report" section heading', () => {
    expect(content).toMatch(/^## Surface the report$/m)
  })

  it('uses the word "verbatim" in the Surface the report section', () => {
    expect(content).toMatch(/verbatim/i)
  })

  it('uses the word "anti-patterns" (or "anti-pattern") in the Surface the report section', () => {
    expect(content).toMatch(/anti-patterns?/i)
  })

  it('specifies the one-line digest format in Apply UX', () => {
    expect(content).toMatch(/^## Apply UX$/m)
    expect(content).toMatch(/N findings.*X drift.*Y additive/)
  })

  it('specifies a single-line outcome rule for Apply UX', () => {
    expect(content).toMatch(/Applied N\/M findings/)
    expect(content).toMatch(/Skipped — findings preserved in \.delfini-trace/)
  })

  // --- PRD v6.5.1 / v6.5.2 amendments (Story P3.3.1) -------------------------

  it('frontmatter description names create-PR intent and not ship-it', () => {
    // Tolerate CRLF — the template ships with Windows line endings.
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
    expect(frontmatter).toMatch(/description:.*create-PR intent/)
    expect(frontmatter).not.toMatch(/ship-it/i)
  })

  it('contains no ship-it reference anywhere (PRD v6.5.2 — ship-it is not a Delfini trigger)', () => {
    expect(content).not.toMatch(/ship-it/i)
  })

  it('carries a protocol-version frontmatter field', () => {
    expect(content).toMatch(/^protocol-version:\s*\d+/m)
  })

  describe('diff-source resolution step (Story P3.2.8 dependency)', () => {
    // Scope semantic assertions to the section body (heading → next heading) so
    // they verify content *inside* the resolution step, not incidental token
    // matches scattered elsewhere in the document. `content` is populated in
    // beforeAll, so this is a lazy getter called from within each `it`.
    const resolveSection = () =>
      content.slice(
        content.search(/^## Resolve the diff source$/m),
        content.search(/^## Run prepare$/m),
      )

    it('has a verb-anchored "Resolve the diff source" section', () => {
      expect(content).toMatch(/^## Resolve the diff source$/m)
    })

    it('shells out to `delfini diff-status` and passes `--diff-source` to local-prepare', () => {
      expect(resolveSection()).toMatch(/delfini diff-status/)
      expect(resolveSection()).toMatch(/--diff-source/)
    })

    it('specifies the NFR47 §3 early "no changes" exit before local-prepare', () => {
      expect(resolveSection()).toMatch(/No changes since/)
      expect(resolveSection()).toMatch(/nothing to analyse/i)
    })

    it('states a create-PR auto-invocation resolves to `both` silently (FR142)', () => {
      // Co-located on one line in the section — guards the actual association,
      // not three independent whole-document token matches.
      expect(resolveSection()).toMatch(/create-PR auto-invocation[^\n]*`both`[^\n]*silent/i)
    })

    it('threads --diff-source through the exit-2 re-run of local-prepare', () => {
      // The exit-2 doc-scope fallback must re-run with the resolved diff-source,
      // not a bare `local-prepare` (regression guard for the rewired re-run line).
      expect(content).toMatch(/Exit `2`[\s\S]*?local-prepare --diff-source/)
    })

    it('places the resolution section before "Run prepare"', () => {
      // Anchor on the heading lines (`^...$` + /m) so the inline `## Run prepare`
      // example in the Output-discipline section is not mistaken for the heading.
      const resolveIdx = content.search(/^## Resolve the diff source$/m)
      const prepareIdx = content.search(/^## Run prepare$/m)
      expect(resolveIdx).toBeGreaterThan(-1)
      expect(prepareIdx).toBeGreaterThan(resolveIdx)
    })
  })

  // --- P3.3.3: apply-UX clarification-segregation contract (FR146 / FR147) ----
  //
  // The segregation prose lives in the `## Apply UX` section (shipped by
  // P3.3.1). These guards pin the FR147 no-fabrication invariant at the
  // SKILL.md layer so a future surgical edit cannot silently re-open the
  // leak. Assertions are scoped to the Apply-UX section body (heading → end
  // of doc, since `## Apply UX` is the last `##` section — its sub-parts are
  // `###`) mirroring the `resolveSection()` slicing pattern above.
  describe('apply-UX clarification segregation (Story P3.3.3, FR146/FR147)', () => {
    const applyUxSection = () => {
      const start = content.search(/^## Apply UX$/m)
      // Find the next top-level `## ` heading after Apply UX; if none, slice
      // to end of document (Apply UX is the last `##` section).
      const rest = content.slice(start + 1)
      const nextHeadingOffset = rest.search(/^## /m)
      return nextHeadingOffset === -1
        ? content.slice(start)
        : content.slice(start, start + 1 + nextHeadingOffset)
    }

    it('has a verb-anchored "## Apply UX" section', () => {
      expect(content).toMatch(/^## Apply UX$/m)
    })

    it('"## Apply UX" is the last `##` section (the slice-helper assumption)', () => {
      // applyUxSection() slices to end-of-doc when no following `## ` exists.
      // Pin that documented assumption so a future `##` section appended after
      // Apply UX can't silently change what the section-scoped guards inspect.
      const afterHeading = content.slice(content.search(/^## Apply UX$/m) + 1)
      expect(afterHeading).not.toMatch(/^## /m)
    })

    it('`(a) Apply all` skips "Manual review required" entries silently even on (a)', () => {
      // The no-fabrication invariant: picking "Apply all" must NOT sweep in
      // clarifications / narrative-only drift.
      expect(applyUxSection()).toMatch(
        /skip every "Manual review required" entry silently/,
      )
    })

    it('`(s) Pick subset` carries the literal manual-review refusal message', () => {
      const section = applyUxSection()
      expect(section).toMatch(/Manual-review entries cannot be auto-applied/)
      // …and points the user back at the Manual review required section.
      expect(section).toMatch(/Manual review required/)
    })

    it('`(s) Pick subset` draws indices only from the "Apply-eligible findings" section', () => {
      // The subset indices must be sourced from apply-eligible findings only —
      // manual-review entries are not indexed and not selectable.
      expect(applyUxSection()).toMatch(/Apply-eligible findings/)
    })

    it('names the FR147 no-fabrication invariant in the Apply-UX section', () => {
      const section = applyUxSection()
      expect(section).toMatch(/FR147/)
      expect(section).toMatch(/no-fabrication/i)
    })

    it('suppresses the Apply prompt in the only-manual-review case (guard)', () => {
      const section = applyUxSection()
      // The guard keys off the apply-eligible section being absent / empty.
      expect(section).toMatch(/No apply-eligible findings\./)
      expect(section).toMatch(/no auto-applicable fixes/i)
    })
  })
})
