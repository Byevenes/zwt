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

  it.effect("round-trips [[remote]] and rejects an unknown identity", () => {
    const remoteToml = [
      "version = 1",
      "",
      "[identity.personal]",
      'name = "Jane Doe"',
      'email = "jane@example.com"',
      "",
      "[identity.external]",
      'name = "Jane External"',
      'email = "jane.external@example.com"',
      "",
      "[[remote]]",
      'pattern = "github.com/other-org/"',
      'identity = "external"'
    ].join("\n")
    return Effect.gen(function*() {
      const config = yield* parseConfig("remote.toml", remoteToml)
      expect(config.remote).toEqual([{ pattern: "github.com/other-org/", identity: "external" }])
      const error = yield* Effect.flip(parseConfig("remote.toml", remoteToml.replace('identity = "external"', 'identity = "ghost"')))
      expect(error.issues[0]).toMatchObject({ path: "remote[0].identity", line: 13 })
      expect(error.issues[0]?.message).toContain('unknown identity "ghost"')
    })
  })

  it.effect("rejects an empty [[remote]] pattern", () =>
    Effect.gen(function*() {
      const source = [
        "version = 1",
        "[identity.external]",
        'name = "Jane External"',
        'email = "jane.external@example.com"',
        "[[remote]]",
        'pattern = ""',
        'identity = "external"'
      ].join("\n")
      const error = yield* Effect.flip(parseConfig("remote.toml", source))
      expect(error.issues[0]?.path).toBe("remote[0].pattern")
      expect(error.issues[0]?.message).toMatch(/substring/)
    }))

  it.effect("accepts examples/zwt.toml", () =>
    Effect.gen(function*() {
      const example = readFileSync(new URL("../examples/zwt.toml", import.meta.url), "utf8")
      const config = yield* parseConfig("examples/zwt.toml", example)
      expect(config.remote?.[0]).toEqual({ pattern: "github.com/other-org/", identity: "external" })
      expect(config.identity.external?.email).toBe("jane.external@example.com")
    }))

  it.effect("accepts a profile ticket pattern and branch template", () =>
    Effect.gen(function*() {
      const source = [
        "version = 1",
        "[identity.personal]",
        'name = "Ada"',
        'email = "ada@example.com"',
        "[[profile]]",
        'match = "~/work/**"',
        'identity = "personal"',
        'ticket_pattern = "[A-Z][A-Z0-9]+-[0-9]+"',
        'branch_template = "feature/{ticket}-{slug}"'
      ].join("\n")
      const config = yield* parseConfig("ticket.toml", source)
      expect(config.profile?.[0]?.ticket_pattern).toBe("[A-Z][A-Z0-9]+-[0-9]+")
      expect(config.profile?.[0]?.branch_template).toBe("feature/{ticket}-{slug}")
    }))

  it.effect("rejects branch templates with unknown or unbalanced placeholders", () =>
    Effect.gen(function*() {
      const profile = (template: string) =>
        [
          "version = 1",
          "[identity.personal]",
          'name = "Ada"',
          'email = "ada@example.com"',
          "[[profile]]",
          'match = "~/work/**"',
          'identity = "personal"',
          `branch_template = ${JSON.stringify(template)}`
        ].join("\n")
      const unknown = yield* Effect.flip(parseConfig("t.toml", profile("feature/{nope}")))
      expect(unknown.issues[0]).toMatchObject({ path: "profile[0].branch_template", line: 8 })
      expect(unknown.issues[0]?.message).toContain("{nope}")
      const open = yield* Effect.flip(parseConfig("t.toml", profile("feature/{slug")))
      expect(open.issues[0]?.message).toMatch(/unmatched brace/)
      const close = yield* Effect.flip(parseConfig("t.toml", profile("feature/slug}")))
      expect(close.issues[0]?.message).toMatch(/unmatched brace/)
      const doubled = yield* Effect.flip(parseConfig("t.toml", profile("{{ticket}}")))
      expect(doubled.issues[0]?.message).toContain("unknown placeholder {{ticket}")
      const plain = yield* Effect.flip(parseConfig("t.toml", profile("feature/static")))
      expect(plain.issues[0]?.message).toMatch(/must include/)
    }))

  it.effect("rejects ticket patterns that are not a non-empty regular expression", () =>
    Effect.gen(function*() {
      const profile = (pattern: string) =>
        [
          "version = 1",
          "[identity.personal]",
          'name = "Ada"',
          'email = "ada@example.com"',
          "[[profile]]",
          'match = "~/work/**"',
          'identity = "personal"',
          `ticket_pattern = ${JSON.stringify(pattern)}`,
          'branch_template = "{ticket}"'
        ].join("\n")
      const star = yield* Effect.flip(parseConfig("t.toml", profile("*")))
      expect(star.issues[0]?.path).toBe("profile[0].ticket_pattern")
      expect(star.issues[0]?.message).toMatch(/regular expression/)
      const emptyMatch = yield* Effect.flip(parseConfig("t.toml", profile("A*")))
      expect(emptyMatch.issues[0]?.message).toMatch(/empty ticket key/)
      const blank = yield* Effect.flip(parseConfig("t.toml", profile("")))
      expect(blank.issues[0]?.message).toMatch(/non-empty/)
    }))

  it.effect("rejects {ticket} when the profile has no ticket_pattern", () =>
    Effect.gen(function*() {
      const source = [
        "version = 1",
        "[identity.personal]",
        'name = "Ada"',
        'email = "ada@example.com"',
        "[[profile]]",
        'match = "~/work/**"',
        'identity = "personal"',
        'branch_template = "{prefix}{slug}"'
      ].join("\n")
      const withoutTicket = yield* parseConfig("t.toml", source)
      expect(withoutTicket.profile?.[0]?.branch_template).toBe("{prefix}{slug}")
      const error = yield* Effect.flip(parseConfig("t.toml", source.replace("{prefix}{slug}", "{ticket}-{slug}")))
      expect(error.issues[0]).toMatchObject({
        path: "profile[0].branch_template",
        message: "placeholder {ticket} needs ticket_pattern on this profile"
      })
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
