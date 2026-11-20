# Feature map

User-facing commands, then the two global flows. The description is the command's own text. `test/feature-map.test.ts` reads the command tree and fails when a row is missing, extra, or names a file that is not there.

| Command | What you get | Verified by |
| --- | --- | --- |
| `config` | `inspect zwt configuration` | `test/config.test.ts` |
| `config check` | `validate zwt.toml` | `test/config.test.ts`, `./dist/zwt config check --config examples/zwt.toml` |
| `new` | `create a worktree for <slug> from the profile's base branch` | `test/new.test.ts`, `test/new.integration.test.ts`, `scripts/smoke-new.sh`, `bash scripts/smoke-new.sh dist/zwt` |
| `open` | `run the profile open_command with the worktree path` | `test/open.integration.test.ts`, `test/launch.test.ts` |
| `agent` | `run the profile agent_command in the worktree` | `test/open.integration.test.ts`, `test/launch.test.ts` |
| `identity` | `git identity for a folder` | `test/identity.test.ts` |
| `identity list` | `list configured identities` | `test/identity.test.ts` |
| `identity set` | `map a folder to an identity` | `test/identity.test.ts` |
| `identity check` | `print effective, origin and expected email` | `test/identity.test.ts` |
| `doctor` | `audit identity, origin and hooks path` | `test/doctor.test.ts`, `test/doctor.integration.test.ts`, `scripts/smoke-doctor.sh` |
| `sync` | `fetch and fast-forward the base branch of every configured repo` | `test/sync.test.ts`, `test/sync.integration.test.ts` |
| `status` | `show branch, ahead/behind base, dirty state, and days since activity` | `test/status.test.ts`, `test/status.integration.test.ts` |
| `init` | `write zwt.toml from includeIf gitdir identities, or a personal starter` | `test/init.test.ts`, `test/init.integration.test.ts` |
| `list` | `list worktrees with branch, merged and dirty` | `test/worktrees.test.ts`, `test/worktrees.integration.test.ts` |
| `prune` | `remove clean worktrees merged into the base` | `test/worktrees.test.ts`, `test/worktrees.integration.test.ts` |
| `rm` | `remove one linked worktree by slug` | `test/worktrees.test.ts`, `test/worktrees.integration.test.ts` |
| `log` | `show recent local write actions` | `test/log.integration.test.ts`, `test/action-log.test.ts` |
| `--dry-run` | `print planned writes instead of running them` | `test/dry-run.test.ts` |
| `--wizard` | `Start wizard mode for a command` | `scripts/fuzz-bombadil.sh` |
