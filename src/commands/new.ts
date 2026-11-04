import { Console, Effect, Option } from "effect"
import { BranchNotFound, IdentityUnresolved, InvalidSlug } from "../errors.ts"
import { isValidSlug, type NewFlags, resolveNew } from "../resolve.ts"
import { Config } from "../services/Config.ts"
import { Git } from "../services/Git.ts"

export type NewResult =
  | { readonly _tag: "Created"; readonly path: string; readonly branch: string; readonly base: string; readonly email: string }
  | { readonly _tag: "Exists"; readonly path: string; readonly branch: string }

/** `zwt new <slug>`: resolve the plan from zwt.toml, then create (or report) the worktree. */
export const newWorktree = (options: {
  readonly slug: string
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly flags: NewFlags
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, flags, home, slug } = options
    if (!isValidSlug(slug)) return yield* new InvalidSlug({ slug })
    const git = yield* Git
    const config = yield* (yield* Config).load(configFile)
    const repoRoot = yield* git.repoRoot(cwd)
    const plan = resolveNew({ config, repoRoot, slug, home, flags })

    const existing = yield* git.worktreeForBranch(plan.branch, repoRoot)
    if (Option.isSome(existing)) {
      return { _tag: "Exists", path: existing.value, branch: plan.branch } satisfies NewResult
    }
    if (Option.isNone(plan.identity)) return yield* new IdentityUnresolved({ repo: repoRoot, file: configFile })

    let base = plan.base
    if (yield* git.hasRemote("origin", repoRoot)) {
      yield* git.fetch("origin", plan.base, repoRoot).pipe(
        Effect.catch((error) => Console.error(`warning: could not fetch origin ${plan.base}, using local refs (${error.stderr.trim()})`))
      )
      if (yield* git.refExists(`refs/remotes/origin/${plan.base}`, repoRoot)) base = `origin/${plan.base}`
    }
    if (base === plan.base && !(yield* git.refExists(plan.base, repoRoot))) {
      return yield* new BranchNotFound({ branch: plan.base, repo: repoRoot })
    }

    yield* git.addWorktree({ cwd: repoRoot, path: plan.worktreePath, branch: plan.branch, base })
    return {
      _tag: "Created",
      path: plan.worktreePath,
      branch: plan.branch,
      base,
      email: plan.identity.value.email
    } satisfies NewResult
  })
