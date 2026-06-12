# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** via
[GitHub private vulnerability reporting](https://github.com/Legends-of-Tech/delfini/security/advisories/new)
("Report a vulnerability" on this repo's Security tab).

Do **not** open a public issue or PR for a security problem.

Include where possible:

- The affected package (`@delfini/cli`, `@delfini/drift-engine`, `@delfini/action-core`, or the
  GitHub Action in `apps/action`) and version.
- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.

We will acknowledge your report, keep you informed of progress, and credit you in the advisory
unless you prefer otherwise.

## Scope notes

- The CLI (`@delfini/cli`) is deterministic and never calls an LLM or any network service at
  analysis time; it reads and writes only within the repository it runs in.
- `@delfini/drift-engine` performs no I/O of any kind.
- The GitHub Action runs in your CI with the credentials you provide (`GITHUB_TOKEN`, your own
  LLM provider key). It makes no calls to any Delfini-hosted service and hard-fails if a Delfini
  workspace token is supplied.

## Supported versions

Only the latest published version of each package receives security fixes.
