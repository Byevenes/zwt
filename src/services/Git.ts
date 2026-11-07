import { execFile } from "node:child_process"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { BranchNotFound, GitCommandFailed } from "../errors.ts"
import { DryRunLog } from "./DryRun.ts"

/** `global` is not a scope. This slice never writes it. */
export type GitConfigScope = "local" | "worktree"

export interface ConfigOrigin {
  readonly file: string
  readonly value: string
}

export const parseConfigOrigin = (output: string): Option.Option<ConfigOrigin> => {
  const line = output.split("\n").find((entry) => entry.startsWith("file:"))
  if (line === undefined) return Option.none()
  const tab = line.indexOf("\t")
  if (tab < 0) return Option.none()
  return Option.some({ file: line.slice("file:".length, tab), value: line.slice(tab + 1).trim() })
}

export interface GitShape {
  readonly run: (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<string, GitCommandFailed>
  readonly configGet: (key: string, cwd: string) => Effect.Effect<Option.Option<string>, GitCommandFailed>
  readonly configGetLocal: (key: string, cwd: string) => Effect.Effect<Option.Option<string>, GitCommandFailed>
  readonly configShowOrigin: (key: string, cwd: string) => Effect.Effect<Option.Option<ConfigOrigin>, GitCommandFailed>
  readonly configSet: (key: string, value: string, cwd: string, scope: GitConfigScope) => Effect.Effect<void, GitCommandFailed>
  readonly requireBranch: (branch: string, cwd: string) => Effect.Effect<void, BranchNotFound | GitCommandFailed>
  readonly repoRoot: (cwd: string) => Effect.Effect<string, GitCommandFailed>
  readonly gitPath: (path: string, cwd: string) => Effect.Effect<string, GitCommandFailed>
  readonly refExists: (ref: string, cwd: string) => Effect.Effect<boolean, GitCommandFailed>
  readonly hasRemote: (remote: string, cwd: string) => Effect.Effect<boolean, GitCommandFailed>
  readonly originUrl: (cwd: string) => Effect.Effect<Option.Option<string>, GitCommandFailed>
  readonly fetch: (remote: string, branch: string, cwd: string) => Effect.Effect<void, GitCommandFailed>
  readonly commitOf: (ref: string, cwd: string) => Effect.Effect<Option.Option<string>, GitCommandFailed>
  readonly isAncestor: (ancestor: string, descendant: string, cwd: string) => Effect.Effect<boolean, GitCommandFailed>
  /**
   * Move `refs/heads/<branch>` to `source` only when that is a fast-forward.
   * No leading `+`. Git refuses while the branch is checked out and leaves the working tree alone.
   */
  readonly fastForwardBranch: (branch: string, source: string, cwd: string) => Effect.Effect<void, GitCommandFailed>
  readonly worktreeForBranch: (branch: string, cwd: string) => Effect.Effect<Option.Option<string>, GitCommandFailed>
  readonly addWorktree: (options: {
    readonly cwd: string
    readonly path: string
    readonly branch: string
    readonly base: string
  }) => Effect.Effect<void, GitCommandFailed>
}

const repoScopedEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))

const exec = (args: ReadonlyArray<string>, cwd: string) =>
  Effect.callback<string, GitCommandFailed>((resume) => {
    execFile("git", [...args], { cwd, env: repoScopedEnv() }, (error, stdout, stderr) => {
      if (error === null) {
        resume(Effect.succeed(stdout.trimEnd()))
        return
      }
      const exitCode = typeof error.code === "number" ? error.code : -1
      resume(Effect.fail(new GitCommandFailed({ args, exitCode, stderr: stderr || error.message })))
    })
  })

export const parseWorktreeList = (porcelain: string, branch: string): Option.Option<string> => {
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n")
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    if (path !== undefined && lines.includes(`branch refs/heads/${branch}`)) return Option.some(path)
  }
  return Option.none()
}

/** Reads always run `read`; anything that changes the repo goes through `write`. */
const fromRunner = (read: GitShape["run"], write: GitShape["run"]): GitShape => ({
  run: read,
  configGet: (key, cwd) =>
    read(["config", "--get", key], cwd).pipe(
      Effect.map(Option.some),
      Effect.catchIf((error) => error.exitCode === 1, () => Effect.succeed(Option.none()))
    ),
  configGetLocal: (key, cwd) =>
    read(["config", "--local", "--get", key], cwd).pipe(
      Effect.map(Option.some),
      Effect.catchIf((error) => error.exitCode === 1, () => Effect.succeed(Option.none()))
    ),
  configShowOrigin: (key, cwd) =>
    read(["config", "--show-origin", "--get", key], cwd).pipe(
      Effect.map(parseConfigOrigin),
      Effect.catchIf((error) => error.exitCode === 1, () => Effect.succeed(Option.none()))
    ),
  configSet: (key, value, cwd, scope) =>
    write(["config", scope === "worktree" ? "--worktree" : "--local", key, value], cwd).pipe(Effect.asVoid),
  requireBranch: (branch, cwd) =>
    read(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], cwd).pipe(
      Effect.asVoid,
      Effect.catchIf((e) => e.exitCode === 1, () => Effect.fail(new BranchNotFound({ branch, repo: cwd })))
    ),
  repoRoot: (cwd) => read(["rev-parse", "--show-toplevel"], cwd),
  gitPath: (path, cwd) => read(["rev-parse", "--git-path", path], cwd),
  refExists: (ref, cwd) =>
    read(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).pipe(
      Effect.as(true),
      Effect.catchIf((e) => e.exitCode === 1, () => Effect.succeed(false))
    ),
  hasRemote: (remote, cwd) => read(["remote"], cwd).pipe(Effect.map((out) => out.split("\n").includes(remote))),
  originUrl: (cwd) =>
    read(["remote", "get-url", "origin"], cwd).pipe(
      Effect.map((url) => url.length === 0 ? Option.none() : Option.some(url)),
      Effect.catchIf((error) => error.exitCode === 2, () => Effect.succeed(Option.none()))
    ),
  fetch: (remote, branch, cwd) => write(["fetch", "--quiet", remote, branch], cwd).pipe(Effect.asVoid),
  commitOf: (ref, cwd) =>
    read(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).pipe(
      Effect.map((oid) => oid.length === 0 ? Option.none() : Option.some(oid)),
      Effect.catchIf((error) => error.exitCode === 1, () => Effect.succeed(Option.none()))
    ),
  isAncestor: (ancestor, descendant, cwd) =>
    read(["merge-base", "--is-ancestor", ancestor, descendant], cwd).pipe(
      Effect.as(true),
      Effect.catchIf((error) => error.exitCode === 1, () => Effect.succeed(false))
    ),
  fastForwardBranch: (branch, source, cwd) =>
    write(["fetch", "--quiet", ".", `${source}:refs/heads/${branch}`], cwd).pipe(Effect.asVoid),
  worktreeForBranch: (branch, cwd) =>
    read(["worktree", "list", "--porcelain"], cwd).pipe(Effect.map((out) => parseWorktreeList(out, branch))),
  addWorktree: ({ cwd, path, branch, base }) => write(["worktree", "add", "-b", branch, path, base], cwd).pipe(Effect.asVoid)
})

export class Git extends Context.Service<Git, GitShape>()("zwt/Git") {
  static readonly live = Layer.succeed(Git, fromRunner(exec, exec))

  static readonly dryRun = Layer.effect(
    Git,
    Effect.gen(function*() {
      const log = yield* DryRunLog
      const overlay = yield* Ref.make(new Map<string, string>())
      const remember = (args: ReadonlyArray<string>, cwd: string) => {
        const scope = args[1] === "--worktree" ? "worktree" : args[1] === "--local" ? "local" : undefined
        const key = args[2]
        const value = args[3]
        if (args[0] !== "config" || scope === undefined || key === undefined || value === undefined || key.startsWith("--")) {
          return Effect.void
        }
        return Ref.update(overlay, (map) => {
          const next = new Map(map)
          next.set(`${scope}\0${cwd}\0${key}`, value)
          return next
        })
      }
      const recall = (args: ReadonlyArray<string>, cwd: string) =>
        Ref.get(overlay).pipe(Effect.map((map) => {
          const key = args[args.length - 1]
          if (key === undefined) return undefined
          if (args[1] === "--show-origin") {
            const value = map.get(`worktree\0${cwd}\0${key}`)
            return value === undefined ? undefined : `file:${cwd}/.git/config.worktree\t${value}`
          }
          if (args[1] === "--local" && args[2] === "--get") return map.get(`local\0${cwd}\0${key}`)
          if (args[1] === "--get") return map.get(`worktree\0${cwd}\0${key}`) ?? map.get(`local\0${cwd}\0${key}`)
          return undefined
        }))
      return fromRunner(
        (args, cwd) =>
          Effect.gen(function*() {
            const hit = yield* recall(args, cwd)
            return hit !== undefined ? hit : yield* exec(args, cwd)
          }),
        (args, cwd) =>
          log.record({ kind: "git", description: `git -C ${cwd} ${args.join(" ")}` }).pipe(
            Effect.andThen(remember(args, cwd)),
            Effect.as("")
          )
      )
    })
  )

  static readonly fake = (responses: Readonly<Record<string, string | GitCommandFailed>>) => {
    const calls: Array<ReadonlyArray<string>> = []
    const run: GitShape["run"] = (args, cwd) => {
      calls.push(args)
      const response = responses[`${cwd}\0${args.join(" ")}`] ?? responses[args.join(" ")]
      if (response === undefined) {
        return Effect.fail(new GitCommandFailed({ args, exitCode: 128, stderr: "fake git: no response" }))
      }
      return typeof response === "string" ? Effect.succeed(response) : Effect.fail(response)
    }
    return { calls, layer: Layer.succeed(Git, fromRunner(run, run)) }
  }
}
