import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { expandHome, isValidSlug, profileRoot, resolveNew } from "../src/resolve.ts"
import { parseConfig } from "../src/services/Config.ts"

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

describe("resolveNew precedence: flag > project > profile > defaults", () => {
  it.effect("profile sets prefix, base and identity", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const plan = resolveNew({ config, repoRoot: "/home/jane/work/acme/web", slug: "login", home, flags: none })
      expect(plan).toEqual({
        branch: "feature/login",
        base: "develop",
        worktreePath: "/home/jane/work/acme/worktrees/web/login",
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
})
