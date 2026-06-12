import matter from 'gray-matter'

// v6.1+ — `.delfiniignore` (path-level exclusion) was retired alongside
// `.delfinidocs` so that platform-managed configuration is the only authority
// over what the Action analyses. The remaining exclusion mechanism is YAML
// front-matter on individual docs (in-doc, visible in the doc's own diff —
// no side-channel to bypass drift detection from outside the doc).
//
// `ExclusionReason` is kept as a single-member union so `ExcludedDoc.reason`
// stays a discriminated string (rather than a non-extensible string literal),
// and so future exclusion sources can land without reshuffling the consumer
// layer (comment-formatter renders this).
export type ExclusionReason = 'front-matter'

export interface ExcludedDoc {
  path: string
  reason: ExclusionReason
  detail?: string
}

export interface FrontMatterResult {
  ignore: boolean
  reason?: string
  body: string
  // Story 3.9b — count of lines occupied by the YAML front-matter block,
  // including both `---` delimiters. `0` when no front-matter was present.
  // Used by the prompt-builder to prefix doc lines with original-file line
  // numbers (offset by this count) and by the orchestrator's reconciler to
  // map LLM-emitted body-relative line numbers back into original-file
  // coordinates. Robust to CRLF; malformed-YAML fallback returns `0`.
  frontMatterLineCount: number
}

// Counts the number of lines occupied by the YAML front-matter block in `markdown`.
// Returns 0 when no front-matter is present. Robust to CRLF / LF; the closing
// `---` may sit on its own line or be followed by trailing whitespace — both
// shapes are matched. If a leading `---` is present but no closing `---` is
// found within a reasonable bound, returns 0 (defensive — prevents counting
// the entire file as front-matter on a malformed doc).
const FRONT_MATTER_OPEN_RE = /^---\r?\n/
function countFrontMatterLines(markdown: string): number {
  if (!FRONT_MATTER_OPEN_RE.test(markdown)) return 0
  const lines = markdown.split(/\r?\n/)
  // First line is the opening `---`. Search for the closing `---` from line 2.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      // i is 0-indexed; the closing `---` is on line `i + 1` (1-indexed),
      // and the block occupies that many lines.
      return i + 1
    }
  }
  return 0
}

type WarnFn = (message: string) => void

export function parseFrontMatter(
  markdown: string,
  onWarn: WarnFn = () => {},
): FrontMatterResult {
  // Compute the line count from the original markdown — independent of
  // gray-matter's parse outcome — so a malformed YAML fallback still produces
  // a useful `frontMatterLineCount` rather than `0`. (Counter-argument: a
  // malformed YAML block is also a sign the structure is suspect; defaulting
  // the count to 0 in the catch path matches the body fallback to original
  // markdown — both say "treat the whole file as body".)
  let parsed: ReturnType<typeof matter>
  try {
    parsed = matter(markdown)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    onWarn(`Failed to parse front-matter: ${reason}`)
    return { ignore: false, body: markdown, frontMatterLineCount: 0 }
  }

  const data = parsed.data as Record<string, unknown>
  const body = parsed.content
  const frontMatterLineCount = countFrontMatterLines(markdown)

  if (!('delfini' in data)) {
    return { ignore: false, body, frontMatterLineCount }
  }

  const value = data.delfini

  // Shorthand: delfini: ignore | skip  (or delfini: true)
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'ignore' || normalized === 'skip') {
      return { ignore: true, body, frontMatterLineCount }
    }
    onWarn(
      `Unrecognised front-matter value for 'delfini': "${value}" — expected "ignore" or "skip". Treating as not-ignored.`,
    )
    return { ignore: false, body, frontMatterLineCount }
  }

  if (typeof value === 'boolean') {
    return { ignore: value, body, frontMatterLineCount }
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const ignoreFlag = obj.ignore
    const skipFlag = obj.skip
    const rawReason = obj.reason

    const reason =
      typeof rawReason === 'string' && rawReason.trim().length > 0
        ? rawReason.trim()
        : undefined

    if (ignoreFlag === true || skipFlag === true) {
      return { ignore: true, reason, body, frontMatterLineCount }
    }

    if (ignoreFlag === false || skipFlag === false) {
      return { ignore: false, body, frontMatterLineCount }
    }

    onWarn(
      `Front-matter 'delfini' object did not contain a boolean 'ignore' or 'skip' flag. Treating as not-ignored.`,
    )
    return { ignore: false, body, frontMatterLineCount }
  }

  onWarn(
    `Front-matter 'delfini' value has unsupported type (${typeof value}). Treating as not-ignored.`,
  )
  return { ignore: false, body, frontMatterLineCount }
}

export function stripFrontMatter(markdown: string): string {
  try {
    return matter(markdown).content
  } catch {
    return markdown
  }
}
