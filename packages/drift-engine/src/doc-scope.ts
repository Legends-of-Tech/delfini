// packages/drift-engine/src/doc-scope.ts
//
// Pure doc-scope algebra — the single home for normalization, validation,
// classification, and the in-scope predicate shared by EVERY surface:
// the Action (Full + Lite), the Web platform, and the @delfini/cli Skill.
// Consolidated here under ADR-2026-06-01 so "what smart-skip skips" and
// "what the expander includes" can never silently diverge — there is one
// rule set and one glob dialect (picomatch@4).
//
// HARD CONSTRAINTS (FR139 / NFR44 / ESLint no-restricted-imports on
// packages/drift-engine/src/**):
//   - Side-effect-free, pure functions only. No fs, no child_process, no
//     http/https, no network, no process.env, no clock, no randomness.
//   - Platform-independent: the SAME function runs on the developer's
//     Windows CLI, the Action's Linux CI, and the Web edge runtime and MUST
//     return identical results. We therefore do NOT import `node:path`
//     (its `path.sep` is platform-specific and the `node:` specifier can
//     trip edge bundlers) — POSIX normalization is implemented inline below.
//   - Sole matcher: picomatch@4 (the second runtime dep added under
//     ADR-2026-06-01). No other glob engine, no hand-rolled magic-char
//     detection — picomatch owns the dialect.
//
// I/O EXPANSION IS NOT HERE. Materialising a scope into a concrete file set
// (fs walk, git-trees, Octokit) stays per-surface (ports/adapters): the CLI
// `expandDocScope`, the Action/Web git-trees match. These functions reason
// over path STRINGS only.

import picomatch from 'picomatch'

// -- normalizeDocScope --------------------------------------------------------

/**
 * Canonicalise a doc-scope value to a deduped POSIX `string[]`.
 *
 * - `null` / `undefined` coerce to `[]` (defensive — JSON config loaders
 *   commonly produce these at the boundary).
 * - A single `string` wraps as `[value]`. It is NOT comma/newline-split —
 *   delimited-string splitting is a per-surface concern (e.g. Lite's
 *   `docs_path` is split in `readPipelineInputs()`), deliberately kept out
 *   of the pure algebra.
 * - Each entry is `.trim()`-ed before further processing so `'  docs  '`
 *   and `'docs'` dedupe to one entry (matches `validateDocScopeEntry`'s
 *   own trim — keeps validate/normalize aligned).
 * - Backslashes are normalised to forward slashes (the persisted dialect is
 *   POSIX). Trailing slashes are stripped; `//` runs collapse; `./` and
 *   `..` segments resolve via the inline POSIX normaliser. So `'./docs'`
 *   and `'docs'` dedupe, `'docs//api'` becomes `'docs/api'`, and
 *   `'docs/sub/../api/*.md'` becomes `'docs/api/*.md'` (which the matcher
 *   can actually match).
 * - Entries are deduped, preserving first-occurrence order.
 * - Entries that collapse to nothing (`''`, `'/'`, `'.'`, `'./'`) are
 *   dropped — these are tautological or empty, and `validateDocScopeEntry`
 *   would otherwise have to special-case them.
 *
 * Non-emptiness of the OUTPUT is NOT enforced here — that is a schema /
 * validation concern at each surface (`docScopeSchema.min(1)`,
 * `writeDocScope`).
 *
 * `normalizeDocScope` is intentionally NOT a security gate: an escape entry
 * like `'../secrets'` survives (validation is `validateDocScopeEntry`'s
 * job). The matcher in `isFileInDocScope` then can't match it against any
 * real in-tree file path, so the worst-case outcome is "silent no-match,"
 * not exfiltration.
 */
export function normalizeDocScope(input: string | string[] | null | undefined): string[] {
  if (input == null) return []
  const entries = typeof input === 'string' ? [input] : input
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of entries) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const normalised = stripTrailingSlashes(posixNormalize(toPosix(trimmed)))
    if (normalised.length === 0 || normalised === '.') continue
    if (seen.has(normalised)) continue
    seen.add(normalised)
    out.push(normalised)
  }
  return out
}

// -- validateDocScopeEntry ----------------------------------------------------

/**
 * Validate a single doc-scope entry. Returns `null` on success, or a
 * human-readable error string on failure.
 *
 * Ports the @delfini/cli `validatePath` + `longestStaticPrefix` repo-escape
 * technique (the richest existing implementation) — reworked to be PURE and
 * RELATIVE-root based. `repoRootRel` is a relative marker (callers pass
 * `'.'`); we never resolve against an absolute filesystem path or use
 * `path.sep`.
 *
 * Rejects:
 *   - absolute paths (POSIX `/...` and Windows-drive `C:\...` / `C:/...`),
 *   - entries containing ASCII control characters (CR, LF, TAB, NUL, etc.)
 *     — these survive a JSON round-trip but can never be a real path; the
 *     matcher silently no-ops them, which is a worse failure mode than a
 *     loud rejection,
 *   - entries whose normalisation escapes the repo root (`../`, mid-path
 *     traversal, AND traversal hidden inside a glob portion such as
 *     `**\/../../x` — the CLI's static-prefix-only check could not catch the
 *     last case, so we normalise the FULL entry, which is strictly stronger),
 *   - empty / whitespace-only entries.
 *
 * NOTE: this validator is layered, not auto-invoked by `normalizeDocScope`
 * or `isFileInDocScope`. Each surface must call it at the persistence
 * boundary (`writeDocScope`, the Zod refine for the FR88g contract, the
 * Web settings list-editor). Bypassing it produces silent matcher
 * no-matches, not insecure behaviour — but callers should treat it as
 * mandatory at user-input boundaries.
 */
export function validateDocScopeEntry(entry: string, repoRootRel: string): string | null {
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    return 'doc-scope entry must be a non-empty string'
  }

  // Reject ASCII control characters (CR, LF, TAB, NUL, etc.). These can
  // survive a JSON round-trip from a hand-edited `doc-scope.json` but the
  // matcher will only ever silently no-op against them.
  if (/[\x00-\x1f]/.test(entry)) {
    return `doc-scope entry must not contain control characters: ${JSON.stringify(entry)}`
  }

  const posixEntry = toPosix(entry.trim())

  if (isAbsolutePath(posixEntry)) {
    return `doc-scope entries must be relative to the repo root: ${entry}`
  }

  // Repo-escape check: join under the (relative) root and normalise the WHOLE
  // entry — `..` segments anywhere (including inside a glob like `**/../../x`,
  // whose static prefix is empty) collapse out, so an escape surfaces as a
  // leading `..` in the result.
  const root = stripTrailingSlashes(toPosix(repoRootRel)) || '.'
  const joined = posixNormalize(`${root}/${posixEntry}`)
  if (joined === '..' || joined.startsWith('../')) {
    return `doc-scope entry escapes repo root: ${entry}`
  }

  return null
}

// -- classifyEntry ------------------------------------------------------------

/**
 * Classify a doc-scope entry by SHAPE — a pure string heuristic, NOT a
 * filesystem check (this module cannot `stat`):
 *   - `'glob'` — contains glob magic (decided by picomatch's own scanner, so
 *     the classification dialect matches the matching dialect).
 *   - `'dir'`  — `.` / `''` (repo-root tautology), OR last segment starts
 *     with a `.` (hidden directory pattern: `.github`, `.husky`, `.vscode`,
 *     `.changeset`, etc.), OR last segment has no `.` at all.
 *   - `'file'` — not a glob, not dot-prefix, AND last segment contains a `.`
 *     (heuristic: it looks like `name.ext`).
 *
 * KNOWN LIMITATION: versioned directories like `docs/v1.2` are misclassified
 * as files by the dot-in-last-segment heuristic (we'd need a real extension
 * registry to distinguish `v1.2` from `index.md`). Users who scope a
 * versioned doc tree should prefer an explicit glob form (e.g.
 * `docs/v1.2/<globstar>/*.md`). The predicate's dir/file branches degrade
 * silently here — there is no authoritative fs-expander rescue for the
 * smart-skip path-shape use case.
 */
export function classifyEntry(entry: string): 'dir' | 'file' | 'glob' {
  const posixEntry = toPosix(entry)
  if (picomatch.scan(posixEntry).isGlob) return 'glob'
  const stripped = stripTrailingSlashes(posixEntry)
  if (stripped === '' || stripped === '.') return 'dir'
  const lastSegment = stripped.split('/').pop() ?? ''
  // Dot-prefix last segment = hidden directory by convention (.github,
  // .husky, .vscode, .changeset, etc.). Force 'dir' to avoid the otherwise
  // silent "matches exactly one nonexistent file" failure for an extremely
  // common real-world scope.
  if (lastSegment.startsWith('.')) return 'dir'
  return lastSegment.includes('.') ? 'file' : 'dir'
}

// -- isFileInDocScope ---------------------------------------------------------

/**
 * True iff `filePath` falls within any entry of `scope`. Both `filePath` and
 * the scope entries are repo-relative POSIX paths.
 *
 * Per-entry strategy keys off `classifyEntry`:
 *   - `'dir'`  -> matches the recursive subtree (`docs` ⇒ `docs/**`).
 *   - `'file'` -> exact path match.
 *   - `'glob'` -> picomatch semantics.
 *
 * The predicate is PATH-SHAPE-ONLY — it does not filter by `.md` extension.
 * The `.md`-only restriction on directory expansion belongs to the expanders
 * (CLI `expandDocScope`, Action/Web git-trees match), which keeps this
 * predicate usable by smart-skip on arbitrary changed-file paths.
 *
 * Matching is `dot: false, nocase: true`:
 *   - case-insensitive matching aligns with the CLI expander's existing
 *     `caseSensitiveMatch: false` (fs realism on Windows/macOS), so the same
 *     repo cloned across platforms returns identical in-scope decisions —
 *     the dialect-parity invariant the ADR exists to enforce. The header's
 *     "platform-independent results" promise IS the case-insensitive choice.
 *   - `dot: false` matches the CLI expander default. Dot-prefix hidden
 *     directories still match via the `classifyEntry` → `'dir'` path
 *     (entry `'.github'` becomes pattern `'.github/**'`, which picomatch
 *     matches against `.github/workflows/x.yml` even with `dot: false`
 *     because the literal `.github` prefix is present in the pattern).
 *
 * The `filePath` is defensively normalised: backslashes converted to
 * forward slashes, leading `/` and `./` runs stripped, `..` segments
 * resolved — so callers feeding webhook payloads (`/docs/a.md` from
 * `URL.pathname`), Windows-style paths (`docs\a.md`), or composed paths
 * (`./docs/sub/../a.md`) all collapse to the same canonical form before
 * matching.
 */
export function isFileInDocScope(filePath: string, scope: string[]): boolean {
  const file = posixNormalize(toPosix(filePath).replace(/^\/+/, ''))
  if (file === '' || file === '.') return false
  const entries = normalizeDocScope(scope)
  for (const entry of entries) {
    const pattern = classifyEntry(entry) === 'dir' ? `${entry}/**` : entry
    if (picomatch(pattern, { dot: false, nocase: true })(file)) return true
  }
  return false
}

// -- Internal helpers (NOT exported via index.ts) -----------------------------

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

function stripTrailingSlashes(p: string): string {
  return p.replace(/\/+$/, '')
}

function isAbsolutePath(posixEntry: string): boolean {
  // POSIX-absolute (`/etc`) or Windows-drive-absolute (`C:\` / `C:/`).
  return posixEntry.startsWith('/') || /^[A-Za-z]:\//.test(posixEntry)
}

/**
 * Pure POSIX path normalisation — resolves `.` and `..` segments without any
 * `node:path` dependency (edge-safe, platform-independent). Glob magic
 * characters (`*`, `**`, `{`, `?`, etc.) are treated as ordinary literal
 * segments, which is exactly what the repo-escape check needs.
 */
function posixNormalize(input: string): string {
  const isAbsolute = input.startsWith('/')
  const out: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!isAbsolute) {
        out.push('..')
      }
      // An absolute path cannot ascend above root — drop the `..`.
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  if (isAbsolute) return `/${joined}`
  return joined.length === 0 ? '.' : joined
}
