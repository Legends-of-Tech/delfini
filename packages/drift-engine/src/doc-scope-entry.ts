// packages/drift-engine/src/doc-scope-entry.ts
//
// Dedicated entry module for the `@delfini/drift-engine/doc-scope` subpath
// export (Story P3.9.2, ADR-2026-06-09). After the monorepo split the closed
// platform repo (Legends-of-Tech/delfini-platform) consumes the doc-scope
// algebra from the PUBLISHED package — but it pins zod@4 while this package
// pins zod@3, so it must never resolve the zod-typed root entry
// (`analysisSchema`, `buildPrompt`, ...). This subpath exposes ONLY the four
// pure algebra functions plus their non-zod classification union; its entire
// .d.ts closure imports nothing but `picomatch`.
//
// HARD CONSTRAINT: re-export ONLY from `./doc-scope.js`. Importing `./index.js`,
// `./schema.js`, `./prompt-builder.js`, or `./reconcile.js` here would
// transitively pull zod into this surface and silently break the zod-isolation
// guarantee (the leak smoke in apps/web/src/server/docs-dialect-parity.test.ts
// fails loudly if that happens).

export {
  normalizeDocScope,
  validateDocScopeEntry,
  classifyEntry,
  isFileInDocScope,
} from './doc-scope.js'

// Named alias for `classifyEntry`'s return union — derived (not duplicated) so
// it can never drift from the function's actual signature.
export type DocScopeEntryKind = ReturnType<typeof import('./doc-scope.js').classifyEntry>
