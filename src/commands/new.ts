import { Console, Effect, FileSystem, Option } from "effect"
import { applyWorktreeIdentity } from "./identity.ts"
import { BranchNotFound, IdentityUnresolved, InvalidSlug, RemoteIdentityMismatch, UnknownIdentity } from "../errors.ts"
import { appendExcludeLine } from "../exclude.ts"
import { isValidSlug, type Identity, type NewFlags, remoteIdentityClash, resolveIdentityKey, resolveNew } from "../resolve.ts"
import { Config, type ZwtConfig } from "../services/Config.ts"
import { Git } from "../services/Git.ts"
import { Prompt } from "../services/Prompt.ts"

export type NewResult =
  | { readonly _tag: "Created"; readonly path: string; readonly branch: string; readonly base: string; readonly email: string }
  | { readonly _tag: "Exists"; readonly path: string; readonly branch: string }

const excludeFile = (repoRoot: string, gitPath: string) =>
  gitPath.startsWith("/") ? gitPath : `${repoRoot}/${gitPath}`

const ensureScratchExcluded = (repoRoot: string, pattern: string) =>
  Effect.gen(function*() {
    const located = yield* (yield* Git).gitPath("info/exclude", repoRoot)
    const file = excludeFile(repoRoot, located)
    const fs = yield* FileSystem.FileSystem
    const current = yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed("")
      )
    )
    const next = appendExcludeLine(current, pattern)
    if (next === undefined) return
    yield* fs.writeFileString(file, next)
  })

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
    return { identity: named, key: chosen }
  })

const enforceRemoteIdentity = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly identityKey: string | undefined
  readonly email: string
  readonly strict: boolean
}) =>
  Effect.gen(function*() {
    if ((options.config.remote?.length ?? 0) === 0) return
    const origin = Option.getOrUndefined(yield* (yield* Git).originUrl(options.repoRoot))
    if (origin === undefined) return
    const clash = remoteIdentityClash({
      config: options.config,
      origin,
      identityKey: options.identityKey,
      email: options.email
    })
    if (clash === undefined) return
    const error = new RemoteIdentityMismatch({
      repo: options.repoRoot,
      origin,
      pattern: clash.pattern,
      required: clash.required,
      actual: clash.actual
    })
    if (options.strict) return yield* error
    yield* Console.error(`warning: ${error.message}\n  fix: ${error.fix}`)
  })

/** `zwt new <slug>`: resolve the plan from zwt.toml, then create (or report) the worktree. */
export const newWorktree = (options: {
  readonly slug: string
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly flags: NewFlags
  readonly interactive: boolean
  readonly strict: boolean
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, flags, home, interactive, slug, strict } = options
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

    const selected = plan.identity._tag === "Resolved"
      ? {
        identity: plan.identity.identity,
        key: resolveIdentityKey({ config: loaded, repoRoot, home, flags })
      }
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

    yield* enforceRemoteIdentity({
      config: loaded,
      repoRoot,
      identityKey: selected.key,
      email: selected.identity.email,
      strict
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
    yield* applyWorktreeIdentity({ git, repoRoot, worktreePath: plan.worktreePath, identity: selected.identity })
    // Exists returns above and stays a no-op. Only a worktree this call just created updates exclude.
    yield* ensureScratchExcluded(repoRoot, plan.scratchDir)
    return {
      _tag: "Created",
      path: plan.worktreePath,
      branch: plan.branch,
      base,
      email: selected.identity.email
    } satisfies NewResult
  })
