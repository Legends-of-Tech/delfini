import type { ChangedFile } from './github-client-shared.js'

/**
 * Builds a unified-diff string from the GitHub API's per-file patch entries.
 *
 * GitHub's `pulls.listFiles` returns each file's hunks (the `@@ ... @@` content)
 * but omits the `diff --git` / `--- a/… +++ b/…` preamble. We synthesise that
 * preamble so the resulting string is a valid multi-file unified diff and so
 * the single-call prompt-builder's `diff --git` counter (for `changedFileCount`)
 * sees the right file count.
 *
 * Files without a `patch` (binary, renamed-only, or >GitHub's per-file size cap)
 * are skipped entirely per the Story 3.2 design decision: we never lie to the
 * LLM about what changed when we can't actually show it.
 */
export function buildUnifiedDiff(files: ChangedFile[]): string {
  const parts: string[] = []

  for (const file of files) {
    if (!file.patch) continue

    parts.push(`diff --git a/${file.filename} b/${file.filename}`)

    if (file.status === 'added') {
      parts.push(`--- /dev/null`)
      parts.push(`+++ b/${file.filename}`)
    } else if (file.status === 'removed') {
      parts.push(`--- a/${file.filename}`)
      parts.push(`+++ /dev/null`)
    } else {
      parts.push(`--- a/${file.filename}`)
      parts.push(`+++ b/${file.filename}`)
    }

    parts.push(file.patch)
  }

  return parts.join('\n')
}
