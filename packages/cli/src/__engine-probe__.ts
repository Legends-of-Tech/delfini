// Engine-probe entry — gate-C bundled-parity test target ONLY (Story P3.5.1).
//
// The NFR44 gate-C test (`__tests__/bundled-parity.test.ts`) must reach
// `buildPrompt` through a TSUP-BUNDLED file to verify the bundler inlined
// @delfini/drift-engine correctly. This module is that target.
//
// Why this is a SEPARATE entry and not part of `src/index.ts`:
//   - `src/index.ts` is the package's published public surface
//     (`exports.types` → `dist/index.d.ts`). Re-exporting the engine there
//     leaks the private `@delfini/drift-engine` module specifier into the
//     published `.d.ts` (tsup's dts builder keeps workspace re-export
//     specifiers; neither `dts.resolve: true` nor `resolve: [pkg]` inline
//     them). drift-engine is `private:true` / never published, so that
//     leak breaks `import type { ... } from '@delfini/cli'` for external
//     consumers with `skipLibCheck:false`.
//   - This probe is excluded from `dts.entry` in `tsup.config.ts`, so NO
//     `__engine-probe__.d.ts` is emitted — nothing leaks the private name.
//   - The probe's JS still gets the engine inlined (drift-engine is
//     `noExternal`), so the gate-C parity check is faithful.
//
// Not part of the public API. Not referenced by `bin` or `exports`. It rides
// along in the published tarball's `dist/` as a few-hundred-byte JS file with
// no type surface — harmless, and the price of a leak-free public `.d.ts`.

export { buildPrompt } from '@delfini/drift-engine'
export type { AnalysisInput } from '@delfini/drift-engine'
