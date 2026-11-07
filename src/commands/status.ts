import { stat } from "node:fs/promises"
import { join, resolve as resolvePath } from "node:path"
import { Console, Effect, Option, Schema } from "effect"
import { configuredRepos } from "../repos.ts"
import { expandHome, resolveBase } from "../resolve.ts"
import { Config, type ZwtConfig } from "../services/Config.ts"
import { Git, type WorktreeEntry, type WorktreeHead } from "../services/Git.ts"

const dayMs = 86_400_000

/**
 * JSON document for `zwt status --output json`.
 * `version` is the schema. `ahead` / `behind` / `daysSinceActivity` are null when git cannot answer.
 */
export const StatusWorktreeSchema = Schema.Struct({
  repo: Schema.String,
  branch: Schema.String,
  base: Schema.String,
  ahead: Schema.NullOr(Schema.Number),
  behind: Schema.NullOr(Schema.Number),
  dirty: Schema.Boolean,
  daysSinceActivity: Schema.NullOr(Schema.Number)
})

export const StatusReportSchema = Schema.Struct({
  version: Schema.Literal(1),
  worktrees: Schema.Array(StatusWorktreeSchema)
})

export type StatusWorktree = typeof StatusWorktreeSchema.Type
export type StatusReport = typeof StatusReportSchema.Type

const encodeReport = Schema.encodeSync(StatusReportSchema)

/** Whole days from `activityMs` until `nowMs`. A future timestamp is 0. */
export const daysSince = (activityMs: number, nowMs: number): number => {
  const elapsed = nowMs - activityMs
  return elapsed <= 0 ? 0 : Math.floor(elapsed / dayMs)
}

/**
 * Paths in `git status --porcelain=v1 -z`.
 * A rename or copy is `XY <old>\0<new>\0`; the path that exists now is `<new>`.
 */
export const parseStatusPaths = (porcelain: string): ReadonlyArray<string> => {
  if (porcelain.length === 0) return []
  const paths: Array<string> = []
  const parts = porcelain.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined || part.length < 3) continue
    const renamed = part.slice(0, 2).includes("R") || part.slice(0, 2).includes("C")
    if (renamed) {
      const next = parts[i + 1]
      if (next !== undefined && next.length > 0) paths.push(next)
      i += 1
      continue
    }
    const path = part.slice(3)
    if (path.length > 0) paths.push(path)
  }
  return paths
}

const worktreeBranch = (head: WorktreeHead): string => {
  switch (head._tag) {
    case "Branch":
      return head.name
    case "Detached":
      return "(detached)"
    case "Bare":
      return "(bare)"
    default: {
      const unexpected: never = head
      return unexpected
    }
  }
}

const countCell = (value: number | null): string => value === null ? "?" : String(value)

const renderText = (rows: ReadonlyArray<StatusWorktree>): string => {
  const header = "repo | branch | base | ahead | behind | dirty | days"
  const lines = rows.map((row) =>
    [
      row.repo,
      row.branch,
      row.base,
      countCell(row.ahead),
      countCell(row.behind),
      row.dirty ? "yes" : "no",
      countCell(row.daysSinceActivity)
    ].join(" | ")
  )
  return [header, ...lines].join("\n")
}

const render = (rows: ReadonlyArray<StatusWorktree>, output: "text" | "json"): string => {
  switch (output) {
    case "text":
      return renderText(rows)
    case "json":
      return JSON.stringify(encodeReport({ version: 1, worktrees: rows }), null, 2)
    default: {
      const unexpected: never = output
      return unexpected
    }
  }
}

export const fileMtimeMs = (path: string): Effect.Effect<Option.Option<number>> =>
  Effect.promise(async () => {
    try {
      return Option.some((await stat(path)).mtimeMs)
    } catch {
      return Option.none()
    }
  })

interface Clock {
  readonly nowMs: number
  readonly mtimeMs: (path: string) => Effect.Effect<Option.Option<number>>
}

const activityDays = (options: {
  readonly committer: Option.Option<number>
  readonly paths: ReadonlyArray<string>
  readonly clock: Clock
}): Effect.Effect<number | null> =>
  Effect.gen(function*() {
    const times: Array<number> = []
    if (Option.isSome(options.committer)) times.push(options.committer.value * 1000)
    for (const path of options.paths) {
      const found = yield* options.clock.mtimeMs(path)
      if (Option.isSome(found)) times.push(found.value)
    }
    const latest = times.length === 0 ? undefined : Math.max(...times)
    return latest === undefined ? null : daysSince(latest, options.clock.nowMs)
  })

const inspect = (entry: WorktreeEntry, base: string, clock: Clock) =>
  Effect.gen(function*() {
    const git = yield* Git
    const counts = yield* git.aheadBehind(base, entry.path)
    const porcelain = yield* git.statusPorcelain(entry.path)
    const dirty = porcelain.length > 0
    const committer = yield* git.committerUnix(entry.path)
    const paths = dirty ? parseStatusPaths(porcelain).map((rel) => join(entry.path, rel)) : []
    return {
      repo: entry.path,
      branch: worktreeBranch(entry.head),
      base,
      ahead: Option.isSome(counts) ? counts.value.ahead : null,
      behind: Option.isSome(counts) ? counts.value.behind : null,
      dirty,
      daysSinceActivity: yield* activityDays({ committer, paths, clock })
    } satisfies StatusWorktree
  })

/** Base comes from the main worktree, which `git worktree list` prints first. */
const rowsFor = (root: string, config: ZwtConfig, home: string, clock: Clock) =>
  Effect.gen(function*() {
    const entries = yield* (yield* Git).listWorktrees(root)
    const main = entries[0]
    if (main === undefined) return []
    const base = resolveBase({ config, repoRoot: main.path, home })
    const rows: Array<StatusWorktree> = []
    for (const entry of entries) rows.push(yield* inspect(entry, base, clock))
    return rows
  })

const trimSlash = (path: string) => path.replace(/\/+$/, "")

const normalizeFolder = (path: string, cwd: string, home: string) => trimSlash(resolvePath(cwd, expandHome(path, home)))

const allRows = (config: ZwtConfig, home: string, clock: Clock) =>
  Effect.gen(function*() {
    const git = yield* Git
    const seen = new Set<string>()
    const rows: Array<StatusWorktree> = []
    for (const found of yield* configuredRepos(config, home)) {
      if (found._tag === "Absent") continue
      const root = found.repo
      const common = trimSlash(yield* git.commonDir(root))
      if (seen.has(common)) continue
      seen.add(common)
      rows.push(...(yield* rowsFor(root, config, home, clock)))
    }
    return rows
  })

export const runStatus = (options: {
  readonly all: boolean
  readonly output: "text" | "json"
  readonly path: Option.Option<string>
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly nowMs: number
  readonly mtimeMs?: (path: string) => Effect.Effect<Option.Option<number>>
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, home, nowMs, output } = options
    const clock: Clock = { nowMs, mtimeMs: options.mtimeMs ?? fileMtimeMs }
    const loaded = yield* (yield* Config).load(configFile)
    const rows = options.all
      ? yield* allRows(loaded, home, clock)
      : yield* rowsFor(
        trimSlash(yield* (yield* Git).repoRoot(Option.match(options.path, {
          onNone: () => cwd,
          onSome: (path) => normalizeFolder(path, cwd, home)
        }))),
        loaded,
        home,
        clock
      )
    yield* Console.log(render(rows, output))
  })
