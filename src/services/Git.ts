import { execFile } from "node:child_process"
import { Context, Effect, Layer, Option } from "effect"
import { BranchNotFound, GitCommandFailed } from "../errors.ts"
import { DryRunLog } from "./DryRun.ts"

export interface GitShape {
  readonly run: (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<string, GitCommandFailed>
  readonly configGet: (key: string, cwd: string) => Effect.Effect<Option.Option<string>, GitCommandFailed>
  readonly requireBranch: (branch: string, cwd: string) => Effect.Effect<void, BranchNotFound | GitCommandFailed>
  readonly repoRoot: (cwd: string) => Effect.Effect<string, GitCommandFailed>
  readonly refExists: (ref: string, cwd: string) => Effect.Effect<boolean, GitCommandFailed>
  readonly hasRemote: (remote: string, cwd: string) => Effect.Effect<boolean, GitCommandFailed>
  readonly fetch: (remote: string, branch: string, cwd: string) => Effect.Effect<void, GitCommandFailed>
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
      Effect.catchIf((e) => e.exitCode === 1, () => Effect.succeed(Option.none()))
    ),
  requireBranch: (branch, cwd) =>
    read(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], cwd).pipe(
      Effect.asVoid,
      Effect.catchIf((e) => e.exitCode === 1, () => Effect.fail(new BranchNotFound({ branch, repo: cwd })))
    ),
  repoRoot: (cwd) => read(["rev-parse", "--show-toplevel"], cwd),
  refExists: (ref, cwd) =>
    read(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).pipe(
      Effect.as(true),
      Effect.catchIf((e) => e.exitCode === 1, () => Effect.succeed(false))
    ),
  hasRemote: (remote, cwd) => read(["remote"], cwd).pipe(Effect.map((out) => out.split("\n").includes(remote))),
  fetch: (remote, branch, cwd) => write(["fetch", "--quiet", remote, branch], cwd).pipe(Effect.asVoid),
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
      return fromRunner(exec, (args, cwd) =>
        log.record({ kind: "git", description: `git -C ${cwd} ${args.join(" ")}` }).pipe(Effect.as("")))
    })
  )

  static readonly fake = (responses: Readonly<Record<string, string | GitCommandFailed>>) => {
    const calls: Array<ReadonlyArray<string>> = []
    const run: GitShape["run"] = (args) => {
      calls.push(args)
      const response = responses[args.join(" ")]
      if (response === undefined) {
        return Effect.fail(new GitCommandFailed({ args, exitCode: 128, stderr: "fake git: no response" }))
      }
      return typeof response === "string" ? Effect.succeed(response) : Effect.fail(response)
    }
    return { calls, layer: Layer.succeed(Git, fromRunner(run, run)) }
  }
}
