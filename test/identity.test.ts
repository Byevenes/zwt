import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { TestConsole } from "effect/testing"
import { checkIdentity, listIdentities, setIdentity } from "../src/commands/identity.ts"
import { Git } from "../src/services/Git.ts"
import { Config } from "../src/services/Config.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { dryRunFileSystem } from "../src/services/FileSystem.ts"
import { canPrompt, Prompt } from "../src/services/Prompt.ts"

const source = readFileSync(new URL("./fixtures/valid.toml", import.meta.url), "utf8")
const configLayer = Config.live.pipe(Layer.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(source) })))
const repo = "/home/jane/work/acme/web"

describe("canPrompt", () => {
  it("is only a terminal with CI unset", () => {
    expect(canPrompt({ ci: undefined, stdinIsTTY: true })).toBe(true)
    expect(canPrompt({ ci: "", stdinIsTTY: true })).toBe(true)
    expect(canPrompt({ ci: "true", stdinIsTTY: true })).toBe(false)
    expect(canPrompt({ ci: undefined, stdinIsTTY: false })).toBe(false)
  })
})

describe("zwt identity", () => {
  it.effect("lists configured identities", () =>
    Effect.gen(function*() {
      yield* listIdentities("/cfg/zwt.toml")
      const logs = yield* TestConsole.logLines
      expect(String(logs[0])).toContain("personal")
      expect(String(logs[0])).toContain("jane@example.com")
      expect(String(logs[0])).toContain("jane.doe@example.com")
    }).pipe(Effect.provide(Layer.merge(configLayer, TestConsole.layer))))

  it.effect("check prints effective, origin and expected email", () => {
    const fake = Git.fake({
      "rev-parse --show-toplevel": repo,
      "config --get user.email": "jane.doe@example.com",
      "config --show-origin --get user.email": "file:/repo/.git/worktrees/web/config.worktree\tjane.doe@example.com"
    })
    return Effect.gen(function*() {
      yield* checkIdentity({ path: Option.none(), cwd: repo, home: "/home/jane", configFile: "/cfg/zwt.toml" })
      const logs = yield* TestConsole.logLines
      const text = String(logs[0])
      expect(text).toContain("effective: jane.doe@example.com")
      expect(text).toContain("origin: /repo/.git/worktrees/web/config.worktree")
      expect(text).toContain("expected: jane.doe@example.com")
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer, TestConsole.layer)))
  })

  it.effect("check fails with IdentityMismatch and an includeIf hint when the email differs", () => {
    const fake = Git.fake({
      "rev-parse --show-toplevel": repo,
      "config --get user.email": "other@example.com",
      "config --show-origin --get user.email": "file:/home/jane/.gitconfig\tother@example.com"
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(checkIdentity({
        path: Option.none(),
        cwd: repo,
        home: "/home/jane",
        configFile: "/cfg/zwt.toml"
      }))
      expect(error._tag).toBe("IdentityMismatch")
      if (error._tag === "IdentityMismatch") expect(error.fix).toContain("includeIf")
      const logs = yield* TestConsole.logLines
      expect(String(logs[0])).toContain("effective: other@example.com")
      expect(String(logs[0])).toContain("expected: jane.doe@example.com")
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer, TestConsole.layer)))
  })

  it.effect("set refuses to write without a terminal", () => {
    const fake = Git.fake({})
    return Effect.gen(function*() {
      const error = yield* Effect.flip(setIdentity({
        name: "work",
        path: Option.some("/home/jane/notes"),
        cwd: "/home/jane",
        home: "/home/jane",
        configFile: "/cfg/zwt.toml",
        interactive: false
      }))
      expect(error._tag).toBe("ConfirmationRequired")
      if (error._tag === "ConfirmationRequired") expect(error.fix).toContain("non-interactive")
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer, Prompt.scripted({ confirm: true }))))
  })

  it.effect("set stores the git root so zwt new can match the folder", () => {
    const saved: Array<string> = []
    const config = Layer.succeed(Config, {
      load: () =>
        Effect.succeed({ version: 1 as const, identity: { work: { name: "Jane Doe", email: "jane@example.com" } } }),
      upsertProject: (_file, entry) => Effect.sync(() => {
        saved.push(entry.path)
      })
    })
    const fake = Git.fake({ "rev-parse --show-toplevel": "/home/jane/repo" })
    return Effect.gen(function*() {
      const result = yield* setIdentity({
        name: "work",
        path: Option.some("/home/jane/repo/src"),
        cwd: "/home/jane/repo/src",
        home: "/home/jane",
        configFile: "/cfg/zwt.toml",
        interactive: true
      })
      expect(result).toEqual({ _tag: "Saved", path: "/home/jane/repo", identity: "work" })
      expect(saved).toEqual(["/home/jane/repo"])
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, Prompt.scripted({ confirm: true }))))
  })

  it.effect("set honours a declined confirmation", () => {
    const config = Layer.succeed(Config, {
      load: () => Effect.succeed({ version: 1 as const, identity: { work: { name: "Jane Doe", email: "jane@example.com" } } }),
      upsertProject: () => Effect.die("declined save must not write")
    })
    return Effect.gen(function*() {
      const result = yield* setIdentity({
        name: "work",
        path: Option.some("/home/jane/notes"),
        cwd: "/tmp",
        home: "/home/jane",
        configFile: "/cfg/zwt.toml",
        interactive: true
      })
      expect(result).toEqual({ _tag: "Declined", path: "/home/jane/notes", identity: "work" })
    }).pipe(Effect.provide(Layer.mergeAll(Git.fake({}).layer, config, Prompt.scripted({ confirm: false }))))
  })

  it.effect("set --dry-run records the toml write and leaves the file untouched", () => {
    let text = source
    const backing = FileSystem.layerNoop({
      readFileString: () => Effect.succeed(text),
      writeFileString: () => Effect.die("real write during dry-run")
    })
    const layer = Layer.mergeAll(Config.live, Prompt.scripted({ confirm: true }), Git.fake({}).layer).pipe(
      Layer.provide(dryRunFileSystem),
      Layer.provideMerge(DryRunLog.layer),
      Layer.provide(backing)
    )
    return Effect.gen(function*() {
      const result = yield* setIdentity({
        name: "personal",
        path: Option.some("/home/jane/notes"),
        cwd: "/tmp",
        home: "/home/jane",
        configFile: "/cfg/zwt.toml",
        interactive: true
      })
      expect(result).toEqual({ _tag: "Saved", path: "/home/jane/notes", identity: "personal" })
      expect(text).toBe(source)
      const planned = yield* (yield* DryRunLog).planned
      expect(planned).toContainEqual({ kind: "fs", description: "write /cfg/zwt.toml" })
    }).pipe(Effect.provide(layer))
  })
})
