---
"@delfini/cli": minor
---

[cli] `delfini install` now seeds `.claude/skills/delfini/doc-scope.json`: it prompts for the docs to track on a TTY, and adds a `--scope <paths>` flag (space- or comma-separated) for non-interactive seeding. Never clobbers an already-configured scope unless `--scope` is given; blank input / non-TTY / invalid paths warn-and-skip, leaving the SKILL.md first-run prompt as the fallback.
