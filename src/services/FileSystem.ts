import { Effect, FileSystem, Layer } from "effect"
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
