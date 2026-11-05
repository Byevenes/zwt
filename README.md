# zwt

A small CLI for git worktrees. One command creates a worktree with the right branch, the right base, and the right git identity for the folder it lives in, then checks that nothing is misconfigured.

Built with TypeScript + [Effect](https://effect.website), compiled with Bun to a single binary.

> **Status: experimental / in development.** Implemented today: `zwt config check`, `zwt new <slug>`, `zwt identity list|set|check`, `zwt doctor`, and `zwt init`. `zwt list` and `zwt prune` are still planned. The backlog lives in the issues.

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
./dist/zwt doctor                   # ok / warn / fail for this repo
./dist/zwt doctor --all             # one row per configured repo
./dist/zwt doctor --output json
./dist/zwt --dry-run doctor         # reads only; prints that there is nothing to write
./dist/zwt init                      # import includeIf identities, or write a personal starter
./dist/zwt init --yes                # write zwt.toml without prompting
./dist/zwt --dry-run init            # prints the zwt.toml it would write
```

`zwt new` resolves branch prefix, base and identity as `--flag` > `[[project]]` > `[[profile]]` (deepest match) > defaults (`main`, no prefix, `worktrees`). `--email` and `--identity` are the identity flags. The worktree goes to `<repo parent>/<worktrees_dir>/<repo>/<slug>`. Re-running with the same slug prints the existing worktree.

When an identity resolves, `zwt new` enables `extensions.worktreeConfig` in the repo's local git config if needed, then sets `user.name` and `user.email` with `git config --worktree` inside the new worktree and checks that the effective email matches. It does not change `--global` git config. `includeIf` is not written.

If nothing resolves and stdin is a terminal (and `CI` is unset), `zwt new` asks you to pick a configured identity and whether to save that choice as a `[[project]]` entry. Otherwise it stops. The error says the selector was skipped in non-interactive mode and names `zwt identity set`.

Before creating a worktree, `zwt new` reads `origin`. When that URL contains a `[[remote]]` pattern whose identity is not the one this folder will use, it prints a warning and continues. `--strict` exits non-zero and does not create the worktree. No origin, or no matching pattern, prints nothing. `pattern` is a case-sensitive substring, not a glob (`*` is literal). The longest match wins. An existing worktree is still reported as-is. `expect_remote` on a profile is a separate check: it only asks whether the URL contains a substring.

`zwt identity check` prints the effective email, the file git read it from (`git config --show-origin`), and the email zwt expected for that repo.

`zwt doctor` prints ok, warn, or fail for the effective email, the origin URL when the deepest profile sets `expect_remote`, whether that origin matches a `[[remote]]` that requires a different identity, and `core.hooksPath`. A fail exits non-zero and names a fix command. Warn alone exits zero. It does not write git config, files, hooks, or `zwt.toml`. `--all` uses the same checks for every `[[project]]` path and each `[[profile]]` match root that is itself a git toplevel. Unset `core.hooksPath` is ok. A set value is a warning. A `[[remote]]` identity mismatch is a failure. No origin, or an origin that matches no pattern, is ok. Base-branch freshness, bare-repo sanity, `includeIf`, and installing local hooks are not part of this command.

`zwt init` writes only `zwt.toml`. It imports each `includeIf "gitdir:..."` whose included file sets `user.email`. The identity key is that email's local-part, lowercased, with other characters folded into `-`; a second identity with the same key becomes `-2`, then `-3`. The gitdir path becomes `[[profile]] match` (`gitdir:~/personal/` is `~/personal/**`). An existing file is overwritten only after confirmation. Without a terminal the answer is no and the command exits non-zero. `--yes` skips the questions. With no includeIf identity, it writes one personal starter (`jane@example.com`, `~/personal/**`).

An invalid config is rejected with the offending line and a suggested fix. See `examples/zwt.toml` for a valid one.

## Development

- Checks: `bun run typecheck`, `bun run test`.
- Design decisions: [`docs/adr/`](docs/adr/).
- Learning notes on Effect (in Spanish): [`docs/learn/`](docs/learn/).
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Vision

- **Profiles by folder.** A profile matches a folder (`~/work/acme/**`) and sets the base branch, branch prefix, and git identity for every repo under it.
- **Identity outside worktrees.** `zwt` applies identity with worktree-local git config. Writing an `includeIf "gitdir:"` snippet is still planned. `zwt doctor` compares the effective email and does not write includeIf.
- **Local guards, never versioned files.** Optional pre-commit/pre-push guards are not installed by `zwt doctor`. `info/exclude` entries are installed only in `.git/`, only after confirmation, by `zwt new`.
- **Not in `zwt doctor` yet.** Base-branch freshness, bare-repo sanity, and installing local hooks.
- **Portable.** One XDG config file, no secrets, so it moves to the next job or machine.
- **Filters you can add.** Runtime version and further checks, later.

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

[identity.external]
name = "Jane Doe"
email = "jane.external@example.com"

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

[[remote]]
pattern = "github.com/other-org/"      # substring of the origin URL; longest match wins
identity = "external"

[[project]]
path = "~/work/acme/backend/api"
base_branch = "main"                  # overrides the profile
email = "jane.ext@example.com"        # external email for this project only
```

Precedence: `--flag` > `[[project]]` > most specific `[[profile]]` > global defaults.

```
zwt new <slug> [--base <ref>] [--prefix <p>] [--email <addr>] [--identity <name>] [--strict] [--dry-run]
zwt identity list | set <name> [path] | check [path]
zwt doctor [path] [--all] [--output text|json]
zwt init [--yes] [--dry-run]
zwt list | zwt prune [--merged] [--dry-run]
```

## License

[MIT](LICENSE) © 2026 Brayan Yévenes
