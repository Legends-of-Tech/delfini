// CLI routing layer for @delfini/cli.
//
// Registers the three top-level flags + three subcommands documented in
// FR141 (architecture.md L988-L991):
//
//   --version         print the @delfini/cli version (exits 0)
//   --reset-scope     delete <repo-root>/.claude/skills/delfini/doc-scope.json
//                     (silent no-op if absent / if outside a git repo, exits 0)
//   install <path>    scaffold .claude/skills/delfini/SKILL.md + CLAUDE.md
//                     marker block + .gitignore .delfini-trace/ append
//   local-prepare     compute diff (per --diff-source) + scope expansion +
//                     prompt + token-budget; write the three .delfini-trace/
//                     input artefacts
//   diff-status       report branch + local/committed change state as JSON
//                     (read-only; the SKILL.md protocol's diff-source helper)
//   local-finalize    validate findings.json, reconcile line numbers,
//                     render .delfini-trace/report.md
//
// Action handlers are thin shims — every behaviour lives in the
// corresponding `runXxx` library function published from
// `packages/cli/src/index.ts`. The router never duplicates business logic
// (story P3.2.7 AC3).
//
// Exit-code propagation invariant (story P3.2.7 AC2): handlers set
// `process.exitCode` rather than calling `process.exit()`. This lets
// pending stdout/stderr writes flush and keeps test isolation clean. The
// bin entry's `.catch()` is the only place a non-zero exit is set on
// unhandled rejection.
//
// Per FR140 the CLI never calls an LLM. ESLint enforces this via the
// packages/cli no-restricted-imports rule (eslint.config.js).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command, CommanderError } from 'commander'

import { runDiffStatus } from './commands/diff-status.js'
import { runInstall } from './commands/install.js'
import { runLocalFinalize } from './commands/local-finalize.js'
import { DEFAULT_RELEVANCE_THRESHOLD, runLocalPrepare } from './commands/local-prepare.js'
import { deleteDocScope } from './doc-scope.js'
import { RepoRootNotFoundError } from './git.js'

// Resolve the running package's package.json once at module load. We read
// it synchronously off the filesystem (rather than importing as JSON) so the
// behaviour is identical whether this module is consumed from src/ during
// development or from a published dist/. The .mjs bin entry and the test
// suite both import from `./src/cli.js` under the bundler resolver — the
// JSON file sits two directories up from `src/cli.ts`.
const pkg = readPackageJson()

interface PackageJsonShape {
  version: string
}

function readPackageJson(): PackageJsonShape {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const pkgPath = path.join(here, '..', 'package.json')
  const raw = readFileSync(pkgPath, 'utf8')
  return JSON.parse(raw) as PackageJsonShape
}

/**
 * Entry point invoked by `bin/delfini.mjs` and by tests.
 *
 * Accepts a process.argv-shape input ([nodePath, scriptPath, ...userArgs]).
 *
 * Subcommand handlers set `process.exitCode` rather than calling
 * `process.exit()` — that lets pending stdout/stderr writes flush and keeps
 * test isolation clean. The bin entry is the only place a hard exit is
 * acceptable, and even there `process.exitCode = N` + a natural return is
 * preferred.
 *
 * On unknown flags, commander's `.exitOverride()` makes it throw
 * `CommanderError` rather than calling `process.exit()`. The bin entry's
 * `.catch()` converts that into a non-zero exit; tests assert on the thrown
 * error directly.
 */
export async function main(argv: string[]): Promise<void> {
  const program = new Command()

  program
    .name('delfini')
    .description('Delfini Skill CLI — deterministic, never calls an LLM.')
    .version(pkg.version, '-V, --version', 'print the @delfini/cli version')
    .option('--reset-scope', 'delete the persisted doc-scope.json')
    .exitOverride()

  program.action(async (opts: { resetScope?: boolean }) => {
    if (opts.resetScope) {
      await handleResetScope()
    }
  })

  program
    .command('install <path>')
    .description(
      'Scaffold .claude/skills/delfini/SKILL.md + CLAUDE.md auto-invoke + .gitignore append',
    )
    .option('--tool <agent>', "Coding agent target (only 'CLAUDE' supported in V1)", 'CLAUDE')
    .option('--auto-invoke', 'append the CLAUDE.md auto-invoke block without prompting')
    .option('--no-auto-invoke', 'strip the CLAUDE.md auto-invoke block without prompting')
    .action(async (targetPath: string, opts: { tool: string; autoInvoke?: boolean }) => {
      // Tri-state: undefined (no flag) → interactive prompt inside runInstall;
      // true (--auto-invoke) → append; false (--no-auto-invoke) → strip.
      const confirmAutoInvoke =
        opts.autoInvoke === undefined
          ? undefined
          : (): Promise<boolean> => Promise.resolve(opts.autoInvoke as boolean)
      await runInstall(targetPath, { tool: opts.tool, confirmAutoInvoke })
    })

  program
    .command('local-prepare')
    .description(
      'Compute diff + doc-scope + prompt + token-budget gate; write .delfini-trace/',
    )
    .option('--scope <paths>', 'Comma-separated doc-scope paths (overrides doc-scope.json)')
    .option('--base <ref>', 'Diff base ref (default: git merge-base HEAD origin/main)')
    .option(
      '--diff-source <source>',
      "Which diff to analyse: 'local' (default), 'committed', or 'both'",
      'local',
    )
    .option(
      '--relevance-threshold <n>',
      `Render only doc SECTIONS scoring at/above N against the diff (Tier 1 +20 / Tier 2 +10 per file / Tier 3 +3 per identifier capped at 30 / Tier 4 +5 per heading), most-relevant-first up to the prompt budget. Default: ${DEFAULT_RELEVANCE_THRESHOLD} (token-efficient retrieval on). Pass 0 to disable and embed every in-scope doc whole. When retained sections still exceed the prompt budget, ranked-fill drops the lowest-scoring sections first and reports what was dropped.`,
      (value) => {
        // Strict integer-only check: reject floats, hex, exponential notation,
        // and any input that parseInt would silently truncate.
        if (!/^\d+$/.test(value)) {
          throw new Error('--relevance-threshold must be a non-negative integer')
        }
        const parsed = Number.parseInt(value, 10)
        if (!Number.isFinite(parsed)) {
          throw new Error('--relevance-threshold must be a non-negative integer')
        }
        return parsed
      },
      // Default ON at the CLI call-site (NFR49). `runLocalPrepare` stays a pure
      // pass-through — this default is what makes a real `delfini local-prepare`
      // run retrieve. Commander applies the default verbatim (it does not run
      // the parser above on it), so a numeric literal is correct here.
      DEFAULT_RELEVANCE_THRESHOLD,
    )
    .option(
      '--enable-diff-prefilter',
      'Drop lockfile/generated/vendored/fixture paths + pure-whitespace/import-only hunks from the diff before prompt assembly (Story P3.7.2 / FR151). Default: off — assembled prompt is byte-identical to the no-flag baseline.',
    )
    .action(
      async (opts: {
        scope?: string
        base?: string
        diffSource?: string
        relevanceThreshold?: number
        enableDiffPrefilter?: boolean
      }) => {
        const exitCode = await runLocalPrepare({
          scope: opts.scope,
          base: opts.base,
          diffSource: opts.diffSource as 'local' | 'committed' | 'both' | undefined,
          relevanceThreshold: opts.relevanceThreshold,
          enableDiffPreFilter: opts.enableDiffPrefilter,
        })
        process.exitCode = exitCode
      },
    )

  program
    .command('diff-status')
    .description('Report branch + local/committed change state as JSON (read-only)')
    .option('--base <ref>', 'Diff base ref (default: git merge-base HEAD origin/main)')
    .action(async (opts: { base?: string }) => {
      const exitCode = await runDiffStatus({ base: opts.base })
      process.exitCode = exitCode
    })

  program
    .command('local-finalize <findingsPath>')
    .description(
      'Validate findings.json, reconcile line numbers, render .delfini-trace/report.md',
    )
    .action(async (findingsPath: string) => {
      const exitCode = await runLocalFinalize({ findingsPath })
      process.exitCode = exitCode
    })

  try {
    await program.parseAsync(argv)
  } catch (err) {
    // commander throws CommanderError on `--version` / `--help` even though
    // those are successful operations. Treat them as success; rethrow
    // anything else (unknown-flag errors, missing-argument errors, etc.).
    if (err instanceof CommanderError && err.exitCode === 0) {
      return
    }
    throw err
  }
}

/**
 * `--reset-scope` subcommand handler.
 *
 * AC1 — deletes `<repo-root>/.claude/skills/delfini/doc-scope.json` via the
 * `deleteDocScope` primitive shipped by Story P3.2.5.
 *
 * AC2 — `deleteDocScope` swallows ENOENT internally → silent no-op when the
 * file is absent.
 *
 * AC3 — outside a git repo, `getRepoRoot()` (called from inside
 * `deleteDocScope`) throws `RepoRootNotFoundError`. We catch that one error
 * type and exit 0 quietly; any other error propagates so real filesystem
 * failures (EACCES, EBUSY) stay visible.
 */
async function handleResetScope(): Promise<void> {
  try {
    await deleteDocScope()
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) {
      // Nothing to reset when there is no repo. Silent no-op.
      return
    }
    throw err
  }
}
