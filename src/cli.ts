import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag, GlobalFlag } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { runDoctor } from "./commands/doctor.ts"
import { checkIdentity, interactiveSession, listIdentities, setIdentity } from "./commands/identity.ts"
import { initConfig } from "./commands/init.ts"
import { finishOpen, launchInWorktree, prepareOpen } from "./commands/launch.ts"
import { showLog } from "./commands/log.ts"
import { newWorktree } from "./commands/new.ts"
import { type LaunchKind } from "./resolve.ts"
import { runStatus } from "./commands/status.ts"
import { renderSyncTable, syncFailure, syncRepos } from "./commands/sync.ts"
import { listWorktrees, pruneMerged, removeWorktreeBySlug, renderList, renderPrune, renderRemoval, type RemovalVerbs } from "./commands/worktrees.ts"
import { ActionLog } from "./services/ActionLog.ts"
import { Config, defaultConfigPath } from "./services/Config.ts"
import { DryRunLog, renderPlan } from "./services/DryRun.ts"
import { dryRunFileSystem, loggingFileSystem } from "./services/FileSystem.ts"
import { Git } from "./services/Git.ts"
import { Launch } from "./services/Launch.ts"
import { Prompt } from "./services/Prompt.ts"

export const DryRun = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(Flag.withDescription("print planned writes instead of running them"), Flag.withDefault(false))
})

const liveServices = Layer.mergeAll(Git.logging, Config.live, Prompt.live, Launch.live, DryRunLog.layer).pipe(
  Layer.provideMerge(loggingFileSystem),
  Layer.provideMerge(ActionLog.live)
)

const dryRunServices = Layer.mergeAll(Git.dryRun, Config.live, Prompt.live, Launch.dryRun).pipe(
  Layer.provideMerge(dryRunFileSystem),
  Layer.provideMerge(DryRunLog.layer),
  Layer.provideMerge(ActionLog.live)
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

const launchVerb = (kind: LaunchKind, dry: boolean): string => {
  switch (kind) {
    case "open":
      return dry ? "would open" : "opened"
    case "agent":
      return dry ? "would start" : "started"
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

const launchDescription = (kind: LaunchKind): string => {
  switch (kind) {
    case "open":
      return "run the profile open_command with the worktree path"
    case "agent":
      return "run the profile agent_command in the worktree"
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

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
    slug: Argument.String("slug").pipe(
      Argument.withDescription("task slug; a leading ticket key fills {ticket} when branch_template is set")
    ),
    base: Flag.String("base").pipe(Flag.withDescription("base branch (overrides zwt.toml)"), Flag.optional),
    prefix: Flag.String("prefix").pipe(
      Flag.withDescription("branch prefix; skips branch_template and overrides zwt.toml"),
      Flag.optional
    ),
    email: Flag.String("email").pipe(Flag.withDescription("git email for this worktree (overrides zwt.toml)"), Flag.optional),
    identity: Flag.String("identity").pipe(Flag.withDescription("identity key from zwt.toml"), Flag.optional),
    strict: Flag.Boolean("strict").pipe(
      Flag.withDescription("fail when origin requires a different identity"),
      Flag.withDefault(false)
    ),
    open: Flag.Boolean("open").pipe(
      Flag.withDescription("run the profile open_command in the worktree"),
      Flag.withDefault(false)
    ),
    config: configFlag
  },
  ({ base, config, email, identity, open, prefix, slug, strict }) =>
    Effect.gen(function*() {
      const cwd = process.cwd()
      const home = process.env.HOME ?? "~"
      const file = configFile(config)
      if (open) yield* prepareOpen({ slug, cwd, home, configFile: file })
      const result = yield* newWorktree({
        slug,
        cwd,
        home,
        configFile: file,
        interactive: interactiveSession(),
        flags: { base, prefix, email, identity },
        strict
      })
      yield* Console.log(
        result._tag === "Exists"
          ? `exists ${result.path} (branch ${result.branch})`
          : `${(yield* DryRun) ? "would create" : "created"} ${result.path}\n  branch ${result.branch} from ${result.base}, identity ${result.email}`
      )
      if (!open) return
      yield* finishOpen({ cwd, home, configFile: file, worktreePath: result.path })
      yield* Console.log(`${launchVerb("open", yield* DryRun)} ${result.path}`)
    }).pipe(reportPlan)
).pipe(Command.withDescription("create a worktree for <slug> from the profile's base branch"), Command.provide(services))

const worktreeLaunch = (kind: LaunchKind) =>
  Command.make(
    kind,
    {
      slug: Argument.String("slug").pipe(Argument.withDescription("task slug; the branch matches zwt new without flags")),
      config: configFlag
    },
    ({ config, slug }) =>
      Effect.gen(function*() {
        const result = yield* launchInWorktree({
          kind,
          slug,
          cwd: process.cwd(),
          home: process.env.HOME ?? "~",
          configFile: configFile(config)
        })
        yield* Console.log(`${launchVerb(kind, yield* DryRun)} ${result.path}`)
      }).pipe(reportPlan)
  ).pipe(Command.withDescription(launchDescription(kind)), Command.provide(services))

const openCommand = worktreeLaunch("open")
const agentCommand = worktreeLaunch("agent")

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

const syncCommand = Command.make("sync", { config: configFlag }, ({ config }) =>
  Effect.gen(function*() {
    const rows = yield* Effect.gen(function*() {
      const found = yield* syncRepos({
        home: process.env.HOME ?? "~",
        configFile: configFile(config)
      })
      yield* Console.log(renderSyncTable(found))
      return found
    }).pipe(reportPlan)
    const failure = syncFailure(rows)
    if (failure !== undefined) return yield* failure
  })).pipe(
  Command.withDescription("fetch and fast-forward the base branch of every configured repo"),
  Command.provide(services)
)

const statusCommand = Command.make(
  "status",
  {
    all: Flag.Boolean("all").pipe(Flag.withDescription("list worktrees of every configured repo"), Flag.withDefault(false)),
    output: Flag.Literals("output", ["text", "json"]).pipe(
      Flag.withDescription("report format"),
      Flag.withDefault("text" as const)
    ),
    path: Argument.String("path").pipe(Argument.withDescription("repo to inspect; default is this repo"), Argument.optional),
    config: configFlag
  },
  ({ all, config, output, path }) =>
    runStatus({
      all,
      output,
      path,
      cwd: process.cwd(),
      home: process.env.HOME ?? "~",
      configFile: configFile(config),
      nowMs: Date.now()
    }).pipe(reportPlan)
).pipe(
  Command.withDescription("show branch, ahead/behind base, dirty state, and days since activity"),
  Command.provide(services)
)

const removalVerbs = (dry: boolean): RemovalVerbs => ({
  removed: dry ? "would remove" : "removed",
  deleted: dry ? "would delete branch" : "deleted branch"
})

const listCommand = Command.make("list", { config: configFlag }, ({ config }) =>
  Effect.gen(function*() {
    const rows = yield* listWorktrees({
      cwd: process.cwd(),
      home: process.env.HOME ?? "~",
      configFile: configFile(config)
    })
    yield* Console.log(renderList(rows))
  }).pipe(reportPlan)).pipe(
  Command.withDescription("list worktrees with branch, merged and dirty"),
  Command.provide(services)
)

const pruneCommand = Command.make(
  "prune",
  {
    merged: Flag.Boolean("merged").pipe(
      Flag.withDescription("remove clean worktrees whose branch is merged into the base"),
      Flag.withDefault(false)
    ),
    deleteBranch: Flag.Boolean("delete-branch").pipe(
      Flag.withDescription("delete the local branch after removing its worktree"),
      Flag.withDefault(false)
    ),
    config: configFlag
  },
  ({ config, deleteBranch, merged }) =>
    Effect.gen(function*() {
      const items = yield* pruneMerged({
        cwd: process.cwd(),
        home: process.env.HOME ?? "~",
        configFile: configFile(config),
        merged,
        deleteBranch
      })
      yield* Console.log(renderPrune(items, removalVerbs(yield* DryRun)))
    }).pipe(reportPlan)
).pipe(Command.withDescription("remove clean worktrees merged into the base"), Command.provide(services))

const rmCommand = Command.make(
  "rm",
  {
    slug: Argument.String("slug").pipe(Argument.withDescription("task slug of the worktree to remove")),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("remove a dirty or unmerged worktree"),
      Flag.withDefault(false)
    ),
    deleteBranch: Flag.Boolean("delete-branch").pipe(
      Flag.withDescription("delete the local branch after removing its worktree"),
      Flag.withDefault(false)
    ),
    config: configFlag
  },
  ({ config, deleteBranch, force, slug }) =>
    Effect.gen(function*() {
      const result = yield* removeWorktreeBySlug({
        slug,
        cwd: process.cwd(),
        home: process.env.HOME ?? "~",
        configFile: configFile(config),
        force,
        deleteBranch
      })
      yield* Console.log(renderRemoval(result, removalVerbs(yield* DryRun)))
    }).pipe(reportPlan)
).pipe(Command.withDescription("remove one linked worktree by slug"), Command.provide(services))

const initCommand = Command.make(
  "init",
  {
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("write zwt.toml without prompting, including an existing file"),
      Flag.withDefault(false)
    ),
    config: configFlag
  },
  ({ config, yes }) =>
    Effect.gen(function*() {
      const file = configFile(config)
      const result = yield* initConfig({
        file,
        home: process.env.HOME ?? "~",
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
        yes,
        interactive: interactiveSession()
      })
      const verb = (yield* DryRun) ? "would write" : "wrote"
      const line = result._tag === "Declined"
        ? `not written ${result.file}`
        : result._tag === "Imported"
          ? `${verb} ${result.file} (${result.count} ${result.count === 1 ? "identity" : "identities"})`
          : `${verb} starter ${result.file}`
      yield* Console.log(line)
    }).pipe(reportPlan)
).pipe(
  Command.withDescription("write zwt.toml from includeIf gitdir identities, or a personal starter"),
  Command.provide(services)
)

const logCommand = Command.make("log", {}, () => showLog.pipe(reportPlan)).pipe(
  Command.withDescription("show recent local write actions"),
  Command.provide(services)
)

export const zwt = Command.make("zwt").pipe(
  Command.withDescription("git worktree helper"),
  Command.withSubcommands([
    configCommand,
    newCommand,
    openCommand,
    agentCommand,
    identityCommand,
    doctorCommand,
    syncCommand,
    statusCommand,
    initCommand,
    listCommand,
    pruneCommand,
    rmCommand,
    logCommand
  ]),
  Command.withGlobalFlags([DryRun])
)

export const run = Command.run(zwt, { version: pkg.version })
