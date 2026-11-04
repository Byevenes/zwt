import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { Config, defaultConfigPath, looksLikeToken, parseConfig } from "../src/services/Config.ts"

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
      expect(config.project?.[0]?.email).toBe("jane@acme.example")
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

describe("Config service", () => {
  it.effect("loads through the FileSystem service", () =>
    Effect.gen(function*() {
      const config = yield* (yield* Config).load("/cfg/zwt.toml")
      expect(config.version).toBe(1)
    }).pipe(
      Effect.provide(Config.live),
      Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(fixture("valid.toml")) }))
    ))

  it.effect("fails with ConfigNotFound when the file is missing", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip((yield* Config).load("/missing.toml"))
      expect(error._tag).toBe("ConfigNotFound")
    }).pipe(Effect.provide(Config.live), Effect.provide(FileSystem.layerNoop({}))))
})
