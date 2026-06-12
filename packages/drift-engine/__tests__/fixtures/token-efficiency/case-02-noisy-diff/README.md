# Case 02 — Noisy diff

The driver here is FR151 (deterministic diff pre-filter), not section
retrieval. The diff mixes a real code change with three categories of
noise hunks that `filterDiff` must drop deterministically:

- **Real code hunk** — rename `formatDate` → `formatTimestamp` in
  `src/utils/format.ts` (the kept hunk).
- **`pnpm-lock.yaml`** — full-file path-level drop, `reason: 'lockfile'`.
- **`apps/web/src/routeTree.gen.ts`** — full-file path-level drop,
  `reason: 'generated'` (matches the `*.gen.ts` convention used by
  TanStack Router and Drizzle).
- **`src/utils/whitespace.ts`** — single hunk-level drop, `reason:
  'whitespace-only'` (the only change inside the hunk is a leading-space
  count change).

The single doc `docs/utils-guide.md` carries a `## Format Helpers` section
that names `formatDate` / `src/utils/format.ts` — that section is the
retention ground-truth. Under retrieval-on the section survives because
the kept (post-filter) diff still references `formatDate` /
`src/utils/format.ts`.

This fixture is shaped so token reduction primarily flows from `filterDiff`
shrinking the diff (~2KB → ~0.4KB) rather than from section retrieval
(the doc is small and single-section-relevant). It complements
`case-01-doc-heavy` (where the reduction flows primarily from dropping
unrelated docs and unrelated sections of the partly-relevant doc).
