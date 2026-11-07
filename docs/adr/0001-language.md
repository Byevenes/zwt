# ADR 0001: TypeScript + Effect, compiled with Bun; hooks in POSIX shell

- Status: accepted
- Date: 2026-11-03
- Issues: #9, decision log #16 (D1, D2, D4)

## Context

zwt is a small personal CLI that mostly shells out to git. The candidates were Go and TypeScript with Effect. The owner's main goal for this project is to learn Effect so it can be reused in his own TypeScript products.

## Decision

- The CLI is written in TypeScript on Effect 4 (`effect`, `effect/cli`, `@effect/platform-bun`).
- It ships as one executable built with `bun build --compile`.
- Git hooks (#5, #13) stay as POSIX `sh` scripts. zwt installs and checks them but never rewrites them.
- The config is `zwt.toml`, validated at runtime with Effect Schema (D2).

## Why

- **Runtime speed does not decide this.** Almost every command spends its time inside git, not in process start-up. The only hot path is hooks that run on every commit, and those stay in shell with no runtime at all.
- **Effect fits the domain.** Failures are typed (`BranchNotFound`, `IdentityMismatch`, `ConfigInvalid`, `GitCommandFailed`), each with a fix hint. Services and Layers let tests swap real git for a fake, and let `--dry-run` swap writes for a recorder (D4) without `if (dryRun)` branches in commands.
- **Learning transfers.** What is learned here applies directly to the owner's other TypeScript work.

## Consequences

- The compiled binary is large (about 80 MB on linux-x64 with Bun 1.4) against a few MB in Go. It works the same; size is the cost.
- Effect has a steep learning curve. `docs/learn/` keeps one short note per slice (#20).
- Effect 4 moved the CLI into `effect/cli`, so `@effect/cli` (Effect 3) is not used even though older issues name it.
- If portability to machines without the binary ever becomes the top priority, a Go rewrite stays cheap: the CLI is small and the behavior is pinned by tests.

## Install

- From source: `bun install && bun run build` produces `dist/zwt`; copy it onto your `PATH`.
- GitHub Releases (#26): pushing a tag `vX.Y.Z` that matches `package.json` builds four Bun binaries (`bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`) and publishes them with a SHA-256 `checksums.txt`. `install.sh` is POSIX `sh`: it downloads the matching asset and refuses to install when the sum does not match. Linux binaries are glibc. macOS binaries are not notarized. `workflow_dispatch` builds the artifacts and does not publish.
