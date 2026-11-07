import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Option } from "effect"
import { TestConsole } from "effect/testing"
import {
  actionLogPath,
  actionResult,
  appendCapped,
  encodeEntry,
  maxActionLogBytes,
  parseActionLog,
  renderActionLog,
  type ActionEntry
} from "../src/action-log.ts"
import { showLog } from "../src/commands/log.ts"
import { ActionLogUnreadable } from "../src/errors.ts"
import { ActionLog } from "../src/services/ActionLog.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { dryRunFileSystem, loggingFileSystem } from "../src/services/FileSystem.ts"
import { Git } from "../src/services/Git.ts"

const entry = (command: string, result = "ok"): ActionEntry => ({
  timestamp: "2026-11-07T00:00:00.000Z",
  command,
  result
})

const line = (value: ActionEntry) => `${encodeEntry(value)}\n`

describe("action log format", () => {
  it("resolves the XDG state path", () => {
    expect(maxActionLogBytes).toBe(256 * 1024)
    expect(actionLogPath({ XDG_STATE_HOME: "/xdg", HOME: "/home/jane" })).toBe("/xdg/zwt/actions.log")
    expect(actionLogPath({ XDG_STATE_HOME: "", HOME: "/home/jane" })).toBe("/home/jane/.local/state/zwt/actions.log")
    expect(actionLogPath({ HOME: "/home/jane" })).toBe("/home/jane/.local/state/zwt/actions.log")
    expect(actionLogPath({})).toBe("~/.local/state/zwt/actions.log")
  })

  it("encodes one json object per line and skips a bad line", () => {
    const encoded = encodeEntry(entry("git -C /repo config --local user.email ada@example.com"))
    expect(encoded).not.toContain("\n")
    expect(JSON.parse(encoded)).toEqual({
      timestamp: "2026-11-07T00:00:00.000Z",
      command: "git -C /repo config --local user.email ada@example.com",
      result: "ok"
    })
    const parsed = parseActionLog(`not json\n${encoded}\n{"timestamp":1}\n\n`)
    expect(parsed).toEqual([entry("git -C /repo config --local user.email ada@example.com")])
  })

  it("flattens a failure into a single result", () => {
    expect(actionResult(new Error("fetch failed\nfatal: no origin"))).toBe("error: fetch failed fatal: no origin")
    expect(actionResult(new Error(""))).toBe("error")
    expect(actionResult(new Error("x".repeat(301)))).toBe(`error: ${"x".repeat(300)}...`)
  })

  it("drops the oldest lines and always keeps the newest", () => {
    const first = entry("one")
    const second = entry("two")
    const third = entry("three")
    const two = appendCapped(appendCapped("", first, maxActionLogBytes), second, maxActionLogBytes)
    const cap = Buffer.byteLength(line(second) + line(third))
    expect(appendCapped(two, third, cap)).toBe(line(second) + line(third))
    expect(appendCapped(two, third, 1)).toBe(line(third))
  })

  it("renders entries in file order", () => {
    expect(renderActionLog([entry("mkdir /wt"), entry("write /wt/exclude", "error: denied")])).toBe(
      [
        "2026-11-07T00:00:00.000Z ok mkdir /wt",
        "2026-11-07T00:00:00.000Z error: denied write /wt/exclude"
      ].join("\n")
    )
  })
})

describe("action log file", () => {
  const root = mkdtempSync(join(tmpdir(), "zwt-action-log-"))
  const file = join(root, "zwt", "actions.log")
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it.effect("appends json lines and keeps only the newest when the cap is one byte", () =>
    Effect.gen(function*() {
      const actions = yield* ActionLog
      yield* actions.record({ command: "mkdir /wt", result: "ok" })
      yield* actions.record({ command: "write /repo/.git/info/exclude", result: "ok" })
      const entries = yield* actions.entries
      expect(entries).toHaveLength(2)
      expect(entries[0]?.command).toBe("mkdir /wt")
      expect(entries[1]?.result).toBe("ok")
      expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true)
      expect(readdirSync(join(root, "zwt")).some((name) => name.endsWith(".tmp"))).toBe(false)
    }).pipe(Effect.provide(ActionLog.layer(file))))

  it.effect("caps the file to the newest line", () => {
    const capped = join(root, "capped.log")
    return Effect.gen(function*() {
      const actions = yield* ActionLog
      yield* actions.record({ command: "one", result: "ok" })
      yield* actions.record({ command: "two", result: "ok" })
      yield* actions.record({ command: "three", result: "ok" })
      const entries = yield* actions.entries
      expect(entries.map((item) => item.command)).toEqual(["three"])
    }).pipe(Effect.provide(ActionLog.layer(capped, 1)))
  })

  it.effect("reads a hand-written file and skips a broken line", () => {
    const mixed = join(root, "mixed.log")
    writeFileSync(mixed, `garbage\n${line(entry("write /cfg/zwt.toml"))}`)
    return Effect.gen(function*() {
      expect(yield* (yield* ActionLog).entries).toEqual([entry("write /cfg/zwt.toml")])
    }).pipe(Effect.provide(ActionLog.layer(mixed)))
  })

  it.effect("warns and still succeeds when the log path is not a file", () => {
    const blocked = join(root, "blocked")
    mkdirSync(blocked)
    const seen: Array<string> = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      seen.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    return Effect.gen(function*() {
      yield* (yield* ActionLog).record({ command: "write /x", result: "ok" })
      expect(seen.join("")).toContain(`warning: could not write action log ${blocked}`)
      const error = yield* Effect.flip((yield* ActionLog).entries)
      expect(error).toBeInstanceOf(ActionLogUnreadable)
      expect(error._tag).toBe("ActionLogUnreadable")
      expect(error.fix).toContain(blocked)
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        process.stderr.write = write
      })),
      Effect.provide(ActionLog.layer(blocked))
    )
  })

  it.effect("prints no actions, then the stored lines", () => {
    const shown = join(root, "shown.log")
    return Effect.gen(function*() {
      yield* showLog
      expect(String((yield* TestConsole.logLines)[0])).toBe("no actions")
      yield* (yield* ActionLog).record({ command: "mkdir /wt", result: "ok" })
      yield* showLog
      const logs = yield* TestConsole.logLines
      expect(String(logs[1])).toContain("ok mkdir /wt")
    }).pipe(Effect.provide(Layer.merge(ActionLog.layer(shown), TestConsole.layer)))
  })
})

describe("logged writes", () => {
  const root = mkdtempSync(join(tmpdir(), "zwt-logged-fs-"))
  const logFile = join(root, "actions.log")
  const target = join(root, "note.txt")
  const secret = `ghp_${"a".repeat(36)}`
  const logged = loggingFileSystem.pipe(
    Layer.provideMerge(ActionLog.layer(logFile)),
    Layer.provide(BunFileSystem.layer)
  )
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it.effect("records file writes and not their contents or reads", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(join(root, "nested"), { recursive: true })
      yield* fs.writeFileString(target, secret)
      expect(yield* fs.readFileString(target)).toBe(secret)
      yield* fs.remove(target)
      const denied = yield* Effect.exit(fs.writeFileString(root, "nope"))
      expect(Exit.isFailure(denied)).toBe(true)

      const entries = yield* (yield* ActionLog).entries
      const commands = entries.map((item) => item.command)
      expect(commands).toEqual([
        `mkdir ${join(root, "nested")}`,
        `write ${target}`,
        `remove ${target}`,
        `write ${root}`
      ])
      expect(entries.slice(0, 3).every((item) => item.result === "ok")).toBe(true)
      expect(entries[3]?.result.startsWith("error:")).toBe(true)
      expect(readFileSync(logFile, "utf8")).not.toContain(secret)
    }).pipe(Effect.provide(logged)))

  it.effect("does not append a dry-run file write", () => {
    const dryLog = join(root, "dry.log")
    const dry = dryRunFileSystem.pipe(
      Layer.provideMerge(DryRunLog.layer),
      Layer.provideMerge(ActionLog.layer(dryLog)),
      Layer.provide(FileSystem.layerNoop({
        writeFileString: () => Effect.die("real write during dry-run"),
        readFileString: () => Effect.succeed("read")
      }))
    )
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/repo/.git/info/exclude", ".scratch\n")
      expect(yield* fs.readFileString("/any")).toBe("read")
      const planned = yield* (yield* DryRunLog).planned
      expect(planned).toEqual([{ kind: "fs", description: "write /repo/.git/info/exclude" }])
      expect(yield* (yield* ActionLog).entries).toEqual([])
    }).pipe(Effect.provide(dry))
  })
})

describe("Git.logging", () => {
  const root = mkdtempSync(join(tmpdir(), "zwt-logged-git-"))
  const repo = join(root, "repo")
  const logFile = join(root, "actions.log")
  const layer = Git.logging.pipe(Layer.provideMerge(ActionLog.layer(logFile)))
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }

  beforeAll(() => {
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv })
    execFileSync("git", ["-C", repo, "config", "user.email", "jane@example.com"], { env: gitEnv })
    execFileSync("git", ["-C", repo, "config", "user.name", "Jane Doe"], { env: gitEnv })
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv })
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it.effect("logs a config write and a failed fetch, and ignores a read", () =>
    Effect.gen(function*() {
      const git = yield* Git
      expect(yield* git.configGet("user.email", repo)).toEqual(Option.some("jane@example.com"))
      expect(yield* (yield* ActionLog).entries).toEqual([])

      yield* git.configSet("user.email", "ada@example.com", repo, "local")
      const failed = yield* git.fetch("origin", "main", repo).pipe(Effect.flip)
      expect(failed._tag).toBe("GitCommandFailed")

      const entries = yield* (yield* ActionLog).entries
      expect(entries).toHaveLength(2)
      expect(entries[0]?.result).toBe("ok")
      expect(entries[0]?.command).toContain(`git -C ${repo} config --local user.email ada@example.com`)
      expect(entries[0]?.command).not.toContain("--global")
      expect(entries[1]?.command).toContain(`git -C ${repo} fetch --quiet origin main`)
      expect(entries[1]?.result.startsWith("error:")).toBe(true)
    }).pipe(Effect.provide(layer)))
})
