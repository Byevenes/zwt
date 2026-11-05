import { Console, Effect, Option } from "effect"
import { applyWorktreeIdentity } from "./identity.ts"
import { BranchNotFound, IdentityUnresolved, InvalidSlug, UnknownIdentity } from "../errors.ts"
import { isValidSlug, type Identity, type NewFlags, resolveNew } from "../resolve.ts"
import { Config } from "../services/Config.ts"
import { Git } from "../services/Git.ts"
import { Prompt } from "../services/Prompt.ts"

export type NewResult =
  | { readonly _tag: "Created"; readonly path: string; readonly branch: string; readonly base: string; readonly email: string }
  | { readonly _tag: "Exists"; readonly path: string; readonly branch: string }

const chooseIdentity = (options: {
  readonly repoRoot: string
  readonly configFile: string
  readonly home: string
  readonly interactive: boolean
  readonly names: ReadonlyArray<string>
  readonly lookup: (name: string) => Identity | undefined
}) =>
  Effect.gen(function*() {
    const { configFile, home, interactive, lookup, names, repoRoot } = options
    if (!interactive) {
      return yield* new IdentityUnresolved({ repo: repoRoot, file: configFile, reason: "non-interactive" })
    }
    if (names.length === 0) {
      return yield* new IdentityUnresolved({ repo: repoRoot, file: configFile, reason: "empty" })
    }
    const chosen = yield* (yield* Prompt).select("Git identity for this folder", names)
    const named = lookup(chosen)
    if (named === undefined) return yield* new UnknownIdentity({ name: chosen, file: configFile })
    const save = yield* (yield* Prompt).confirm(`Save identity "${chosen}" for ${repoRoot}?`)
    if (save) yield* (yield* Config).upsertProject(configFile, { path: repoRoot, identity: chosen, home })
    return named
  })

/** `zwt new <slug>`: resolve the plan from zwt.toml, then create (or report) the worktree. */
export const newWorktree = (options: {
  readonly slug: string
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly flags: NewFlags
  readonly interactive: boolean
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, flags, home, interactive, slug } = options
    if (!isValidSlug(slug)) return yield* new InvalidSlug({ slug })
    const git = yield* Git
    const loaded = yield* (yield* Config).load(configFile)
    const repoRoot = yield* git.repoRoot(cwd)
    const plan = resolveNew({ config: loaded, repoRoot, slug, home, flags })
    if (plan.identity._tag === "Unknown") return yield* new UnknownIdentity({ name: plan.identity.name, file: configFile })

    const existing = yield* git.worktreeForBranch(plan.branch, repoRoot)
    if (Option.isSome(existing)) {
      return { _tag: "Exists", path: existing.value, branch: plan.branch } satisfies NewResult
    }

    const identity = plan.identity._tag === "Resolved"
      ? plan.identity.identity
      : yield* chooseIdentity({
        repoRoot,
        configFile,
        home,
        interactive,
        names: Object.keys(loaded.identity),
        lookup: (name) => {
          const found = loaded.identity[name]
          return found === undefined ? undefined : { name: found.name, email: found.email }
        }
      })

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
    yield* applyWorktreeIdentity({ git, repoRoot, worktreePath: plan.worktreePath, identity })
    return {
      _tag: "Created",
      path: plan.worktreePath,
      branch: plan.branch,
      base,
      email: identity.email
    } satisfies NewResult
  })
