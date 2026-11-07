import { Effect, Option } from "effect"
import { CommandUnset, InvalidSlug, WorktreeNotFound } from "../errors.ts"
import {
  formatLaunch,
  isValidSlug,
  launchArgv,
  launchCommandKey,
  resolveLaunchCommand,
  resolveNew,
  type LaunchKind,
  type NewFlags
} from "../resolve.ts"
import { Config } from "../services/Config.ts"
import { Git } from "../services/Git.ts"
import { Launch, type LaunchRequest } from "../services/Launch.ts"

const emptyFlags: NewFlags = {
  base: Option.none(),
  prefix: Option.none(),
  email: Option.none(),
  identity: Option.none()
}

const loadedRepo = (options: { readonly cwd: string; readonly configFile: string }) =>
  Effect.gen(function*() {
    const loaded = yield* (yield* Config).load(options.configFile)
    const repoRoot = yield* (yield* Git).repoRoot(options.cwd)
    return { loaded, repoRoot }
  })

export const requireLaunchCommand = (options: {
  readonly kind: LaunchKind
  readonly cwd: string
  readonly home: string
  readonly configFile: string
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, home, kind } = options
    const { loaded, repoRoot } = yield* loadedRepo({ cwd, configFile })
    const command = resolveLaunchCommand({ config: loaded, repoRoot, home, kind })
    if (command === undefined) {
      return yield* new CommandUnset({ key: launchCommandKey(kind), repo: repoRoot, file: configFile })
    }
    return command
  })

const requestFor = (options: {
  readonly command: string
  readonly kind: LaunchKind
  readonly worktreePath: string
  readonly file: string
}): LaunchRequest => {
  const argv = launchArgv(options.command, options.kind, options.worktreePath)
  return {
    argv,
    cwd: options.worktreePath,
    display: formatLaunch(options.kind, argv, options.worktreePath),
    key: launchCommandKey(options.kind),
    file: options.file
  }
}

export const runLaunch = (options: {
  readonly kind: LaunchKind
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly worktreePath: string
}) =>
  Effect.gen(function*() {
    const command = yield* requireLaunchCommand(options)
    yield* (yield* Launch).run(requestFor({
      command,
      kind: options.kind,
      worktreePath: options.worktreePath,
      file: options.configFile
    }))
  })

/** `--open` checks the profile command before `zwt new` writes. An invalid slug is left to `newWorktree`. */
export const prepareOpen = (options: {
  readonly slug: string
  readonly cwd: string
  readonly home: string
  readonly configFile: string
}) =>
  Effect.gen(function*() {
    if (!isValidSlug(options.slug)) return
    yield* requireLaunchCommand({
      kind: "open",
      cwd: options.cwd,
      home: options.home,
      configFile: options.configFile
    }).pipe(Effect.asVoid)
  })

export const finishOpen = (options: {
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly worktreePath: string
}) => runLaunch({ kind: "open", ...options })

/** `zwt open` / `zwt agent`: the branch is the one `zwt new <slug>` would use without flags. */
export const launchInWorktree = (options: {
  readonly kind: LaunchKind
  readonly slug: string
  readonly cwd: string
  readonly home: string
  readonly configFile: string
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, home, kind, slug } = options
    if (!isValidSlug(slug)) return yield* new InvalidSlug({ slug })
    const { loaded, repoRoot } = yield* loadedRepo({ cwd, configFile })
    const plan = resolveNew({ config: loaded, repoRoot, slug, home, flags: emptyFlags })
    const existing = yield* (yield* Git).worktreeForBranch(plan.branch, repoRoot)
    if (Option.isNone(existing)) return yield* new WorktreeNotFound({ branch: plan.branch, repo: repoRoot, slug })
    yield* runLaunch({ kind, cwd, home, configFile, worktreePath: existing.value })
    return { path: existing.value, branch: plan.branch }
  })
