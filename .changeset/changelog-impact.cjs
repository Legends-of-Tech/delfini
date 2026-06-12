// .changeset/changelog-impact.cjs
//
// Owner: Story P3.5.4 (AC4) — CHANGELOG impact tags for @delfini/cli.
//
// Wraps @changesets/changelog-github and prepends a surface "impact tag" to every
// release line:  🔬 drift-engine | 🔄 SKILL.md | ⚙️ CLI | 🧩 action-core.
//
// Why the tag comes from the changeset SUMMARY (a leading [marker]) and not the
// changed file paths:
//   1. File paths are NOT available at changelog-generation time — the changelog
//      function only receives the changeset (summary + commit) + the bump type.
//   2. Per .changeset/README.md every changeset is authored as a @delfini/cli bump
//      (drift-engine is bundled into the CLI), so the package can't distinguish the
//      surface either.
// Authors therefore prefix the summary with [drift-engine] / [skill] / [cli] /
// [action-core]. No marker — or an unknown one — defaults to ⚙️ CLI and the
// summary is left intact.
//
// CommonJS, because changesets loads the configured changelog module via require().
// @changesets/changelog-github is lazy-required inside the functions so this module
// loads (and its pure helpers unit-test) even when the changelog-github devDep or a
// GITHUB_TOKEN isn't present — the network-bound github generator is only pulled in
// at actual `changeset version` time.

const TAGS = {
  'drift-engine': '🔬 drift-engine',
  skill: '🔄 SKILL.md',
  cli: '⚙️ CLI',
  // Story P3.9.2a (owner decision Q5) — fourth marker for the shared Action
  // analysis-pipeline core published as @delfini/action-core.
  'action-core': '🧩 action-core',
}
const DEFAULT_TAG = '⚙️ CLI'

let _github
function github() {
  if (!_github) {
    const mod = require('@changesets/changelog-github')
    _github = mod.default || mod
  }
  return _github
}

// Pure: parse a leading [marker] from a changeset summary.
// Returns { tag, summary } — summary has the matched marker stripped; on no match
// or an unknown marker the summary is returned unchanged with the default tag.
function tagForSummary(summary) {
  const raw = typeof summary === 'string' ? summary : ''
  const match = /^\s*\[([a-z][a-z-]*)\]\s*/i.exec(raw)
  if (!match) return { tag: DEFAULT_TAG, summary: raw }
  const tag = TAGS[match[1].toLowerCase()]
  if (!tag) return { tag: DEFAULT_TAG, summary: raw }
  return { tag, summary: raw.slice(match[0].length) }
}

// Pure: insert "<tag>: " immediately after the leading "- " bullet of a release
// line, preserving any leading whitespace/newlines. Anchored to the start so
// hyphens inside the entry text are never touched.
function prefixReleaseLine(line, tag) {
  return line.replace(/^(\s*)-\s+/, `$1- ${tag}: `)
}

async function getReleaseLine(changeset, type, changelogOpts) {
  const { tag, summary } = tagForSummary(changeset && changeset.summary)
  const patched = Object.assign({}, changeset, { summary })
  const line = await github().getReleaseLine(patched, type, changelogOpts)
  return prefixReleaseLine(line, tag)
}

function getDependencyReleaseLine(changesets, dependenciesUpdated, changelogOpts) {
  // Internal-dependency bump lines (e.g. a @delfini/drift-engine cascade) are left
  // to the github generator unchanged — they are not surface-tagged.
  return github().getDependencyReleaseLine(changesets, dependenciesUpdated, changelogOpts)
}

const changelogFunctions = { getReleaseLine, getDependencyReleaseLine }

// Export both the bare functions object and a `.default` alias so changesets'
// changelog loader resolves it regardless of its CJS/ESM-interop expectation.
module.exports = changelogFunctions
module.exports.default = changelogFunctions
// Exposed for unit testing (pure helpers — no network, no changelog-github):
module.exports.tagForSummary = tagForSummary
module.exports.prefixReleaseLine = prefixReleaseLine
