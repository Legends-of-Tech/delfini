// Public API barrel for @delfini/cli.
//
// Story P3.2.5 ships the doc-scope primitives (read/write/expand/exists/
// delete) plus the minimum-viable `getRepoRoot()` helper they depend on.
// Story P3.2.6 ships the `.delfini-trace/` lifecycle primitives.
// Subsequent stories will extend this barrel:
//   - P3.2.1 → cli.ts entry + install command + bin registration
//   - P3.2.2 → local-prepare command (consumes readDocScope + expandDocScope + trace primitives)
//   - P3.2.3 → local-finalize command (consumes trace primitives)
//   - P3.2.4 → reset-scope + --version commands (consumes deleteDocScope)
//
// Internal helpers (validatePath, longestStaticPrefix, etc.) are NOT
// exported here — they stay file-internal. The principle matches
// @delfini/drift-engine's AC2: barrel is the consumer-facing contract;
// internals are reachable only via relative imports from tests inside the
// same package.

export {
  DELFINI_CONFIG_RELATIVE_PATH,
  DELFINI_CONFIG_VERSION,
  LEGACY_DOC_SCOPE_RELATIVE_PATH,
  ConfigCorruptError,
  ConfigValidationError,
  ConfigVersionMismatchError,
  configExists,
  deleteConfig,
  expandDocScope,
  readConfig,
  writeConfig,
  writeConfigScaffold,
  writeDocScope,
} from './config.js'

export type {
  DelfiniConfig,
  ConfigUpdate,
  ConfigWriteOptions,
  DocScopeExpansionResult,
} from './config.js'

export { RepoRootNotFoundError, getRepoRoot } from './git.js'

export {
  appendToGitignore,
  ensureTraceDir,
  writeRetryAttemptFile,
  writeTraceFile,
} from './trace.js'

// CLI entry point (Story P3.2.4). Exported here so tests and external
// callers can invoke `main(argv)` without reaching into internal paths.
export { main } from './cli.js'

// -- Commands ----------------------------------------------------------------
//
// The cli.ts router (P3.2.4) wires these subcommands in. The barrel exposes
// the functions so the router (and tests) can consume a stable surface
// without reaching into `./commands/`.

export { InstallToolNotSupportedError, runInstall } from './commands/install.js'
export type { InstallLogger, RunInstallOptions } from './commands/install.js'

export { PROMPT_TOKEN_BUDGET, runLocalPrepare } from './commands/local-prepare.js'
export type { DiffSource, RunLocalPrepareOptions } from './commands/local-prepare.js'

export { runDiffStatus } from './commands/diff-status.js'
export type { DiffStatus, RunDiffStatusOptions } from './commands/diff-status.js'

export { runLocalFinalize } from './commands/local-finalize.js'
export type { RunLocalFinalizeOptions } from './commands/local-finalize.js'

// NOTE: the @delfini/drift-engine surface is deliberately NOT re-exported
// here. It is an internal implementation detail of the CLI, not public API.
// The gate-C bundled-parity test reaches `buildPrompt` through the dedicated
// `src/__engine-probe__.ts` entry instead — keeping the published
// `dist/index.d.ts` free of the private `@delfini/drift-engine` specifier
// (Story P3.5.1 review finding). See that file's header for the rationale.
