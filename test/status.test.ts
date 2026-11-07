import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { GitCommandFailed } from "../src/errors.ts"
import { daysSince, parseStatusPaths, runStatus, StatusReportSchema } from "../src/commands/status.ts"
import { Config, type ZwtConfig } from "../src/services/Config.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { Git } from "../src/services/Git.ts"

const repo = "/home/jane/work/acme/web"
const linked = "/home/jane/work/acme/worktrees/web/login"
const notes = "/home/jane/personal/notes"
const home = "/home/jane"
const configFile = "/cfg/zwt.toml"
const now = 1_700_000_000_000
const day = 86_400_000
const commitSec = Math.floor((now - 3 * day - 60_000) / 1000)
const decodeReport = Schema.decodeUnknownSync(StatusReportSchema, { onExcessProperty: "error" })

const config = {
  version: 1 as const,
  identity: { work: { name: "Jane Doe", email: "jane.doe@example.com" } },
  profile: [{ match: "/home/jane/work/acme/**", identity: "work", base_branch: "develop" }],
  project: [{ path: repo, identity: "work", base_branch: "release" }]
} satisfies ZwtConfig

const configLayer = Layer.succeed(Config, {
  load: () => Effect.succeed(config),
  upsertProject: () => Effect.die("status must not write config")
})

const porcelain = [
  `worktree ${repo}`,
  "HEAD aaa",
  "branch refs/heads/main",
  "",
  `worktree ${linked}`,
  "HEAD bbb",
  "branch refs/heads/feature/login",
  "locked"
].join("\n")

const statusArgs = "--no-optional-locks status --porcelain=v1 -z"
const logArgs = "log -1 --format=%ct"
const rev = (base: string) => `rev-list --left-right --count ${base}...HEAD`
const key = (cwd: string, args: string) => `${cwd}\0${args}`

const notRepo = new GitCommandFailed({
  args: ["rev-parse", "--show-toplevel"],
  exitCode: 128,
  stderr: "fatal: not a git repository"
})

const responses = {
  "rev-parse --show-toplevel": repo,
  "worktree list --porcelain": porcelain,
  [key(repo, rev("release"))]: "0\t1",
  [key(linked, rev("release"))]: "2\t4",
  [key(repo, statusArgs)]: "",
  [key(linked, statusArgs)]: " M src/app.ts\0?? notes/todo.txt\0",
  [logArgs]: String(commitSec)
}

const isReadOnly = (call: ReadonlyArray<string>) => {
  const text = call.join(" ")
  return text === "rev-parse --show-toplevel" ||
    text === "worktree list --porcelain" ||
    text.startsWith("rev-list --left-right --count ") ||
    text === statusArgs ||
    text === logArgs ||
    text === "rev-parse --path-format=absolute --git-common-dir"
}

const logged = (lines: ReadonlyArray<unknown>) => lines.map(String).join("\n")

const provide = (fake: ReturnType<typeof Git.fake>, layer: Layer.Layer<Config> = configLayer) =>
  Layer.mergeAll(fake.layer, layer, TestConsole.layer, DryRunLog.layer)

const mtime = (path: string) => Effect.succeed(path === `${linked}/src/app.ts` ? Option.some(now) : Option.none())

const status = (options: {
  readonly all?: boolean
  readonly output?: "text" | "json"
  readonly path?: Option.Option<string>
  readonly cwd?: string
  readonly mtimeMs?: (path: string) => Effect.Effect<Option.Option<number>>
} = {}) =>
  runStatus({
    all: options.all ?? false,
    output: options.output ?? "text",
    path: options.path ?? Option.none(),
    cwd: options.cwd ?? repo,
    home,
    configFile,
    nowMs: now,
    mtimeMs: options.mtimeMs ?? mtime
  })

const table = [
  "repo | branch | base | ahead | behind | dirty | days",
  `${repo} | main | release | 1 | 0 | no | 3`,
  `${linked} | feature/login | release | 4 | 2 | yes | 0`
].join("\n")

describe("status helpers", () => {
  it("counts whole days and treats a future timestamp as today", () => {
    expect(daysSince(now - 3 * day - 60_000, now)).toBe(3)
    expect(daysSince(now - day + 1, now)).toBe(0)
    expect(daysSince(now + day, now)).toBe(0)
  })

  it("reads porcelain -z paths, including a rename's new name", () => {
    expect(parseStatusPaths(" M src/app.ts\0?? my file.txt\0")).toEqual(["src/app.ts", "my file.txt"])
    expect(parseStatusPaths("R  old.ts\0src/new.ts\0")).toEqual(["src/new.ts"])
    expect(parseStatusPaths("")).toEqual([])
  })
})

describe("zwt status", () => {
  it("does not branch on the dry-run flag", () => {
    const text = readFileSync(new URL("../src/commands/status.ts", import.meta.url), "utf8")
    expect(text.includes("DryRun")).toBe(false)
    expect(text.includes("dry-run")).toBe(false)
    expect(text.includes("dryRun")).toBe(false)
    expect(text.includes("configSet")).toBe(false)
    expect(text.includes("fetch")).toBe(false)
  })

  it.effect("prints branch, base, ahead/behind, dirty, and days for each worktree", () => {
    const fake = Git.fake(responses)
    return Effect.gen(function*() {
      yield* status()
      expect(logged(yield* TestConsole.logLines)).toBe(table)
      expect(yield* (yield* DryRunLog).planned).toEqual([])
      expect(fake.calls.every(isReadOnly)).toBe(true)
      expect(fake.calls.some((call) => call.join(" ").includes("develop...HEAD"))).toBe(false)
      expect(fake.calls.some((call) => call.join(" ").includes("origin/"))).toBe(false)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("prints a versioned json document", () => {
    const fake = Git.fake(responses)
    return Effect.gen(function*() {
      yield* status({ output: "json" })
      const parsed = decodeReport(JSON.parse(logged(yield* TestConsole.logLines)))
      expect(parsed.version).toBe(1)
      expect(parsed.worktrees).toEqual([
        { repo, branch: "main", base: "release", ahead: 1, behind: 0, dirty: false, daysSinceActivity: 3 },
        {
          repo: linked,
          branch: "feature/login",
          base: "release",
          ahead: 4,
          behind: 2,
          dirty: true,
          daysSinceActivity: 0
        }
      ])
      expect(() => decodeReport({ worktrees: [] })).toThrow()
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("resolves a path argument from the home directory", () => {
    const fake = Git.fake(responses)
    return Effect.gen(function*() {
      yield* status({ path: Option.some("~/work/acme/web"), cwd: "/tmp" })
      expect(logged(yield* TestConsole.logLines)).toBe(table)
      expect(fake.calls[0]).toEqual(["rev-parse", "--show-toplevel"])
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("leaves ahead and behind empty when the base ref is missing", () => {
    const args = ["rev-list", "--left-right", "--count", "release...HEAD"]
    const missing = new GitCommandFailed({ args, exitCode: 128, stderr: "fatal: bad revision" })
    const fake = Git.fake({
      ...responses,
      [key(repo, rev("release"))]: missing,
      [key(linked, rev("release"))]: missing
    })
    return Effect.gen(function*() {
      yield* status({ output: "json" })
      const parsed = decodeReport(JSON.parse(logged(yield* TestConsole.logLines)))
      expect(parsed.worktrees.every((row) => row.ahead === null && row.behind === null)).toBe(true)
      expect(parsed.worktrees[0]?.daysSinceActivity).toBe(3)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("uses the commit time when a dirty path cannot be stat'ed", () => {
    const fake = Git.fake({
      ...responses,
      [key(linked, statusArgs)]: " D gone.txt\0"
    })
    return Effect.gen(function*() {
      yield* status({ mtimeMs: () => Effect.succeed(Option.none()) })
      expect(logged(yield* TestConsole.logLines)).toContain(`${linked} | feature/login | release | 4 | 2 | yes | 3`)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("names a detached checkout and still compares it to the base", () => {
    const fake = Git.fake({
      ...responses,
      "worktree list --porcelain": `worktree ${repo}\nHEAD aaa\ndetached`
    })
    return Effect.gen(function*() {
      yield* status()
      expect(logged(yield* TestConsole.logLines)).toContain(`${repo} | (detached) | release | 1 | 0 | no | 3`)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("treats a bare checkout as clean", () => {
    const args = ["--no-optional-locks", "status", "--porcelain=v1", "-z"]
    const bare = new GitCommandFailed({
      args,
      exitCode: 128,
      stderr: "fatal: this operation must be run in a work tree"
    })
    const fake = Git.fake({
      ...responses,
      "worktree list --porcelain": `worktree ${repo}\nHEAD aaa\nbare`,
      [key(repo, statusArgs)]: bare
    })
    return Effect.gen(function*() {
      yield* status()
      expect(logged(yield* TestConsole.logLines)).toContain(`${repo} | (bare) | release | 1 | 0 | no | 3`)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("does not hide a status failure that is not a bare checkout", () => {
    const args = ["--no-optional-locks", "status", "--porcelain=v1", "-z"]
    const fake = Git.fake({
      ...responses,
      [key(repo, statusArgs)]: new GitCommandFailed({ args, exitCode: 128, stderr: "fatal: something else" })
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(status())
      expect(error._tag).toBe("GitCommandFailed")
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("fails when the path is not a repository", () => {
    const fake = Git.fake({ "rev-parse --show-toplevel": notRepo })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(status({ cwd: "/tmp" }))
      expect(error._tag).toBe("GitCommandFailed")
      expect(logged(yield* TestConsole.logLines)).toBe("")
    }).pipe(Effect.provide(provide(fake)))
  })
})

const missing = "/home/jane/missing"
const wide = "/home/jane/wide"

const allConfig = {
  version: 1 as const,
  identity: { personal: { name: "Jane Doe", email: "jane@example.com" } },
  profile: [
    { match: "/home/jane/work/acme/**", identity: "personal", base_branch: "develop" },
    { match: `${wide}/**`, identity: "personal" },
    { match: `${notes}/**`, identity: "personal" }
  ],
  project: [
    { path: repo, base_branch: "release" },
    { path: linked },
    { path: notes, base_branch: "trunk" },
    { path: missing }
  ]
} satisfies ZwtConfig

const allLayer = Layer.succeed(Config, {
  load: () => Effect.succeed(allConfig),
  upsertProject: () => Effect.die("status must not write config")
})

const notesPorcelain = [`worktree ${notes}`, "HEAD ccc", "branch refs/heads/main"].join("\n")

const allResponses = {
  [key(repo, "rev-parse --show-toplevel")]: repo,
  [key(linked, "rev-parse --show-toplevel")]: linked,
  [key(notes, "rev-parse --show-toplevel")]: notes,
  [key(missing, "rev-parse --show-toplevel")]: notRepo,
  [key("/home/jane/work/acme", "rev-parse --show-toplevel")]: notRepo,
  [key(wide, "rev-parse --show-toplevel")]: notRepo,
  [key(repo, "rev-parse --path-format=absolute --git-common-dir")]: `${repo}/.git`,
  [key(linked, "rev-parse --path-format=absolute --git-common-dir")]: `${repo}/.git`,
  [key(notes, "rev-parse --path-format=absolute --git-common-dir")]: `${notes}/.git`,
  [key(repo, "worktree list --porcelain")]: porcelain,
  [key(notes, "worktree list --porcelain")]: notesPorcelain,
  [key(repo, rev("release"))]: "0\t1",
  [key(linked, rev("release"))]: "2\t4",
  [key(notes, rev("trunk"))]: "0\t2",
  [key(repo, statusArgs)]: "",
  [key(linked, statusArgs)]: "",
  [key(notes, statusArgs)]: "",
  [logArgs]: String(commitSec)
}

describe("zwt status --all", () => {
  it.effect("lists each repository once and skips a path that is not a repo", () => {
    const fake = Git.fake(allResponses)
    return Effect.gen(function*() {
      yield* status({ all: true, path: Option.some("/home/jane/ignored"), cwd: "/tmp" })
      expect(logged(yield* TestConsole.logLines)).toBe([
        "repo | branch | base | ahead | behind | dirty | days",
        `${repo} | main | release | 1 | 0 | no | 3`,
        `${linked} | feature/login | release | 4 | 2 | no | 3`,
        `${notes} | main | trunk | 2 | 0 | no | 3`
      ].join("\n"))
      expect(fake.calls.filter((call) => call[0] === "worktree" && call[1] === "list")).toHaveLength(2)
      expect(fake.calls.every(isReadOnly)).toBe(true)
      expect(logged(yield* TestConsole.logLines).includes(missing)).toBe(false)
      expect(logged(yield* TestConsole.logLines).includes(wide)).toBe(false)
    }).pipe(Effect.provide(provide(fake, allLayer)))
  })

  it.effect("prints an empty versioned document when nothing is configured", () => {
    const empty = Layer.succeed(Config, {
      load: () => Effect.succeed({ version: 1 as const, identity: {} }),
      upsertProject: () => Effect.die("status must not write config")
    })
    const fake = Git.fake({})
    return Effect.gen(function*() {
      yield* status({ all: true, output: "json" })
      expect(decodeReport(JSON.parse(logged(yield* TestConsole.logLines)))).toEqual({ version: 1, worktrees: [] })
      expect(fake.calls.every(isReadOnly)).toBe(true)
    }).pipe(Effect.provide(provide(fake, empty)))
  })

  it.effect("stops the scan when git fails for a reason other than a missing repo", () => {
    const broken = "/home/jane/broken"
    const layer = Layer.succeed(Config, {
      load: () =>
        Effect.succeed({
          version: 1 as const,
          identity: { personal: { name: "Jane Doe", email: "jane@example.com" } },
          project: [{ path: broken }]
        }),
      upsertProject: () => Effect.die("status must not write config")
    })
    const fake = Git.fake({
      [key(broken, "rev-parse --show-toplevel")]: new GitCommandFailed({
        args: ["rev-parse", "--show-toplevel"],
        exitCode: 1,
        stderr: "fatal: permission denied"
      })
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(status({ all: true }))
      expect(error._tag).toBe("GitCommandFailed")
      expect(logged(yield* TestConsole.logLines)).toBe("")
    }).pipe(Effect.provide(provide(fake, layer)))
  })
})
