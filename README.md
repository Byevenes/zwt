# zwt

A small CLI for git worktrees. One command creates a worktree with the right branch, the right base, and the right git identity for the folder it lives in, then checks that nothing is misconfigured.

Built with TypeScript + [Effect](https://effect.website), compiled with Bun to a single binary.

> **Status: experimental / in development.** Implemented today: `zwt config check`, `zwt new <slug>`, `zwt open <slug>`, `zwt agent <slug>`, `zwt identity list|set|check`, `zwt doctor`, `zwt sync`, `zwt status`, `zwt init`, `zwt list`, `zwt prune --merged`, `zwt rm <slug>`, and `zwt log`. The backlog lives in the issues.

## Install

A tag `vX.Y.Z` (the same version as `package.json`) publishes four binaries and `checksums.txt` (SHA-256) to [GitHub Releases](https://github.com/Byevenes/zwt/releases). The installer picks the binary for this machine and checks that sum. It is POSIX `sh` and uses `curl` or `wget`, plus `sha256sum` or `shasum`.

```sh
curl -fsSL https://raw.githubusercontent.com/Byevenes/zwt/main/install.sh | sh
```

The binary is installed to `~/.local/bin/zwt`. Add that directory to `PATH` when the script says it is missing. Pin a release, or preview the download, with:

```sh
curl -fsSL https://raw.githubusercontent.com/Byevenes/zwt/main/install.sh | sh -s -- --version v0.1.0
curl -fsSL https://raw.githubusercontent.com/Byevenes/zwt/main/install.sh | sh -s -- --dry-run
```

Assets: `zwt-linux-x64`, `zwt-linux-arm64` (glibc), `zwt-darwin-arm64`, `zwt-darwin-x64`. macOS builds are not notarized. `--dir` chooses the install directory.

### From source

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
./dist/zwt new ABC-123              # branch_template "feature/{ticket}-{slug}" → branch feature/ABC-123
./dist/zwt new ABC-123-fix-login    # same template → branch feature/ABC-123-fix-login
./dist/zwt new login --identity personal
./dist/zwt new login --email pat@example.com
./dist/zwt --dry-run new login      # shows the fetch, worktree add and git config it would run
./dist/zwt open login               # runs the profile open_command with the worktree path
./dist/zwt agent login              # runs the profile agent_command in the worktree
./dist/zwt new login --open         # create (or reuse), then run open_command
./dist/zwt --dry-run open login     # prints the command, does not run it
./dist/zwt identity list
./dist/zwt identity set personal    # asks before writing a [[project]] entry
./dist/zwt identity check
./dist/zwt --dry-run identity set personal
./dist/zwt doctor                   # ok / warn / fail for this repo
./dist/zwt doctor --all             # one row per configured repo
./dist/zwt doctor --output json
./dist/zwt --dry-run doctor         # reads only; prints that there is nothing to write
./dist/zwt sync                      # fast-forward each configured repo's base branch
./dist/zwt --dry-run sync            # print the summary and the fetches it would run
./dist/zwt status                    # one row per worktree of this repo
./dist/zwt status --all              # every configured repo
./dist/zwt status --output json
./dist/zwt --dry-run status          # reads only; prints that there is nothing to write
./dist/zwt init                      # import includeIf identities, or write a personal starter
./dist/zwt init --yes                # write zwt.toml without prompting
./dist/zwt --dry-run init            # prints the zwt.toml it would write
./dist/zwt list                      # path, branch, merged into the base, dirty
./dist/zwt prune --merged            # remove clean worktrees merged into the base
./dist/zwt prune --merged --delete-branch
./dist/zwt --dry-run prune --merged  # prints the removals and does not run them
./dist/zwt rm login                  # remove the worktree for that slug
./dist/zwt rm login --force          # also remove a dirty or unmerged worktree
./dist/zwt rm login --delete-branch
./dist/zwt log                       # recent writes from this machine
```

`zwt new` resolves branch prefix, base and identity as `--flag` > `[[project]]` > `[[profile]]` (deepest match) > defaults (`main`, no prefix, `worktrees`). `--email` and `--identity` are the identity flags. The worktree goes to `<repo parent>/<worktrees_dir>/<repo>/<slug>`. Re-running with the same slug prints the existing worktree.

When that profile sets `branch_template`, the template names the branch. `{prefix}` is its `branch_prefix` (empty when unset). `{ticket}` is the leading match of `ticket_pattern`, a regular expression (`*` is a quantifier, not a glob; `[[remote]].pattern` stays a substring). `{slug}` is the rest of the argument, with one leading `-` or `_` removed. An empty `{slug}` or `{prefix}` drops one `-`, `_`, or `/` written next to it, so `branch_template = "feature/{ticket}-{slug}"` makes `zwt new ABC-123` the branch `feature/ABC-123` and `zwt new ABC-123-fix-login` the branch `feature/ABC-123-fix-login`. The directory still uses the whole slug. If the template contains `{ticket}` and the slug does not start with a match, the command stops before creating a worktree. With no template, the branch stays `<prefix><slug>` even when the slug looks like a ticket. `--prefix` skips the template and appends the whole slug to that prefix.

When an identity resolves, `zwt new` enables `extensions.worktreeConfig` in the repo's local git config if needed, then sets `user.name` and `user.email` with `git config --worktree` inside the new worktree and checks that the effective email matches. It does not change `--global` git config. `includeIf` is not written.

If nothing resolves and stdin is a terminal (and `CI` is unset), `zwt new` asks you to pick a configured identity and whether to save that choice as a `[[project]]` entry. Otherwise it stops. The error says the selector was skipped in non-interactive mode and names `zwt identity set`.

Before creating a worktree, `zwt new` reads `origin`. When that URL contains a `[[remote]]` pattern whose identity is not the one this folder will use, it prints a warning and continues. `--strict` exits non-zero and does not create the worktree. No origin, or no matching pattern, prints nothing. `pattern` is a case-sensitive substring, not a glob (`*` is literal). The longest match wins. An existing worktree is still reported as-is. `expect_remote` on a profile is a separate check: it only asks whether the URL contains a substring.

`zwt identity check` prints the effective email, the file git read it from (`git config --show-origin`), and the email zwt expected for that repo.

`zwt doctor` prints ok, warn, or fail for the effective email, the origin URL when the deepest profile sets `expect_remote`, whether that origin matches a `[[remote]]` that requires a different identity, and `core.hooksPath`. A fail exits non-zero and names a fix command. Warn alone exits zero. It does not write git config, files, hooks, or `zwt.toml`. `--all` uses the same checks for every `[[project]]` path and each `[[profile]]` match root that is itself a git toplevel. Unset `core.hooksPath` is ok. A set value is a warning. A `[[remote]]` identity mismatch is a failure. No origin, or an origin that matches no pattern, is ok. Base-branch freshness, bare-repo sanity, `includeIf`, and installing local hooks are not part of this command.

`zwt sync` fetches `origin/<base>` and fast-forwards the local base branch for that same set of repos. The base is `[[project]]` `base_branch`, then the deepest matching profile, then `main`. The update is a fast-forward of the branch ref only. A diverged base is reported and left untouched, and the command exits non-zero. A base that is ahead of origin is reported and not reset. A base checked out in any worktree is not moved, so the working tree and uncommitted changes stay as they are; `origin/<base>` is still fetched. A missing local branch is reported and not created. No origin, a failed fetch, or a `[[project]]` path that is not a git repository also exits non-zero. Once the local base matches origin, a later run prints `up-to-date`. `--dry-run` prints the summary from the remote-tracking refs already on disk and lists the fetches it would run.

`zwt status` prints one row per worktree: the checkout path, branch, configured base, commits ahead of and behind that base, whether the checkout is dirty, and whole days since the last activity. Activity is the later of the HEAD committer time and the newest path `git status` reports. The base is resolved from the repository's main worktree, the same way `zwt new` resolves it without `--base`: `[[project]]`, then the deepest `[[profile]]`, then `main`. Counts use that local ref and do not fetch. A missing base prints `?` and the command still exits zero. `--all` visits the same roots as `zwt doctor --all` and lists each repository once. `--output json` prints a document with `"version": 1`. The command does not write git config, the index, files, or `zwt.toml`.

`zwt init` writes only `zwt.toml`. It imports each `includeIf "gitdir:..."` whose included file sets `user.email`. The identity key is that email's local-part, lowercased, with other characters folded into `-`; a second identity with the same key becomes `-2`, then `-3`. The gitdir path becomes `[[profile]] match` (`gitdir:~/personal/` is `~/personal/**`). An existing file is overwritten only after confirmation. Without a terminal the answer is no and the command exits non-zero. `--yes` skips the questions. With no includeIf identity, it writes one personal starter (`jane@example.com`, `~/personal/**`).

`zwt list` prints one row per worktree: path, branch, whether that branch is an ancestor of the base (`[[project]]` > `[[profile]]` > `main`), and whether the worktree is dirty (`git status --porcelain`, including untracked files). Detached HEAD is not merged. A worktree whose directory is gone is `missing`, not clean. The main checkout is listed and is never removed.

`zwt prune --merged` removes linked worktrees that are clean and merged into that base. Dirty, unmerged, detached, locked, and missing worktrees stay. The worktree you are in stays. Without `--merged` it removes nothing and exits non-zero. `--delete-branch` deletes the local branch afterwards. The base branch is never deleted, and a branch that is not merged into the base is never deleted. `git branch -d` is used when the branch is contained in `HEAD`; a branch that is only in the base is deleted with `git branch -D`. `--dry-run` prints the removals and does not run them.

`zwt rm <slug>` removes one linked worktree: the path `zwt new` would create, a folder named `<slug>`, or the branch `<prefix><slug>`. An exact `zwt new` path wins when several match. It refuses a dirty or unmerged worktree unless `--force` is passed. `--force` still refuses a locked worktree, the main checkout, and the directory you are in, and it does not delete an unmerged branch. `--delete-branch` follows the same rule as prune. A slug that matches nothing prints `absent` and exits zero.

`zwt open <slug>` runs the deepest matching profile's `open_command` in the worktree and appends the worktree path as the last argument. `zwt agent <slug>` runs `agent_command` with that worktree as its working directory and does not append the path. The slug uses the same branch as `zwt new` without flags. The resolved command is printed before it runs. `--dry-run` prints it and does not run it. The value is an executable plus arguments separated by spaces, not a shell command. A missing executable is an error that names it. With no `open_command`, `zwt open` stops and `zwt new --open` stops before it creates a worktree. With no `agent_command`, `zwt agent` stops. The deepest profile does not inherit these keys from a broader one. `zwt new --open` runs the editor after the worktree is created, and also when that slug already exists.

`zwt log` prints recent write actions from this machine: timestamp, result, and the git or file command. Entries are appended to `$XDG_STATE_HOME/zwt/actions.log` (`~/.local/state/zwt/actions.log` when `XDG_STATE_HOME` is unset). Nothing is sent over the network. Older lines are dropped so the file stays near 256 KiB; the newest line is always kept. `--dry-run` does not append.

An invalid config is rejected with the offending line and a suggested fix. See `examples/zwt.toml` for a valid one.

## Development

- Checks: `bun run typecheck`, `bun run lint`, `bun run test`.
- Design decisions: [`docs/adr/`](docs/adr/).
- Learning notes on Effect (in Spanish): [`docs/learn/`](docs/learn/).
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Vision

- **Profiles by folder.** A profile matches a folder (`~/work/acme/**`) and sets the base branch, branch prefix, optional branch template, and git identity for every repo under it.
- **Identity outside worktrees.** `zwt` applies identity with worktree-local git config. Writing an `includeIf "gitdir:"` snippet is still planned. `zwt doctor` compares the effective email and does not write includeIf.
- **Local guards, never versioned files.** Optional pre-commit/pre-push guards are not installed by `zwt doctor`. `info/exclude` entries are installed only in `.git/`, only after confirmation, by `zwt new`.
- **Not in `zwt doctor` yet.** Base-branch freshness (`zwt sync` fast-forwards the base; doctor does not report it), bare-repo sanity, and installing local hooks.
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
# ticket_pattern = "[A-Z][A-Z0-9]+-[0-9]+" # regex at the start of the slug; not a [[remote]] substring
# branch_template = "feature/{ticket}-{slug}" # {ticket} {slug} {prefix}; omit to keep prefix + slug
expect_remote = "gitlab.com:acme/"
guards = ["pre-commit", "pre-push"]   # offered, installed only with confirmation
open_command = "editor"               # worktree path is appended; not a shell line
agent_command = "agent"               # working directory is the worktree

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
zwt new <slug> [--base <ref>] [--prefix <p>] [--email <addr>] [--identity <name>] [--strict] [--open] [--dry-run]
zwt open <slug> | zwt agent <slug>
zwt identity list | set <name> [path] | check [path]
zwt doctor [path] [--all] [--output text|json]
zwt sync
zwt status [path] [--all] [--output text|json]
zwt init [--yes] [--dry-run]
zwt list
zwt prune --merged [--delete-branch] [--dry-run]
zwt rm <slug> [--force] [--delete-branch] [--dry-run]
zwt log
```

## License

[MIT](LICENSE) © 2026 Brayan Yévenes
