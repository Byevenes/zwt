import { spawn } from "node:child_process"
import { Context, Console, Effect, Layer } from "effect"
import { CommandFailed, CommandNotFound, type LaunchCommandKey } from "../errors.ts"
import { DryRunLog } from "./DryRun.ts"

export interface LaunchRequest {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly display: string
  readonly key: LaunchCommandKey
  readonly file: string
}

const codeOf = (error: unknown): string | number | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" || typeof code === "number" ? code : undefined
}

const exec = (request: LaunchRequest) =>
  Effect.callback<void, CommandNotFound | CommandFailed>((resume) => {
    const [bin, ...args] = request.argv
    if (bin === undefined || bin.length === 0) {
      resume(Effect.fail(new CommandNotFound({ command: "(empty)", key: request.key, file: request.file })))
      return
    }
    // spawn never invokes a shell. The editor or agent inherits the terminal.
    const child = spawn(bin, args, { cwd: request.cwd, stdio: "inherit" })
    let settled = false
    const finish = (result: Effect.Effect<void, CommandNotFound | CommandFailed>) => {
      if (settled) return
      settled = true
      resume(result)
    }
    child.on("error", (error: unknown) => {
      const code = codeOf(error)
      finish(
        code === "ENOENT" || code === "EACCES"
          ? Effect.fail(new CommandNotFound({ command: bin, key: request.key, file: request.file }))
          : Effect.fail(new CommandFailed({ command: request.display, exitCode: typeof code === "number" ? code : -1 }))
      )
    })
    child.on("exit", (code) => {
      finish(code === 0 ? Effect.void : Effect.fail(new CommandFailed({ command: request.display, exitCode: code ?? -1 })))
    })
    return Effect.sync(() => {
      child.kill()
    })
  })

export class Launch extends Context.Service<Launch, {
  readonly run: (request: LaunchRequest) => Effect.Effect<void, CommandNotFound | CommandFailed>
}>()("zwt/Launch") {
  static readonly live = Layer.succeed(Launch, {
    run: (request) =>
      Effect.gen(function*() {
        yield* Console.log(request.display)
        yield* exec(request)
      })
  })

  static readonly dryRun = Layer.effect(
    Launch,
    Effect.gen(function*() {
      const log = yield* DryRunLog
      return {
        run: (request: LaunchRequest) => log.record({ kind: "exec", description: request.display })
      }
    })
  )

  static readonly recording = () => {
    const calls: Array<LaunchRequest> = []
    return {
      calls,
      layer: Layer.succeed(Launch, {
        run: (request) => Effect.sync(() => {
          calls.push(request)
        })
      })
    }
  }
}
