// tsup config for @delfini/cli — Strategy B bundle (ADR-ratified 2026-05-27,
// Story P3.5.1).
//
// noExternal: drift-engine is private:true (never on npm), so it MUST be
//   bundled into dist/cli.js / dist/index.js. Otherwise the published tarball
//   crashes with MODULE_NOT_FOUND on first run for users who `npm i -g @delfini/cli`
//   (or `npx @delfini/cli`) because npm would try to resolve `@delfini/drift-engine`
//   from a package that isn't published.
// zod is drift-engine's runtime dep — bundled to keep the tarball atomic.
// picomatch is drift-engine's second runtime dep (ADR-2026-06-01 charter
//   amendment for the doc-scope algebra) — also bundled. drift-engine itself
//   is inlined, so its `import picomatch from 'picomatch'` would otherwise
//   crash with MODULE_NOT_FOUND on a fresh `npx @delfini/cli` install
//   (picomatch is not in the CLI's own `dependencies`).
// All other deps (commander, simple-git, tinyglobby) stay external — resolved
//   from the user's node_modules at install time.
//
// No minify: trace artefacts (NFR46) require readable stack traces in
// .delfini-trace/findings-attempt-{1,2}.json for debugging — minification
// renames symbols and makes those harder to diagnose. Tarball cost is ~50KB.

import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

// drift-engine is bundled as CODE (noExternal below), but its `prompt.md` is a
// runtime ASSET read via fs — bundling cannot inline it. Since drift-engine is
// private:true (its source tree is absent from a published @delfini/cli), the
// template MUST be copied next to the bundled cli.js so `local-prepare` can
// resolve `./prompt.md` (see local-prepare.ts resolvePromptTemplatePath). The
// CLI's package.json `files` ships `dist/`, so the copied asset is published.
const PROMPT_SRC = fileURLToPath(new URL('../drift-engine/src/prompt.md', import.meta.url))
const PROMPT_DEST = fileURLToPath(new URL('./dist/prompt.md', import.meta.url))

export default defineConfig({
  // __engine-probe__.ts is a test-only entry (gate-C bundled-parity target);
  // it re-exports buildPrompt from the inlined engine so the parity test can
  // reach a BUNDLED buildPrompt. It is intentionally EXCLUDED from dts.entry
  // below — emitting its .d.ts would leak the private @delfini/drift-engine
  // specifier into the published tarball (the P3.5.1 review finding). See
  // src/__engine-probe__.ts for the full rationale.
  entry: ['src/cli.ts', 'src/index.ts', 'src/__engine-probe__.ts'],
  format: ['esm', 'cjs'],
  // dts uses a non-composite tsconfig — the root tsconfig.json references
  // packages/cli via project refs (so the package config must keep
  // composite:true), but tsup's in-process dts builder doesn't honour
  // composite project-file-list semantics. Point dts at tsconfig.build.json
  // (extends tsconfig.json + composite:false) to bypass.
  //
  // dts.entry lists ONLY the public surface (index + cli) — the engine probe
  // is deliberately omitted so no __engine-probe__.d.ts (which would carry a
  // bare `from '@delfini/drift-engine'` re-export) is published. With the
  // engine surface no longer re-exported from index.ts, dist/index.d.ts is
  // free of the private specifier.
  dts: { entry: ['src/index.ts', 'src/cli.ts'] },
  tsconfig: 'tsconfig.build.json',
  clean: true,
  shims: true,
  noExternal: ['@delfini/drift-engine', 'zod', 'picomatch'],
  // Copy drift-engine's prompt.md next to the bundle after each successful
  // build (clean:true wipes dist/ first, so this runs post-clean). Runs on
  // watch rebuilds too — cheap single-file copy.
  onSuccess: async () => {
    copyFileSync(PROMPT_SRC, PROMPT_DEST)
  },
})
