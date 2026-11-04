import { Console, Effect, Layer, Option } from "effect"
import { Command, Flag, GlobalFlag } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { Config, defaultConfigPath } from "./services/Config.ts"
import { DryRunLog, renderPlan } from "./services/DryRun.ts"
import { dryRunFileSystem } from "./services/FileSystem.ts"
import { Git } from "./services/Git.ts"
import { Prompt } from "./services/Prompt.ts"

export const DryRun = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(Flag.withDescription("print planned writes instead of running them"), Flag.withDefault(false))
})

const liveServices = Layer.mergeAll(Git.live, Config.live, Prompt.live, DryRunLog.layer)

const dryRunServices = Layer.mergeAll(Git.dryRun, Config.live, Prompt.live).pipe(
  Layer.provideMerge(dryRunFileSystem),
  Layer.provideMerge(DryRunLog.layer)
)

export const services = Layer.unwrap(
  Effect.gen(function*() {
    return (yield* DryRun) ? dryRunServices : liveServices
  })
)

const reportPlan = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const result = yield* self
    if (yield* DryRun) {
      const log = yield* DryRunLog
      yield* Console.log(renderPlan(yield* log.planned))
    }
    return result
  })

const configCheck = Command.make(
  "check",
  {
    config: Flag.String("config").pipe(Flag.withDescription("path to zwt.toml"), Flag.optional)
  },
  ({ config }) =>
    Effect.gen(function*() {
      const file = Option.getOrElse(config, () => defaultConfigPath(process.env))
      const loaded = yield* (yield* Config).load(file)
      const identities = Object.keys(loaded.identity).length
      const profiles = loaded.profile?.length ?? 0
      yield* Console.log(`ok ${file}: ${identities} identities, ${profiles} profiles`)
    }).pipe(reportPlan)
).pipe(Command.withDescription("validate zwt.toml"), Command.provide(services))

const configCommand = Command.make("config").pipe(
  Command.withDescription("inspect zwt configuration"),
  Command.withSubcommands([configCheck])
)

export const zwt = Command.make("zwt").pipe(
  Command.withDescription("git worktree helper"),
  Command.withSubcommands([configCommand]),
  Command.withGlobalFlags([DryRun])
)

export const run = Command.run(zwt, { version: pkg.version })
