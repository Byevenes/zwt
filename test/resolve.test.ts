import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { expandHome, isValidSlug, profileRoot, resolveNew } from "../src/resolve.ts"
import { parseConfig } from "../src/services/Config.ts"

const source = readFileSync(new URL("./fixtures/valid.toml", import.meta.url), "utf8")
const none = { base: Option.none<string>(), prefix: Option.none<string>() }
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
        identity: Option.some({ name: "Jane Doe", email: "jane.doe@company.example" })
      })
    }))

  it.effect("project overrides profile, flags override both", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const repoRoot = "/home/jane/work/acme/backend/api"
      const fromProject = resolveNew({ config, repoRoot, slug: "x", home, flags: none })
      expect(fromProject.base).toBe("main")
      expect(fromProject.identity).toEqual(Option.some({ name: "Jane Doe", email: "jane@acme.example" }))
      const fromFlags = resolveNew({
        config,
        repoRoot,
        slug: "x",
        home,
        flags: { base: Option.some("release"), prefix: Option.some("hotfix/") }
      })
      expect([fromFlags.base, fromFlags.branch]).toEqual(["release", "hotfix/x"])
    }))

  it.effect("defaults apply and identity stays unresolved outside every profile", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const plan = resolveNew({ config, repoRoot: "/srv/other/tool", slug: "x", home, flags: none })
      expect(plan).toMatchObject({ branch: "x", base: "main", worktreePath: "/srv/other/worktrees/tool/x" })
      expect(Option.isNone(plan.identity)).toBe(true)
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
})
