import { execFile } from "node:child_process"
import { Context, Effect, Layer, Option } from "effect"
import { BranchNotFound, GitCommandFailed } from "../errors.ts"
import { DryRunLog } from "./DryRun.ts"

export interface GitShape {
  readonly run: (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<string, GitCommandFailed>
  readonly configGet: (key: string, cwd: string) => Effect.Effect<Option.Option<string>, GitCommandFailed>
  readonly requireBranch: (branch: string, cwd: string) => Effect.Effect<void, BranchNotFound | GitCommandFailed>
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

const fromRunner = (
  run: GitShape["run"],
  addWorktree: (runner: GitShape["run"]) => GitShape["addWorktree"]
): GitShape => ({
  run,
  configGet: (key, cwd) =>
    run(["config", "--get", key], cwd).pipe(
      Effect.map(Option.some),
      Effect.catchIf((e) => e.exitCode === 1, () => Effect.succeed(Option.none()))
    ),
  requireBranch: (branch, cwd) =>
    run(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], cwd).pipe(
      Effect.asVoid,
      Effect.catchIf((e) => e.exitCode === 1, () => Effect.fail(new BranchNotFound({ branch, repo: cwd })))
    ),
  addWorktree: addWorktree(run)
})

const liveAddWorktree = (run: GitShape["run"]): GitShape["addWorktree"] => ({ cwd, path, branch, base }) =>
  run(["worktree", "add", "-b", branch, path, base], cwd).pipe(Effect.asVoid)

export class Git extends Context.Service<Git, GitShape>()("zwt/Git") {
  static readonly live = Layer.succeed(Git, fromRunner(exec, liveAddWorktree))

  static readonly dryRun = Layer.effect(
    Git,
    Effect.gen(function*() {
      const log = yield* DryRunLog
      return fromRunner(exec, () => ({ cwd, path, branch, base }) =>
        log.record({ kind: "git", description: `git -C ${cwd} worktree add -b ${branch} ${path} ${base}` }))
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
    return { calls, layer: Layer.succeed(Git, fromRunner(run, liveAddWorktree)) }
  }
}
