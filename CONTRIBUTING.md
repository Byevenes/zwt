# Contributing

Personal project; issues are the backlog.

- One issue per change, with **Problem**, **Proposal**, and **Acceptance criteria**.
- Labels: `core` (worktree and config), `guard` (safety checks and hooks), `dx` (developer experience), `idea` (not committed yet).
- No real organization names, paths, emails, or IDs in issues, code, or fixtures: use `acme`, `example.com`.
- Every command needs `--dry-run` and must be idempotent. Tests use temp repos only.
- A new command needs a row in [`docs/feature-map.md`](docs/feature-map.md). `test/feature-map.test.ts` fails when the tree and the table disagree.
- Commits use your GitHub noreply email (`<id>+<user>@users.noreply.github.com`). CI rejects other emails in a PR; enable the local check once per clone with `git config core.hooksPath .githooks`.
