# zwt

A small CLI for git worktrees. One command creates a worktree with the right branch, the right base, and the right git identity for the folder it lives in, then checks that nothing is misconfigured.

Built with TypeScript + [Effect](https://effect.website), compiled with Bun to a single binary.

> **Status: experimental / in development.** Implemented today: `zwt config check`, `zwt new <slug>`, and `zwt identity list|set|check`. Commands below under *Vision* are planned, not implemented. The backlog lives in the issues.

## Install (from source)

Requires [Bun](https://bun.sh) 1.4.2 or newer.

```sh
git clone https://github.com/Byevenes/zwt.git
cd zwt
bun install
bun run build                       # dist/zwt, one executable
```

## Usage

```sh
./dist/zwt --version
./dist/zwt config check             # $XDG_CONFIG_HOME/zwt/zwt.toml, fallback ~/.config/zwt/zwt.toml
./dist/zwt config check --config examples/zwt.toml
./dist/zwt --dry-run config check   # prints planned writes instead of running them
./dist/zwt new login                # creates <prefix>login from the profile's base, under worktrees_dir
./dist/zwt new login --base main --prefix fix/
./dist/zwt new login --identity personal
./dist/zwt new login --email pat@example.com
./dist/zwt --dry-run new login      # shows the fetch, worktree add and git config it would run
./dist/zwt identity list
./dist/zwt identity set personal    # asks before writing a [[project]] entry
./dist/zwt identity check
./dist/zwt --dry-run identity set personal
```

`zwt new` resolves branch prefix, base and identity as `--flag` > `[[project]]` > `[[profile]]` (deepest match) > defaults (`main`, no prefix, `worktrees`). `--email` and `--identity` are the identity flags. The worktree goes to `<repo parent>/<worktrees_dir>/<repo>/<slug>`. Re-running with the same slug prints the existing worktree.

When an identity resolves, `zwt new` enables `extensions.worktreeConfig` in the repo's local git config if needed, then sets `user.name` and `user.email` with `git config --worktree` inside the new worktree and checks that the effective email matches. It does not change `--global` git config. `includeIf` is not written.

If nothing resolves and stdin is a terminal (and `CI` is unset), `zwt new` asks you to pick a configured identity and whether to save that choice as a `[[project]]` entry. Otherwise it stops. The error says the selector was skipped in non-interactive mode and names `zwt identity set`.

`zwt identity check` prints the effective email, the file git read it from (`git config --show-origin`), and the email zwt expected for that repo.

An invalid config is rejected with the offending line and a suggested fix. See `examples/zwt.toml` for a valid one.

## Development

- Checks: `bun run typecheck`, `bun run test`.
- Design decisions: [`docs/adr/`](docs/adr/).
- Learning notes on Effect (in Spanish): [`docs/learn/`](docs/learn/).
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Vision

- **Profiles by folder.** A profile matches a folder (`~/work/acme/**`) and sets the base branch, branch prefix, and git identity for every repo under it.
- **Identity outside worktrees.** `zwt` applies identity with worktree-local git config. Writing an `includeIf "gitdir:"` snippet, and `zwt doctor` checking it before you commit, are still planned.
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
email = "jane.doe@example.com"

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
email = "jane.ext@example.com"        # external email for this project only
```

Precedence: `--flag` > `[[project]]` > most specific `[[profile]]` > global defaults.

```
zwt new <slug> [--base <ref>] [--prefix <p>] [--email <addr>] [--identity <name>] [--dry-run]
zwt identity list | set <name> [path] | check [path]
zwt doctor [path]
zwt list | zwt prune [--merged] [--dry-run]
```

## License

[MIT](LICENSE) © 2026 Brayan Yévenes
