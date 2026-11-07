import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { expandHome, isValidSlug, matchingRemote, profileRoot, remoteIdentityClash, resolveBase, resolveExpectRemote, resolveIdentityKey, resolveNew } from "../src/resolve.ts"
import { parseConfig, type ZwtConfig } from "../src/services/Config.ts"

const source = readFileSync(new URL("./fixtures/valid.toml", import.meta.url), "utf8")
const none = {
  base: Option.none<string>(),
  prefix: Option.none<string>(),
  email: Option.none<string>(),
  identity: Option.none<string>()
}
const home = "/home/jane"

describe("paths", () => {
  it("expands ~ only at the start", () => {
    expect(expandHome("~/work", home)).toBe("/home/jane/work")
    expect(expandHome("~", home)).toBe(home)
    expect(expandHome("/abs/~x", home)).toBe("/abs/~x")
    expect(profileRoot("~/work/acme/**", home)).toBe("/home/jane/work/acme")
  })

  it("accepts plain slugs only", () => {
    expect(isValidSlug("fix-login_2.1")).toBe(true)
    for (const bad of ["", "a/b", "../x", ".hidden", "a b", "a..b"]) expect(isValidSlug(bad)).toBe(false)
  })
})

describe("resolveBase", () => {
  it.effect("matches zwt new when --base is absent", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      expect(resolveBase({ config, repoRoot: "/home/jane/work/acme/backend/api", home })).toBe("main")
      expect(resolveBase({ config, repoRoot: "/home/jane/work/acme/web", home })).toBe("develop")
      expect(resolveBase({ config, repoRoot: "/srv/other/tool", home })).toBe("main")
      const fromFlags = resolveNew({
        config,
        repoRoot: "/home/jane/work/acme/web",
        slug: "x",
        home,
        flags: { ...none, base: Option.some("release") }
      })
      expect(fromFlags.base).toBe("release")
    }))
})

describe("resolveNew precedence: flag > project > profile > defaults", () => {
  it.effect("profile sets prefix, base and identity", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const plan = resolveNew({ config, repoRoot: "/home/jane/work/acme/web", slug: "login", home, flags: none })
      expect(plan).toEqual({
        branch: "feature/login",
        base: "develop",
        worktreePath: "/home/jane/work/acme/worktrees/web/login",
        scratchDir: ".scratch",
        identity: { _tag: "Resolved", identity: { name: "Jane Doe", email: "jane.doe@example.com" } }
      })
    }))

  it.effect("project overrides profile, flags override both", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const repoRoot = "/home/jane/work/acme/backend/api"
      const fromProject = resolveNew({ config, repoRoot, slug: "x", home, flags: none })
      expect(fromProject.base).toBe("main")
      expect(fromProject.identity).toEqual({ _tag: "Resolved", identity: { name: "Jane Doe", email: "jane.ext@example.com" } })
      const fromFlags = resolveNew({
        config,
        repoRoot,
        slug: "x",
        home,
        flags: { ...none, base: Option.some("release"), prefix: Option.some("hotfix/") }
      })
      expect([fromFlags.base, fromFlags.branch]).toEqual(["release", "hotfix/x"])
    }))

  it.effect("resolveBase follows project, then profile, then main", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      expect(resolveBase({ config, repoRoot: "/home/jane/work/acme/backend/api", home })).toBe("main")
      expect(resolveBase({ config, repoRoot: "/home/jane/work/acme/web", home })).toBe("develop")
      expect(resolveBase({ config, repoRoot: "/home/jane/personal/notes/", home })).toBe("main")
      expect(resolveBase({ config, repoRoot: "/srv/other/tool", home })).toBe("main")
    }))

  it.effect("defaults apply and identity stays unresolved outside every profile", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const plan = resolveNew({ config, repoRoot: "/srv/other/tool", slug: "x", home, flags: none })
      expect(plan).toMatchObject({ branch: "x", base: "main", worktreePath: "/srv/other/worktrees/tool/x" })
      expect(plan.identity).toEqual({ _tag: "Unresolved" })
    }))

  it.effect("deepest profile wins and ~ in worktrees_dir is absolute", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig(
        "x.toml",
        source.replace('worktrees_dir = "worktrees"', 'worktrees_dir = "~/wt"') +
          '\n[[profile]]\nmatch = "~/work/acme/mobile/**"\nidentity = "personal"\nbranch_prefix = "m/"\n'
      )
      const plan = resolveNew({ config, repoRoot: "/home/jane/work/acme/mobile/app", slug: "x", home, flags: none })
      expect(plan.branch).toBe("m/x")
      expect(plan.worktreePath).toBe("/home/jane/wt/app/x")
    }))

  it.effect("email flag beats a project email, identity flag beats the project mapping", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const repoRoot = "/home/jane/work/acme/backend/api"
      const byEmail = resolveNew({ config, repoRoot, slug: "x", home, flags: { ...none, email: Option.some("flag@example.com") } })
      expect(byEmail.identity).toEqual({ _tag: "Resolved", identity: { name: "Jane Doe", email: "flag@example.com" } })
      const byName = resolveNew({
        config,
        repoRoot,
        slug: "x",
        home,
        flags: { ...none, identity: Option.some("personal") }
      })
      expect(byName.identity).toEqual({ _tag: "Resolved", identity: { name: "Jane Doe", email: "jane@example.com" } })
      const both = resolveNew({
        config,
        repoRoot,
        slug: "x",
        home,
        flags: { ...none, identity: Option.some("personal"), email: Option.some("flag@example.com") }
      })
      expect(both.identity).toEqual({ _tag: "Resolved", identity: { name: "Jane Doe", email: "flag@example.com" } })
    }))

  it.effect("an unknown identity flag is not a prompt, and a bare email still resolves", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const unknown = resolveNew({
        config,
        repoRoot: "/srv/other/tool",
        slug: "x",
        home,
        flags: { ...none, identity: Option.some("missing") }
      })
      expect(unknown.identity).toEqual({ _tag: "Unknown", name: "missing" })
      const emailOnly = resolveNew({
        config,
        repoRoot: "/srv/other/tool",
        slug: "x",
        home,
        flags: { ...none, email: Option.some("only@example.com") }
      })
      expect(emailOnly.identity).toEqual({ _tag: "Resolved", identity: { name: "only", email: "only@example.com" } })
    }))

  it.effect("expect_remote comes from the deepest profile only", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      expect(resolveExpectRemote({ config, repoRoot: "/home/jane/work/acme/backend/api", home })).toBe("gitlab.com:acme/")
      expect(resolveExpectRemote({ config, repoRoot: "/home/jane/personal/notes", home })).toBeUndefined()
      expect(resolveExpectRemote({ config, repoRoot: "/srv/other/tool", home })).toBeUndefined()
      const deeper = yield* parseConfig(
        "x.toml",
        `${source}\n[[profile]]\nmatch = "~/work/acme/backend/**"\nidentity = "work"\n`
      )
      expect(resolveExpectRemote({ config: deeper, repoRoot: "/home/jane/work/acme/backend/api", home })).toBeUndefined()
    }))

  it.effect("scratch_dir defaults to .scratch when the key is omitted", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig(
        "min.toml",
        ["version = 1", "[identity.personal]", 'name = "Ada"', 'email = "ada@example.com"'].join("\n")
      )
      const plan = resolveNew({ config, repoRoot: "/srv/tool", slug: "x", home, flags: none })
      expect(plan.scratchDir).toBe(".scratch")
    }))
})

describe("[[remote]] identity", () => {
  const config = {
    version: 1 as const,
    identity: {
      personal: { name: "Jane Doe", email: "jane@example.com" },
      external: { name: "Jane External", email: "jane.external@example.com" }
    },
    profile: [{ match: "/home/jane/work/acme/**", identity: "personal" }],
    project: [{ path: "/home/jane/work/acme/web", identity: "external" }],
    remote: [
      { pattern: "github.com/", identity: "personal" },
      { pattern: "github.com/other-org/", identity: "external" },
      { pattern: "abc", identity: "personal" },
      { pattern: "bcy", identity: "external" }
    ]
  } satisfies ZwtConfig

  it("uses the longest substring and keeps the earlier entry on a tie", () => {
    expect(matchingRemote(config.remote, "https://github.com/other-org/app.git")?.identity).toBe("external")
    expect(matchingRemote(config.remote, "git@github.com:other-org/app.git")).toBeUndefined()
    expect(matchingRemote(config.remote, "https://GitHub.com/other-org/app.git")).toBeUndefined()
    expect(matchingRemote(
      [{ pattern: "github.com/other-org/*", identity: "external" }],
      "https://github.com/other-org/app.git"
    )).toBeUndefined()
    expect(matchingRemote(config.remote, "xxabcyy")?.identity).toBe("personal")
    expect(remoteIdentityClash({
      config,
      origin: "https://github.com/other-org/app.git",
      identityKey: "personal",
      email: "jane@example.com"
    })).toEqual({ pattern: "github.com/other-org/", required: "external", actual: "personal" })
    expect(remoteIdentityClash({
      config,
      origin: "https://github.com/acme/app.git",
      identityKey: "personal",
      email: "jane@example.com"
    })).toBeUndefined()
    expect(remoteIdentityClash({
      config,
      origin: undefined,
      identityKey: "personal",
      email: "jane@example.com"
    })).toBeUndefined()
    expect(remoteIdentityClash({
      config,
      origin: "https://github.com/other-org/app.git",
      identityKey: undefined,
      email: "jane.external@example.com"
    })).toBeUndefined()
    expect(remoteIdentityClash({
      config,
      origin: "https://github.com/other-org/app.git",
      identityKey: undefined,
      email: "jane@example.com"
    })).toEqual({ pattern: "github.com/other-org/", required: "external", actual: "jane@example.com" })
    expect(remoteIdentityClash({
      config,
      origin: "https://github.com/other-org/app.git",
      identityKey: undefined,
      email: undefined
    })).toEqual({ pattern: "github.com/other-org/", required: "external", actual: "(unresolved)" })
  })

  it("prefers the project identity key over the profile", () => {
    expect(resolveIdentityKey({
      config,
      repoRoot: "/home/jane/work/acme/web",
      home,
      flags: { identity: Option.none() }
    })).toBe("external")
    expect(resolveIdentityKey({
      config,
      repoRoot: "/home/jane/work/acme/other",
      home,
      flags: { identity: Option.none() }
    })).toBe("personal")
  })
})
