# zwt

Personal CLI for git worktrees. One command creates a worktree with the right branch, the right base, and the right git identity for the folder it lives in, then checks that nothing is misconfigured.

Status: slice 1 (architecture and `zwt config check`). The backlog lives in the issues.

## Usage

```sh
bun install
bun run build                       # dist/zwt, one executable
./dist/zwt --version
./dist/zwt config check             # $XDG_CONFIG_HOME/zwt/zwt.toml, fallback ~/.config/zwt/zwt.toml
./dist/zwt config check --config examples/zwt.toml
./dist/zwt --dry-run config check   # prints planned writes instead of running them
```

Checks: `bun run typecheck`, `bun run test`. Design: `docs/adr/`. Effect notes in Spanish: `docs/learn/`.

## Vision

- **Profiles by folder.** A profile matches a folder (`~/work/acme/**`) and sets the base branch, branch prefix, and git identity for every repo under it.
- **Identity by default, override when needed.** Personal, work, or a per-project external email: the profile sets the default, a project or a `--email` flag overrides it, and `zwt doctor` verifies the effective email before you commit.
- **Local guards, never versioned files.** Optional pre-commit/pre-push guards and `info/exclude` entries are installed only in `.git/`, only after confirmation.
- **Portable.** One XDG config file, no secrets, so it moves to the next job or machine.
- **Filters you can add.** Runtime version, remote host, hooksPath, and more, as `doctor` checks.

## Non-goals

- No tracker, CI, or cloud integration that needs API tokens.
- Never writes tracked files in a repo it manages.

## Config sketch (`$XDG_CONFIG_HOME/zwt/zwt.toml`)

```toml
version = 1
worktrees_dir = "worktrees"          # relative to the project's parent folder
scratch_dir = ".scratch"             # added to .git/info/exclude

[identity.personal]
name = "Jane Doe"
email = "jane@example.com"

[identity.work]
name = "Jane Doe"
email = "jane.doe@company.example"

[[profile]]
match = "~/personal/**"
identity = "personal"
base_branch = "main"

[[profile]]
match = "~/work/acme/**"
identity = "work"
base_branch = "develop"
branch_prefix = "feature/"
expect_remote = "gitlab.com:acme/"
guards = ["pre-commit", "pre-push"]   # offered, installed only with confirmation

[[project]]
path = "~/work/acme/backend/api"
base_branch = "main"                  # overrides the profile
email = "jane@acme.example"           # external email for this project only
```

Precedence: `--flag` > `[[project]]` > most specific `[[profile]]` > global defaults.

```
zwt new <slug> [--base <ref>] [--email <addr>] [--dry-run]
zwt doctor [path]
zwt list | zwt prune [--merged] [--dry-run]
```

## License

All rights reserved. No license is granted yet.
