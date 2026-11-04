import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag, GlobalFlag } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { newWorktree } from "./commands/new.ts"
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

const newCommand = Command.make(
  "new",
  {
    slug: Argument.String("slug").pipe(Argument.withDescription("task slug, appended to the branch prefix")),
    base: Flag.String("base").pipe(Flag.withDescription("base branch (overrides zwt.toml)"), Flag.optional),
    prefix: Flag.String("prefix").pipe(Flag.withDescription("branch prefix (overrides zwt.toml)"), Flag.optional),
    config: Flag.String("config").pipe(Flag.withDescription("path to zwt.toml"), Flag.optional)
  },
  ({ base, config, prefix, slug }) =>
    Effect.gen(function*() {
      const result = yield* newWorktree({
        slug,
        cwd: process.cwd(),
        home: process.env.HOME ?? "~",
        configFile: Option.getOrElse(config, () => defaultConfigPath(process.env)),
        flags: { base, prefix }
      })
      yield* Console.log(
        result._tag === "Exists"
          ? `exists ${result.path} (branch ${result.branch})`
          : `${(yield* DryRun) ? "would create" : "created"} ${result.path}\n  branch ${result.branch} from ${result.base}, identity ${result.email}`
      )
    }).pipe(reportPlan)
).pipe(Command.withDescription("create a worktree for <slug> from the profile's base branch"), Command.provide(services))

export const zwt = Command.make("zwt").pipe(
  Command.withDescription("git worktree helper"),
  Command.withSubcommands([configCommand, newCommand]),
  Command.withGlobalFlags([DryRun])
)

export const run = Command.run(zwt, { version: pkg.version })
