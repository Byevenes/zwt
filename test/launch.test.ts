import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestConsole } from "effect/testing"
import { finishOpen, launchInWorktree, prepareOpen } from "../src/commands/launch.ts"
import { CommandNotFound, render } from "../src/errors.ts"
import { Config, parseConfig } from "../src/services/Config.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { Git } from "../src/services/Git.ts"
import { Launch } from "../src/services/Launch.ts"

const repo = "/home/jane/work/acme/web"
const worktree = "/home/jane/work/acme/worktrees/web/login"
const home = "/home/jane"
const file = "/cfg/zwt.toml"
const logged = (lines: ReadonlyArray<unknown>) => lines.map(String).join("\n")

const toml = (body: string) =>
  [
    "version = 1",
    "[identity.work]",
    'name = "Jane Doe"',
    'email = "jane.doe@example.com"',
    "[[profile]]",
    'match = "~/work/acme/**"',
    'identity = "work"',
    'base_branch = "develop"',
    'branch_prefix = "feature/"',
    body
  ].join("\n")

const configured = toml('open_command = "editor --flag"\nagent_command = "agent"')
const configLayer = (source: string) =>
  Layer.succeed(Config, {
    load: () => parseConfig(file, source),
    upsertProject: () => Effect.die("not saved")
  })

const porcelain = `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD def\nbranch refs/heads/feature/login\n`
const gitLayer = (list = porcelain) =>
  Git.fake({
    "rev-parse --show-toplevel": repo,
    "worktree list --porcelain": list
  })

const options = {
  slug: "login",
  cwd: repo,
  home,
  configFile: file
}

describe("launch command", () => {
  it("does not branch on the dry-run flag", () => {
    const text = readFileSync(new URL("../src/commands/launch.ts", import.meta.url), "utf8")
    expect(text.includes("DryRun")).toBe(false)
    expect(text.includes("dry-run")).toBe(false)
    expect(text.includes("dryRun")).toBe(false)
  })

  it.effect("opens the existing worktree with the path appended", () => {
    const fake = gitLayer()
    const launch = Launch.recording()
    return Effect.gen(function*() {
      expect(yield* launchInWorktree({ ...options, kind: "open" })).toEqual({
        path: worktree,
        branch: "feature/login"
      })
      expect(launch.calls).toEqual([{
        argv: ["editor", "--flag", worktree],
        cwd: worktree,
        display: `editor --flag ${worktree}`,
        key: "open_command",
        file
      }])
      expect(fake.calls.some((call) => call[0] === "worktree" && call[1] === "add")).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer(configured), launch.layer)))
  })

  it.effect("starts the agent in the worktree without appending the path", () => {
    const launch = Launch.recording()
    return Effect.gen(function*() {
      expect(yield* launchInWorktree({ ...options, kind: "agent" })).toMatchObject({ path: worktree })
      expect(launch.calls[0]).toMatchObject({
        argv: ["agent"],
        cwd: worktree,
        display: `(cwd ${worktree}) agent`,
        key: "agent_command"
      })
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer().layer, configLayer(configured), launch.layer)))
  })

  it.effect("fails when the worktree does not exist and does not launch", () => {
    const launch = Launch.recording()
    const fake = gitLayer(`worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n`)
    return Effect.gen(function*() {
      const error = yield* Effect.flip(launchInWorktree({ ...options, kind: "open" }))
      expect(error._tag).toBe("WorktreeNotFound")
      if (error._tag === "WorktreeNotFound") {
        expect(error.branch).toBe("feature/login")
        expect(render(error)).toContain("zwt new login")
      }
      expect(launch.calls).toEqual([])
      expect(fake.calls.some((call) => call[1] === "add")).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer(configured), launch.layer)))
  })

  it.effect("fails when the profile has no command", () => {
    const launch = Launch.recording()
    return Effect.gen(function*() {
      const error = yield* Effect.flip(launchInWorktree({ ...options, kind: "agent" }))
      expect(error._tag).toBe("CommandUnset")
      if (error._tag === "CommandUnset") expect(render(error)).toContain("agent_command")
      expect(launch.calls).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer().layer, configLayer(toml("")), launch.layer)))
  })

  it.effect("leaves an invalid slug for zwt new to reject", () => {
    const fake = Git.fake({})
    return Effect.gen(function*() {
      yield* prepareOpen({ ...options, slug: "../x" })
      expect(fake.calls).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer(configured), Launch.recording().layer)))
  })

  it.effect("rejects a slug that would escape the worktrees dir before git", () => {
    const fake = Git.fake({})
    return Effect.gen(function*() {
      const error = yield* Effect.flip(launchInWorktree({ ...options, kind: "open", slug: "../x" }))
      expect(error._tag).toBe("InvalidSlug")
      expect(fake.calls).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer(configured), Launch.recording().layer)))
  })

  it.effect("checks open_command before zwt new writes, and does not run it yet", () => {
    const fake = gitLayer()
    const launch = Launch.recording()
    return Effect.gen(function*() {
      yield* prepareOpen(options)
      expect(launch.calls).toEqual([])
      expect(fake.calls.map((call) => call.join(" "))).toEqual(["rev-parse --show-toplevel"])
      const missing = yield* Effect.flip(prepareOpen(options).pipe(Effect.provide(configLayer(toml("")))))
      expect(missing._tag).toBe("CommandUnset")
      expect(fake.calls.some((call) => call[0] === "worktree")).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer(configured), launch.layer)))
  })

  it.effect("finishOpen launches in the worktree zwt new returned", () => {
    const launch = Launch.recording()
    return Effect.gen(function*() {
      yield* finishOpen({ cwd: repo, home, configFile: file, worktreePath: "/elsewhere/login" })
      expect(launch.calls[0]).toMatchObject({
        argv: ["editor", "--flag", "/elsewhere/login"],
        cwd: "/elsewhere/login",
        display: "editor --flag /elsewhere/login"
      })
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer().layer, configLayer(configured), launch.layer)))
  })
})

describe("Launch service", () => {
  const request = {
    argv: [] as ReadonlyArray<string>,
    cwd: process.cwd(),
    display: "shown-before",
    key: "open_command" as const,
    file: "zwt.toml"
  }

  it.effect("prints the command before running it", () =>
    Effect.gen(function*() {
      yield* (yield* Launch).run({ ...request, argv: [process.execPath, "-e", "process.exit(0)"] })
      expect(logged(yield* TestConsole.logLines)).toContain("shown-before")
    }).pipe(Effect.provide(Layer.mergeAll(Launch.live, TestConsole.layer))))

  it.effect("prints the command and fails with the child exit code", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        (yield* Launch).run({ ...request, argv: [process.execPath, "-e", "process.exit(3)"] })
      )
      expect(error._tag).toBe("CommandFailed")
      if (error._tag === "CommandFailed") expect(error.exitCode).toBe(3)
      expect(logged(yield* TestConsole.logLines)).toContain("shown-before")
    }).pipe(Effect.provide(Layer.mergeAll(Launch.live, TestConsole.layer))))

  it.effect("names a missing executable", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip((yield* Launch).run({ ...request, argv: ["zwt-missing-bin"] }))
      expect(error).toBeInstanceOf(CommandNotFound)
      if (error._tag === "CommandNotFound") {
        expect(error.command).toBe("zwt-missing-bin")
        expect(render(error)).toContain('install "zwt-missing-bin"')
        expect(render(error)).toContain("open_command")
      }
      expect(logged(yield* TestConsole.logLines)).toContain("shown-before")
    }).pipe(Effect.provide(Layer.mergeAll(Launch.live, TestConsole.layer))))

  it.effect("dry-run records the command and does not spawn it", () =>
    Effect.gen(function*() {
      yield* (yield* Launch).run({
        ...request,
        argv: ["/no/such/zwt-bin"],
        cwd: "/wt",
        display: "(cwd /wt) agent",
        key: "agent_command"
      })
      expect(yield* (yield* DryRunLog).planned).toEqual([{ kind: "exec", description: "(cwd /wt) agent" }])
    }).pipe(Effect.provide(Launch.dryRun.pipe(Layer.provideMerge(DryRunLog.layer)))))
})
