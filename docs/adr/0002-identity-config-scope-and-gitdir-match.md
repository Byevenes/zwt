# ADR 0002: Identity writes stay local; includeIf gitdirs become profile matches

- Status: accepted
- Date: 2026-11-21
- Issues: #2, #1

## Context

When an identity resolves, zwt writes it into the new worktree. Git keeps worktree config only after the common repo sets `extensions.worktreeConfig` to `true`.

`zwt init` copies each `includeIf` gitdir into a `[[profile]]` `match`. A profile match names a folder and selects that folder and everything under it.

## Decision

1. zwt writes identity only with `git config --local` and `git config --worktree`. `GitConfigScope` is `"local" | "worktree"`. zwt never writes the global git config.
2. `gitdirToMatch` rewrites the gitdir into that match.
   - Drop a trailing `/.git` so the match names the work tree.
   - Leave a pattern that already ends in `/**` unchanged.
   - A pattern that ends in `/` gains `**`.
   - Any other pattern gains `/**`.

## Why

1. `configSet` passes `--worktree` when the scope is `worktree`, and `--local` otherwise. `src/commands/identity.ts` calls it with `local` for `extensions.worktreeConfig`, then with `worktree` for `user.name` and `user.email`. The README states that zwt does not change `--global` git config. `docs/learn/03-prompt-and-worktree-config.md` writes `git config --local`, then `git config --worktree` inside the new worktree.
2. Git treats a trailing `/` on a gitdir pattern as `/**`, so that case keeps git's meaning. A gitdir with no trailing slash matches only that exact directory in git; zwt widens it to `/**` on purpose, because a profile is a folder rule that covers everything under it. The alternative, keeping git's exact-directory meaning, was not taken: the imported profile would stop covering the repos under that folder. Dropping a trailing `/.git` selects the work tree.

## Consequences

1. zwt writes `user.name` and `user.email` with `--worktree`. zwt sets `extensions.worktreeConfig` with `--local` on the common repo. The global git config stays as it was.
2. Imported profiles store a `match` that ends in `/**`. Profile lookup then selects that folder and everything under it.
