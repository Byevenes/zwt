import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { expandHome, formatLaunch, isValidSlug, launchArgv, matchingRemote, profileRoot, remoteIdentityClash, resolveBase, resolveExpectRemote, resolveIdentityKey, resolveLaunchCommand, resolveNew, resolvePrefix, resolveWorktreePath } from "../src/resolve.ts"
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

describe("base, prefix and worktree path", () => {
  it.effect("follows project, then profile, then defaults", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("valid.toml", source)
      const repoRoot = "/home/jane/work/acme/web"
      expect(resolveBase({ config, repoRoot, home })).toBe("develop")
      expect(resolvePrefix({ config, repoRoot, home })).toBe("feature/")
      expect(resolveWorktreePath({ config, repoRoot, home, slug: "login" })).toBe("/home/jane/work/acme/worktrees/web/login")
      expect(resolveBase({ config, repoRoot: "/home/jane/work/acme/backend/api", home })).toBe("main")
      expect(resolveBase({ config, repoRoot: "/tmp/other", home })).toBe("main")
      expect(resolvePrefix({ config, repoRoot: "/tmp/other", home })).toBe("")
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

  it.effect("launch commands come from the deepest profile and are not a shell", () =>
    Effect.gen(function*() {
      const withCommand = source.replace(
        'branch_prefix = "feature/"',
        'branch_prefix = "feature/"\nopen_command = "editor --flag"\nagent_command = "agent"'
      )
      const config = yield* parseConfig("x.toml", withCommand)
      const repoRoot = "/home/jane/work/acme/web"
      expect(resolveLaunchCommand({ config, repoRoot, home, kind: "open" })).toBe("editor --flag")
      expect(resolveLaunchCommand({ config, repoRoot, home, kind: "agent" })).toBe("agent")
      expect(resolveLaunchCommand({ config, repoRoot: "/srv/other/tool", home, kind: "open" })).toBeUndefined()
      const path = "/home/jane/work/acme/worktrees/web/login"
      expect(launchArgv("editor --flag", "open", path)).toEqual(["editor", "--flag", path])
      expect(launchArgv("agent", "agent", path)).toEqual(["agent"])
      expect(launchArgv("editor && notify", "open", path)).toEqual(["editor", "&&", "notify", path])
      expect(formatLaunch("open", ["editor", path], path)).toBe(`editor ${path}`)
      expect(formatLaunch("agent", ["agent"], path)).toBe(`(cwd ${path}) agent`)
      expect(formatLaunch("open", ["editor", "/tmp/my work"], "/tmp/my work")).toBe('editor "/tmp/my work"')
      const deeper = yield* parseConfig(
        "x.toml",
        `${withCommand}\n[[profile]]\nmatch = "~/work/acme/web/**"\nidentity = "personal"\n`
      )
      expect(resolveLaunchCommand({ config: deeper, repoRoot, home, kind: "open" })).toBeUndefined()
      const inner = yield* parseConfig(
        "x.toml",
        `${withCommand}\n[[profile]]\nmatch = "~/work/acme/web/**"\nidentity = "personal"\nopen_command = "inner"\n`
      )
      expect(resolveLaunchCommand({ config: inner, repoRoot, home, kind: "open" })).toBe("inner")
      expect(resolveLaunchCommand({ config: inner, repoRoot, home, kind: "agent" })).toBeUndefined()
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

const ticketToml = (profile: string) =>
  [
    "version = 1",
    "[identity.personal]",
    'name = "Ada"',
    'email = "ada@example.com"',
    "[[profile]]",
    'match = "~/work/**"',
    'identity = "personal"',
    'branch_prefix = "feature/"',
    profile
  ].join("\n")

describe("branch template", () => {
  const repoRoot = "/home/jane/work/acme/web"
  const pattern = 'ticket_pattern = "[A-Z][A-Z0-9]+-[0-9]+"\nbranch_template = "feature/{ticket}-{slug}"'

  it.effect("keeps prefix plus slug when no template is set", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("t.toml", ticketToml('ticket_pattern = "[A-Z][A-Z0-9]+-[0-9]+"'))
      const plan = resolveNew({ config, repoRoot, slug: "ABC-123", home, flags: none })
      expect(plan.branch).toBe("feature/ABC-123")
      expect(plan.branchError).toBeUndefined()
      expect(plan.worktreePath).toBe("/home/jane/work/acme/worktrees/web/ABC-123")
    }))

  it.effect("builds the branch from the ticket key and drops an empty slug", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("t.toml", ticketToml(pattern))
      const keyOnly = resolveNew({ config, repoRoot, slug: "ABC-123", home, flags: none })
      expect(keyOnly.branch).toBe("feature/ABC-123")
      expect(keyOnly.branchError).toBeUndefined()
      expect(keyOnly.worktreePath).toBe("/home/jane/work/acme/worktrees/web/ABC-123")
      const described = resolveNew({ config, repoRoot, slug: "ABC-123-fix-login", home, flags: none })
      expect(described.branch).toBe("feature/ABC-123-fix-login")
      expect(described.worktreePath).toBe("/home/jane/work/acme/worktrees/web/ABC-123-fix-login")
      const underscored = resolveNew({ config, repoRoot, slug: "ABC-123_fix-login", home, flags: none })
      expect(underscored.branch).toBe("feature/ABC-123-fix-login")
    }))

  it.effect("stops when the slug does not start with the ticket key", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("t.toml", ticketToml(pattern))
      const plan = resolveNew({ config, repoRoot, slug: "fix-ABC-123", home, flags: none })
      expect(plan.branch).toBe("")
      expect(plan.branchError).toEqual({ _tag: "TicketMissing", pattern: "[A-Z][A-Z0-9]+-[0-9]+" })
      const lower = resolveNew({ config, repoRoot, slug: "abc-123", home, flags: none })
      expect(lower.branchError?._tag).toBe("TicketMissing")
    }))

  it.effect("uses {prefix} and {slug} without requiring a ticket", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("t.toml", ticketToml('branch_template = "{prefix}{slug}"'))
      const plan = resolveNew({ config, repoRoot, slug: "login", home, flags: none })
      expect(plan.branch).toBe("feature/login")
      expect(plan.branchError).toBeUndefined()
    }))

  it.effect("puts the ticket in its own path segment", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig(
        "t.toml",
        ticketToml('ticket_pattern = "[A-Z][A-Z0-9]+-[0-9]+"\nbranch_template = "{ticket}/{slug}"')
      )
      const described = resolveNew({ config, repoRoot, slug: "ABC-123-fix-login", home, flags: none })
      expect(described.branch).toBe("ABC-123/fix-login")
      const keyOnly = resolveNew({ config, repoRoot, slug: "ABC-123", home, flags: none })
      expect(keyOnly.branch).toBe("ABC-123")
    }))

  it.effect("--prefix skips the template and keeps the whole slug", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("t.toml", ticketToml(pattern))
      const plan = resolveNew({
        config,
        repoRoot,
        slug: "login",
        home,
        flags: { ...none, prefix: Option.some("hotfix/") }
      })
      expect(plan.branch).toBe("hotfix/login")
      expect(plan.branchError).toBeUndefined()
    }))

  it.effect("a deeper profile without a template wins over a parent template", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig(
        "t.toml",
        `${ticketToml(pattern)}\n[[profile]]\nmatch = "~/work/acme/**"\nidentity = "personal"\nbranch_prefix = "m/"\n`
      )
      const plan = resolveNew({ config, repoRoot, slug: "ABC-123", home, flags: none })
      expect(plan.branch).toBe("m/ABC-123")
      expect(plan.branchError).toBeUndefined()
    }))

  it.effect("a project base does not replace the profile template", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig(
        "t.toml",
        `${ticketToml(pattern)}\n[[project]]\npath = "~/work/acme/web"\nbase_branch = "release"\n`
      )
      const plan = resolveNew({ config, repoRoot, slug: "ABC-123-fix-login", home, flags: none })
      expect(plan.base).toBe("release")
      expect(plan.branch).toBe("feature/ABC-123-fix-login")
    }))

  it.effect("reports an empty rendered name", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig("t.toml", ticketToml('branch_template = "{prefix}"').replace('branch_prefix = "feature/"\n', ""))
      const plan = resolveNew({ config, repoRoot, slug: "login", home, flags: none })
      expect(plan.branchError).toEqual({ _tag: "Empty" })
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
