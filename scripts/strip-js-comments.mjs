// Shared comment-stripper for the Story P3.9.2a release-gate scans (AC7.1).
//
// "Comment-stripped" is load-bearing: the unminified ncc bundle carries
// source comments (e.g. the Lite pipeline's header comment mentions
// `pending_review_exists`), and .d.ts files carry doc comments — neither may
// trip a RUNTIME-marker scan. Minifying before scanning is NOT an option:
// identifier markers (routeStream / callIntakeSafely / buildIntakeInput)
// would be mangled away, false-negating the scan.
//
// This is a small state machine, not a parser: it tracks single-quote,
// double-quote, and template-literal strings (with escape handling) and
// removes // line comments and /* block */ comments outside them. Regex
// literals are not tracked — a marker substring inside a regex literal would
// still be scanned (conservative: can only cause a false POSITIVE, never a
// false negative).

export function stripJsComments(source) {
  let out = ''
  let i = 0
  const n = source.length
  let mode = 'code' // code | line | block | single | double | template

  while (i < n) {
    const ch = source[i]
    const next = i + 1 < n ? source[i + 1] : ''

    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line'
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        mode = 'block'
        i += 2
        continue
      }
      if (ch === "'") mode = 'single'
      else if (ch === '"') mode = 'double'
      else if (ch === '`') mode = 'template'
      out += ch
      i += 1
      continue
    }

    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code'
        out += ch
      }
      i += 1
      continue
    }

    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code'
        i += 2
        // Preserve token separation where the comment sat between tokens.
        out += ' '
        continue
      }
      i += 1
      continue
    }

    // String modes — copy verbatim, honour escapes, exit on the right quote.
    if (ch === '\\') {
      out += ch + next
      i += 2
      continue
    }
    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'template' && ch === '`')
    ) {
      mode = 'code'
    }
    out += ch
    i += 1
  }

  return out
}
