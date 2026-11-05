import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { Config, defaultConfigPath, looksLikeToken, parseConfig, upsertProjectToml } from "../src/services/Config.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

describe("zwt.toml schema", () => {
  it.effect("accepts the example config", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", fixture("valid.toml"))
      expect(Object.keys(config.identity)).toEqual(["personal", "work"])
      expect(config.profile?.[1]?.branch_prefix).toBe("feature/")
    }))

  it.effect("accepts the config sketch in README.md", () =>
    Effect.gen(function*() {
      const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
      const sketch = /```toml\n([\s\S]*?)```/.exec(readme)?.[1] ?? ""
      const config = yield* parseConfig("README.md", sketch)
      expect(config.project?.[0]?.email).toBe("jane.ext@example.com")
    }))

  it.effect("reports schema issues with their TOML line", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(parseConfig("invalid.toml", fixture("invalid.toml")))
      expect(error._tag).toBe("ConfigInvalid")
      expect(error.issues).toContainEqual({
        path: "identity.personal.email",
        message: "must be an email address",
        line: 5
      })
      expect(error.fix).toContain("zwt config check")
    }))

  it.effect("rejects profiles that point to an unknown identity", () =>
    Effect.gen(function*() {
      const source = fixture("valid.toml").replace('identity = "work"', 'identity = "ghost"')
      const error = yield* Effect.flip(parseConfig("x.toml", source))
      expect(error.issues[0]).toMatchObject({ path: "profile[1].identity", line: 20 })
    }))

  it.effect("rejects token-like values and unknown keys", () =>
    Effect.gen(function*() {
      const tokenValue = fixture("valid.toml").replace('name = "Jane Doe"', `name = "ghp_${"a".repeat(36)}"`)
      const valueError = yield* Effect.flip(parseConfig("x.toml", tokenValue))
      expect(valueError.issues[0]?.message).toMatch(/secret token/)

      const tokenKey = `token = "abc"\n${fixture("valid.toml")}`
      const keyError = yield* Effect.flip(parseConfig("x.toml", tokenKey))
      expect(keyError.issues[0]?.path).toBe("token")
    }))

  it("recognises common token shapes only", () => {
    expect(looksLikeToken(`glpat-${"x".repeat(20)}`)).toBe(true)
    expect(looksLikeToken("AKIAABCDEFGHIJKLMNOP")).toBe(true)
    expect(looksLikeToken("feature/")).toBe(false)
    expect(looksLikeToken("jane@example.com")).toBe(false)
  })

  it.effect("reports malformed TOML as ConfigInvalid", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(parseConfig("x.toml", "version = 1\n[identity\n"))
      expect(error.issues[0]).toMatchObject({ path: "(toml)", line: 2 })
    }))

  it("resolves the XDG path with a ~/.config fallback", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/jane" })).toBe("/xdg/zwt/zwt.toml")
    expect(defaultConfigPath({ HOME: "/home/jane" })).toBe("/home/jane/.config/zwt/zwt.toml")
  })
})

describe("[[project]] update", () => {
  it.effect("appends a folder mapping and the result still parses", () =>
    Effect.gen(function*() {
      const next = upsertProjectToml(fixture("valid.toml"), {
        path: "/home/jane/notes",
        identity: "personal",
        home: "/home/jane"
      })
      expect(next).toContain('path = "/home/jane/notes"')
      expect(next).toContain('identity = "personal"')
      expect(next).toContain('email = "jane.ext@example.com"')
      const config = yield* parseConfig("valid.toml", next)
      expect(config.project?.some((project) => project.path === "/home/jane/notes" && project.identity === "personal")).toBe(true)
    }))

  it("updates the identity on a ~/ project without dropping its other keys", () => {
    const next = upsertProjectToml(fixture("valid.toml"), {
      path: "/home/jane/work/acme/backend/api",
      identity: "personal",
      home: "/home/jane"
    })
    expect(next).toContain('path = "~/work/acme/backend/api"')
    expect(next).toContain('base_branch = "main"')
    expect(next).toContain('email = "jane.ext@example.com"')
    expect(next).toContain('identity = "personal"')
    expect(next.match(/\[\[project\]\]/g)?.length).toBe(1)
    const replaced = upsertProjectToml(next, {
      path: "/home/jane/work/acme/backend/api",
      identity: "work",
      home: "/home/jane"
    })
    const project = replaced.slice(replaced.lastIndexOf("[[project]]"))
    expect(project).toContain('identity = "work"')
    expect(project).not.toContain("personal")
    expect(project).toContain('email = "jane.ext@example.com"')
    expect(replaced.match(/\[\[project\]\]/g)?.length).toBe(1)
  })
})

describe("Config service", () => {
  it.effect("loads through the FileSystem service", () =>
    Effect.gen(function*() {
      const config = yield* (yield* Config).load("/cfg/zwt.toml")
      expect(config.version).toBe(1)
    }).pipe(
      Effect.provide(Config.live),
      Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(fixture("valid.toml")) }))
    ))

  it.effect("writes an updated [[project]] through the FileSystem service", () => {
    let text = fixture("valid.toml")
    return Effect.gen(function*() {
      yield* (yield* Config).upsertProject("/cfg/zwt.toml", {
        path: "/home/jane/notes",
        identity: "personal",
        home: "/home/jane"
      })
      const config = yield* parseConfig("written.toml", text)
      expect(config.project?.some((project) => project.path === "/home/jane/notes" && project.identity === "personal")).toBe(true)
    }).pipe(
      Effect.provide(Config.live),
      Effect.provide(FileSystem.layerNoop({
        readFileString: () => Effect.succeed(text),
        writeFileString: (_path, data) => Effect.sync(() => {
          text = data
        })
      }))
    )
  })

  it.effect("fails with ConfigNotFound when the file is missing", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip((yield* Config).load("/missing.toml"))
      expect(error._tag).toBe("ConfigNotFound")
    }).pipe(Effect.provide(Config.live), Effect.provide(FileSystem.layerNoop({}))))
})
