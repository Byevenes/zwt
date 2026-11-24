# zwt

A small TypeScript + Effect CLI for git worktrees, compiled with Bun. This file is the repo's local context. Shared workflow, host routing and skills live in the home repo [Byevenes/agent-workflow](https://github.com/Byevenes/agent-workflow) (`docs/routing.md`). Do not copy that flow here.

## Commands

From `package.json` (run at the repo root, after `bun install`):

- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — `oxlint --type-aware --deny-warnings src test`
- `bun run test` — `bun --bun vitest run`
- `bun run build` — compile `src/main.ts` to `dist/zwt`
- `bun run mutants` — advisory `mutant-cafe` on `origin/main...HEAD`; not a CI gate

A new user-facing command needs a row in [`docs/feature-map.md`](docs/feature-map.md). `test/feature-map.test.ts` fails when the command tree and the table disagree.

## Decisions and conventions

- Architecture decisions: [`docs/adr/`](docs/adr/).
- Language and runtime: TypeScript + Effect 4, one Bun binary, hooks stay POSIX `sh` ([ADR 0001](docs/adr/0001-language.md)).
- Lint: `@cloudflare/oxlint-config` plus Effect anti-slop rules in `oxlint.config.ts` (`no-service-constructor-imports`, `no-manual-effect-error-tag`, `prefer-effect-match`). Do not invent a manual Effect error tag or import a service constructor when a Layer already exists.
- Every command must support `--dry-run` and be idempotent. Tests use temporary repos only.
- No real organization names, paths, emails or IDs in issues, code or fixtures: use `acme` and `example.com`. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
