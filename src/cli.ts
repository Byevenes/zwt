import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag, GlobalFlag } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { runDoctor } from "./commands/doctor.ts"
import { checkIdentity, interactiveSession, listIdentities, setIdentity } from "./commands/identity.ts"
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

const configFlag = Flag.String("config").pipe(Flag.withDescription("path to zwt.toml"), Flag.optional)

const configFile = (config: Option.Option<string>) => Option.getOrElse(config, () => defaultConfigPath(process.env))

const configCheck = Command.make(
  "check",
  {
    config: configFlag
  },
  ({ config }) =>
    Effect.gen(function*() {
      const file = configFile(config)
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
    email: Flag.String("email").pipe(Flag.withDescription("git email for this worktree (overrides zwt.toml)"), Flag.optional),
    identity: Flag.String("identity").pipe(Flag.withDescription("identity key from zwt.toml"), Flag.optional),
    strict: Flag.Boolean("strict").pipe(
      Flag.withDescription("fail when origin requires a different identity"),
      Flag.withDefault(false)
    ),
    config: configFlag
  },
  ({ base, config, email, identity, prefix, slug, strict }) =>
    Effect.gen(function*() {
      const result = yield* newWorktree({
        slug,
        cwd: process.cwd(),
        home: process.env.HOME ?? "~",
        configFile: configFile(config),
        interactive: interactiveSession(),
        flags: { base, prefix, email, identity },
        strict
      })
      yield* Console.log(
        result._tag === "Exists"
          ? `exists ${result.path} (branch ${result.branch})`
          : `${(yield* DryRun) ? "would create" : "created"} ${result.path}\n  branch ${result.branch} from ${result.base}, identity ${result.email}`
      )
    }).pipe(reportPlan)
).pipe(Command.withDescription("create a worktree for <slug> from the profile's base branch"), Command.provide(services))

const identityList = Command.make("list", { config: configFlag }, ({ config }) =>
  listIdentities(configFile(config)).pipe(reportPlan)).pipe(
  Command.withDescription("list configured identities"),
  Command.provide(services)
)

const identitySet = Command.make(
  "set",
  {
    name: Argument.String("name").pipe(Argument.withDescription("identity key from zwt.toml")),
    path: Argument.String("path").pipe(Argument.withDescription("folder to map; default is this repo"), Argument.optional),
    config: configFlag
  },
  ({ config, name, path }) =>
    Effect.gen(function*() {
      const result = yield* setIdentity({
        name,
        path,
        cwd: process.cwd(),
        home: process.env.HOME ?? "~",
        configFile: configFile(config),
        interactive: interactiveSession()
      })
      const verb = result._tag === "Declined" ? "not saved" : `${(yield* DryRun) ? "would save" : "saved"} identity ${result.identity} for ${result.path}`
      yield* Console.log(verb)
    }).pipe(reportPlan)
).pipe(Command.withDescription("map a folder to an identity"), Command.provide(services))

const identityCheck = Command.make(
  "check",
  {
    path: Argument.String("path").pipe(Argument.withDescription("repo to inspect; default is this repo"), Argument.optional),
    config: configFlag
  },
  ({ config, path }) =>
    checkIdentity({
      path,
      cwd: process.cwd(),
      home: process.env.HOME ?? "~",
      configFile: configFile(config)
    }).pipe(reportPlan)
).pipe(Command.withDescription("print effective, origin and expected email"), Command.provide(services))

const identityCommand = Command.make("identity").pipe(
  Command.withDescription("git identity for a folder"),
  Command.withSubcommands([identityList, identitySet, identityCheck])
)

const doctorCommand = Command.make(
  "doctor",
  {
    all: Flag.Boolean("all").pipe(Flag.withDescription("audit every configured repo"), Flag.withDefault(false)),
    output: Flag.Literals("output", ["text", "json"]).pipe(
      Flag.withDescription("report format"),
      Flag.withDefault("text" as const)
    ),
    path: Argument.String("path").pipe(Argument.withDescription("repo to inspect; default is this repo"), Argument.optional),
    config: configFlag
  },
  ({ all, config, output, path }) =>
    runDoctor({
      all,
      output,
      path,
      cwd: process.cwd(),
      home: process.env.HOME ?? "~",
      configFile: configFile(config)
    }).pipe(reportPlan)
).pipe(Command.withDescription("audit identity, origin and hooks path"), Command.provide(services))

export const zwt = Command.make("zwt").pipe(
  Command.withDescription("git worktree helper"),
  Command.withSubcommands([configCommand, newCommand, identityCommand, doctorCommand]),
  Command.withGlobalFlags([DryRun])
)

export const run = Command.run(zwt, { version: pkg.version })
