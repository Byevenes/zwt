import { resolve as resolvePath } from "node:path"
import { Console, Effect, Option } from "effect"
import { ConfirmationRequired, IdentityMismatch, IdentityUnresolved, UnknownIdentity } from "../errors.ts"
import { expandHome, resolveIdentity, type Identity } from "../resolve.ts"
import { Config } from "../services/Config.ts"
import { Git, type GitShape } from "../services/Git.ts"
import { canPrompt, Prompt } from "../services/Prompt.ts"

const trimSlash = (path: string) => path.replace(/\/+$/, "")

const includeIfHint =
  "zwt does not write includeIf; add a gitdir include by hand if this email should apply outside the worktree"

export const interactiveSession = (): boolean => canPrompt({ ci: process.env.CI, stdinIsTTY: process.stdin.isTTY === true })

const blankFlags = { email: Option.none<string>(), identity: Option.none<string>() }

const normalizeFolder = (path: string, cwd: string, home: string) => trimSlash(resolvePath(cwd, expandHome(path, home)))

/**
 * A linked worktree inherits the common local email, so a matching value is not proof
 * that this worktree's config.worktree was written.
 */
export const applyWorktreeIdentity = (options: {
  readonly git: GitShape
  readonly repoRoot: string
  readonly worktreePath: string
  readonly identity: Identity
}) =>
  Effect.gen(function*() {
    const { git, identity, repoRoot, worktreePath } = options
    const enabled = yield* git.configGetLocal("extensions.worktreeConfig", repoRoot)
    if (Option.getOrElse(enabled, () => "") !== "true") {
      yield* git.configSet("extensions.worktreeConfig", "true", repoRoot, "local")
    }
    yield* git.configSet("user.name", identity.name, worktreePath, "worktree")
    yield* git.configSet("user.email", identity.email, worktreePath, "worktree")

    const got = Option.getOrElse(yield* git.configGet("user.email", worktreePath), () => "")
    const shown = yield* git.configShowOrigin("user.email", worktreePath)
    const originFile = Option.match(shown, { onNone: () => "", onSome: (origin) => origin.file })
    const originValue = Option.match(shown, { onNone: () => "", onSome: (origin) => origin.value })
    const fromWorktree = originFile.includes("config.worktree")
    if (got !== identity.email || originValue !== identity.email || !fromWorktree) {
      const actual = got === identity.email ? `${got} from ${originFile || "(unset)"}` : (got || "(unset)")
      return yield* new IdentityMismatch({ repo: worktreePath, expected: identity.email, actual })
    }
  })

export const listIdentities = (file: string) =>
  Effect.gen(function*() {
    const config = yield* (yield* Config).load(file)
    const lines = Object.entries(config.identity).map(([key, identity]) => `${key}\t${identity.name}\t${identity.email}`)
    yield* Console.log(lines.length === 0 ? "no identities" : lines.join("\n"))
  })

export type SetResult =
  | { readonly _tag: "Saved"; readonly path: string; readonly identity: string }
  | { readonly _tag: "Declined"; readonly path: string; readonly identity: string }

export const setIdentity = (options: {
  readonly name: string
  readonly path: Option.Option<string>
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly interactive: boolean
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, home, interactive, name } = options
    const config = yield* Config
    const loaded = yield* config.load(configFile)
    if (loaded.identity[name] === undefined) return yield* new UnknownIdentity({ name, file: configFile })
    const start = Option.isSome(options.path) ? normalizeFolder(options.path.value, cwd, home) : cwd
    const path = trimSlash(yield* (yield* Git).repoRoot(start).pipe(
      Effect.catchIf(
        (error) => error.exitCode === 128 && Option.isSome(options.path),
        () => Effect.succeed(start)
      )
    ))
    if (!interactive) return yield* new ConfirmationRequired({ action: "identity set" })
    const save = yield* (yield* Prompt).confirm(`Save identity "${name}" for ${path}?`)
    if (!save) return { _tag: "Declined", path, identity: name } satisfies SetResult
    yield* config.upsertProject(configFile, { path, identity: name, home })
    return { _tag: "Saved", path, identity: name } satisfies SetResult
  })

export const checkIdentity = (options: {
  readonly path: Option.Option<string>
  readonly cwd: string
  readonly home: string
  readonly configFile: string
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, home } = options
    const git = yield* Git
    const start = Option.match(options.path, {
      onNone: () => cwd,
      onSome: (path) => normalizeFolder(path, cwd, home)
    })
    const repoRoot = trimSlash(yield* git.repoRoot(start))
    const loaded = yield* (yield* Config).load(configFile)
    const resolution = resolveIdentity({ config: loaded, repoRoot, home, flags: blankFlags })
    const got = Option.getOrElse(yield* git.configGet("user.email", repoRoot), () => "")
    const shown = yield* git.configShowOrigin("user.email", repoRoot)
    const originFile = Option.match(shown, { onNone: () => "(unset)", onSome: (origin) => origin.file })
    const expected = resolution._tag === "Resolved" ? resolution.identity.email : "(unresolved)"
    yield* Console.log(`effective: ${got || "(unset)"}\norigin: ${originFile}\nexpected: ${expected}`)
    if (resolution._tag === "Unresolved") {
      return yield* new IdentityUnresolved({ repo: repoRoot, file: configFile, reason: "non-interactive" })
    }
    if (got !== expected) {
      return yield* new IdentityMismatch({
        repo: repoRoot,
        expected,
        actual: got || "(unset)",
        hint: includeIfHint
      })
    }
  })
