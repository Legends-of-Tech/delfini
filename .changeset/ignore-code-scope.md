---
"@delfini/cli": minor
"@delfini/drift-engine": minor
"@delfini/action-core": minor
---

[cli] Add `ignore_code_scope` — configure code paths whose changes Delfini ignores during drift analysis. A changed file matching any entry (directory, file, or glob; the same picomatch@4 dialect as `doc_scope`) is dropped from the analysed diff, as if it had not changed. Configure it in the new committed `delfini-config.json` (renamed from `doc-scope.json`, with a transparent legacy read-fallback + one-time migration) or per-run via the new `delfini local-prepare --ignore-code-scope` flag; on the GitHub Action via the new `ignore_code_scope` input (a PR touching only ignored code smart-skips to a clean PASS). The drift-engine `filterDiff` gains a `{ builtins, ignorePaths }` options arg — the no-config path stays byte-identical, so the snapshot/parity gates are unaffected.

`delfini install` now also prompts for ignore code paths (after the docs prompt; `--ignore-code-scope` flag for non-interactive runs) and always creates `delfini-config.json` with both fields present — empty arrays when every prompt is skipped — so the team gets a committed, hand-editable template. An empty `doc_scope` is treated as "not configured", so the first `/delfini` run prompts to fill it in.
