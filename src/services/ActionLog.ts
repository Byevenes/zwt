import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"
import { actionLogPath, appendCapped, maxActionLogBytes, parseActionLog, type ActionEntry } from "../action-log.ts"
import { ActionLogUnreadable } from "../errors.ts"

let tmpSeq = 0

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const errorDetail = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    const flat = error.message.replace(/\s+/g, " ").trim()
    if (flat.length > 0) return flat
  }
  return "unknown error"
}

const readExisting = (file: string) =>
  Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (error) => error
  }).pipe(Effect.catch((error) => isEnoent(error) ? Effect.succeed("") : Effect.fail(error)))

const writeAtomic = (file: string, contents: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`
      try {
        await writeFile(tmp, contents, "utf8")
        await rename(tmp, file)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined)
        throw error
      }
    },
    catch: (error) => error
  })

const service = (file: string, maxBytes: number) => ({
  record: (action: { readonly command: string; readonly result: string }) =>
    readExisting(file).pipe(
      Effect.flatMap((existing) =>
        writeAtomic(file, appendCapped(existing, {
          timestamp: new Date().toISOString(),
          command: action.command,
          result: action.result
        }, maxBytes))
      ),
      Effect.catch((error: unknown) =>
        // stderr, not the caller's error channel: a log failure must not replace a git or file error.
        Effect.sync(() => {
          process.stderr.write(`warning: could not write action log ${file}: ${errorDetail(error)}\n`)
        })
      ),
      Effect.asVoid
    ),
  entries: readExisting(file).pipe(
    Effect.map(parseActionLog),
    Effect.mapError((error) => new ActionLogUnreadable({ file, detail: errorDetail(error) }))
  )
})

/** Local JSONL of real writes. This service only appends that file. */
export class ActionLog extends Context.Service<ActionLog, {
  readonly record: (action: { readonly command: string; readonly result: string }) => Effect.Effect<void>
  readonly entries: Effect.Effect<ReadonlyArray<ActionEntry>, ActionLogUnreadable>
}>()("zwt/ActionLog") {
  static readonly layer = (file: string, maxBytes = maxActionLogBytes) => Layer.succeed(ActionLog, service(file, maxBytes))

  static readonly live = Layer.unwrap(
    Effect.sync(() => ActionLog.layer(actionLogPath(process.env)))
  )
}
