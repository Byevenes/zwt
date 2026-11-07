import { Effect, FileSystem, Layer } from "effect"
import { actionResult } from "../action-log.ts"
import { ActionLog } from "./ActionLog.ts"
import { DryRunLog } from "./DryRun.ts"

export const dryRunFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const log = yield* DryRunLog
    const plan = (description: string) => log.record({ kind: "fs", description })
    return {
      ...fs,
      writeFileString: (path: string) => plan(`write ${path}`),
      writeFile: (path: string) => plan(`write ${path}`),
      makeDirectory: (path: string) => plan(`mkdir ${path}`),
      remove: (path: string) => plan(`remove ${path}`)
    }
  })
)

/** Same writes dry-run plans. Each one that really runs is appended to the local action log. */
export const loggingFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const actions = yield* ActionLog
    const tracked = <A, E>(command: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.tap(() => actions.record({ command, result: "ok" })),
        Effect.tapError((error) => actions.record({ command, result: actionResult(error) }))
      )
    return {
      ...fs,
      writeFileString: (...args: Parameters<typeof fs.writeFileString>) =>
        tracked(`write ${args[0]}`, fs.writeFileString(...args)),
      writeFile: (...args: Parameters<typeof fs.writeFile>) => tracked(`write ${args[0]}`, fs.writeFile(...args)),
      makeDirectory: (...args: Parameters<typeof fs.makeDirectory>) => tracked(`mkdir ${args[0]}`, fs.makeDirectory(...args)),
      remove: (...args: Parameters<typeof fs.remove>) => tracked(`remove ${args[0]}`, fs.remove(...args))
    }
  })
)
