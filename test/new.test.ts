import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, PlatformError } from "effect"
import { TestConsole } from "effect/testing"
import { newWorktree } from "../src/commands/new.ts"
import { GitCommandFailed } from "../src/errors.ts"
import { Config, parseConfig } from "../src/services/Config.ts"
import { Git } from "../src/services/Git.ts"
import { Prompt } from "../src/services/Prompt.ts"

const source = readFileSync(new URL("./fixtures/valid.toml", import.meta.url), "utf8")
const ticketSource = [
  "version = 1",
  "[identity.work]",
  'name = "Jane Doe"',
  'email = "jane.doe@example.com"',
  "[[profile]]",
  'match = "~/work/acme/**"',
  'identity = "work"',
  'base_branch = "develop"',
  'branch_prefix = "feature/"',
  'ticket_pattern = "[A-Z][A-Z0-9]+-[0-9]+"',
  'branch_template = "feature/{ticket}-{slug}"'
].join("\n")
const configLayer = Config.live.pipe(Layer.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(source) })))
const repo = "/home/jane/work/acme/web"
const options = (slug = "login") => ({
  slug,
  cwd: repo,
  home: "/home/jane",
  configFile: "/cfg/zwt.toml",
  flags: {
    base: Option.none<string>(),
    prefix: Option.none<string>(),
    email: Option.none<string>(),
    identity: Option.none<string>()
  },
  interactive: false,
  strict: false
})
const notFound = (args: string) => new GitCommandFailed({ args: args.split(" "), exitCode: 1, stderr: "" })

const baseResponses = {
  "rev-parse --show-toplevel": repo,
  "worktree list --porcelain": `worktree ${repo}\nHEAD abc\nbranch refs/heads/main`,
  "remote": "origin",
  "fetch --quiet origin develop": "",
  "rev-parse --verify --quiet refs/remotes/origin/develop^{commit}": "abc",
  "worktree add -b feature/login /home/jane/work/acme/worktrees/web/login origin/develop": "",
  "config --local --get extensions.worktreeConfig": notFound("config --local --get extensions.worktreeConfig"),
  "config --local extensions.worktreeConfig true": "",
  "config --worktree user.name Jane Doe": "",
  "config --worktree user.email jane.doe@example.com": "",
  "config --get user.email": "jane.doe@example.com",
  "config --show-origin --get user.email":
    "file:/home/jane/work/acme/worktrees/web/login/.git/config.worktree\tjane.doe@example.com",
  "rev-parse --git-path info/exclude": ".git/info/exclude"
}

const excludeFile = `${repo}/.git/info/exclude`

const excludeRecorder = (
  read: (path: string) => Effect.Effect<string, PlatformError.PlatformError> = () => Effect.succeed("")
) => {
  const writes: Array<{ readonly path: string; readonly data: string }> = []
  const layer = FileSystem.layerNoop({
    readFileString: read,
    writeFileString: (path, data) => Effect.sync(() => {
      writes.push({ path, data })
    })
  })
  return { writes, layer }
}

const runtime = (
  fake: ReturnType<typeof Git.fake>,
  prompt = Prompt.scripted({}),
  files = excludeRecorder()
) => Layer.mergeAll(fake.layer, configLayer, prompt, files.layer)

const remoteSource = `${source}
[identity.external]
name = "Jane External"
email = "jane.external@example.com"

[[remote]]
pattern = "github.com/other-org/"
identity = "external"
`
const remoteConfig = Layer.succeed(Config, {
  load: () => parseConfig("remote.toml", remoteSource),
  upsertProject: () => Effect.die("not saved")
})
const logged = (lines: ReadonlyArray<unknown>) => lines.map(String).join("\n")
const withRemote = (fake: ReturnType<typeof Git.fake>, files = excludeRecorder()) =>
  Layer.mergeAll(fake.layer, remoteConfig, Prompt.scripted({}), files.layer, TestConsole.layer)
const otherOrg = "https://github.com/other-org/web.git"

describe("zwt new with a fake Git layer", () => {
  it("does not branch on the dry-run flag", () => {
    const text = readFileSync(new URL("../src/commands/new.ts", import.meta.url), "utf8")
    expect(text.includes("DryRun")).toBe(false)
    expect(text.includes("dry-run")).toBe(false)
    expect(text.includes("dryRun")).toBe(false)
  })

  it.effect("fetches the base and creates the branch from origin", () => {
    const fake = Git.fake(baseResponses)
    const files = excludeRecorder(() => Effect.succeed("# comments\n"))
    return Effect.gen(function*() {
      const result = yield* newWorktree(options())
      expect(result).toMatchObject({
        _tag: "Created",
        branch: "feature/login",
        base: "origin/develop",
        email: "jane.doe@example.com"
      })
      expect(fake.calls.map((c) => c.join(" "))).toContain("fetch --quiet origin develop")
      expect(fake.calls.map((c) => c.join(" "))).toContain("config --worktree user.email jane.doe@example.com")
      expect(fake.calls.some((c) => c.includes("--global"))).toBe(false)
      expect(files.writes).toEqual([{ path: excludeFile, data: "# comments\n.scratch\n" }])
      expect(files.writes.some((write) => write.path.endsWith(".gitignore"))).toBe(false)
    }).pipe(Effect.provide(runtime(fake, Prompt.scripted({}), files)))
  })

  it.effect("does not rewrite info/exclude when the scratch dir is already listed", () => {
    const fake = Git.fake(baseResponses)
    const files = excludeRecorder(() => Effect.succeed("# comments\n.scratch\n"))
    return Effect.gen(function*() {
      expect((yield* newWorktree(options()))._tag).toBe("Created")
      expect(files.writes).toEqual([])
    }).pipe(Effect.provide(runtime(fake, Prompt.scripted({}), files)))
  })

  it.effect("creates info/exclude when the file is missing", () => {
    const fake = Git.fake(baseResponses)
    const files = excludeRecorder(() =>
      Effect.fail(PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: excludeFile
      }))
    )
    return Effect.gen(function*() {
      expect((yield* newWorktree(options()))._tag).toBe("Created")
      expect(files.writes).toEqual([{ path: excludeFile, data: ".scratch\n" }])
    }).pipe(Effect.provide(runtime(fake, Prompt.scripted({}), files)))
  })

  it.effect("appends a configured scratch_dir", () => {
    const fake = Git.fake(baseResponses)
    const files = excludeRecorder()
    const config = Layer.succeed(Config, {
      load: () => parseConfig("valid.toml", source.replace('scratch_dir = ".scratch"', 'scratch_dir = ".notes"')),
      upsertProject: () => Effect.die("not saved")
    })
    return Effect.gen(function*() {
      expect((yield* newWorktree(options()))._tag).toBe("Created")
      expect(files.writes).toEqual([{ path: excludeFile, data: ".notes\n" }])
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, Prompt.scripted({}), files.layer)))
  })

  it.effect("reports the existing worktree on re-run", () => {
    const files = excludeRecorder()
    const fake = Git.fake({
      ...baseResponses,
      "worktree list --porcelain": `worktree ${repo}\nbranch refs/heads/main\n\nworktree /wt/login\nHEAD abc\nbranch refs/heads/feature/login`
    })
    return Effect.gen(function*() {
      expect(yield* newWorktree(options())).toEqual({ _tag: "Exists", path: "/wt/login", branch: "feature/login" })
      expect(fake.calls.some((c) => c[0] === "worktree" && c[1] === "add")).toBe(false)
      expect(files.writes).toEqual([])
    }).pipe(Effect.provide(runtime(fake, Prompt.scripted({}), files)))
  })

  it.effect("fails with BranchNotFound when the base is neither remote nor local", () => {
    const fake = Git.fake({
      ...baseResponses,
      "remote": "",
      "rev-parse --verify --quiet develop^{commit}": notFound("rev-parse")
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree(options()))
      expect(error._tag).toBe("BranchNotFound")
    }).pipe(Effect.provide(runtime(fake)))
  })

  it.effect("fails with IdentityUnresolved outside every profile, before any write", () => {
    const fake = Git.fake({ ...baseResponses, "rev-parse --show-toplevel": "/srv/tool" })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree({ ...options(), cwd: "/srv/tool" }))
      expect(error._tag).toBe("IdentityUnresolved")
      if (error._tag === "IdentityUnresolved") {
        expect(error.fix).toContain('match = "/srv/tool/**"')
        expect(error.fix).toContain("selector skipped in non-interactive mode")
      }
      expect(fake.calls.some((c) => c[0] === "fetch" || c[1] === "add")).toBe(false)
    }).pipe(Effect.provide(runtime(fake)))
  })

  it.effect("rejects slugs that would escape the worktrees dir", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree(options("../x")))
      expect(error._tag).toBe("InvalidSlug")
    }).pipe(Effect.provide(runtime(Git.fake({})))))

  it.effect("uses the selected identity and can save it for the folder", () => {
    const saved: Array<{ file: string; identity: string; path: string }> = []
    const choices: Array<ReadonlyArray<string>> = []
    const config = Layer.succeed(Config, {
      load: () => parseConfig("valid.toml", source),
      upsertProject: (file, entry) => Effect.sync(() => {
        saved.push({ file, identity: entry.identity, path: entry.path })
      })
    })
    const prompt = Layer.succeed(Prompt, {
      confirm: () => Effect.succeed(true),
      select: (_message, offered) => Effect.sync(() => {
        choices.push(offered)
        return "personal"
      })
    })
    const fake = Git.fake({
      ...baseResponses,
      "rev-parse --show-toplevel": "/srv/tool",
      "remote": "",
      "rev-parse --verify --quiet main^{commit}": "abc",
      "worktree add -b login /srv/worktrees/tool/login main": "",
      "config --worktree user.email jane@example.com": "",
      "config --get user.email": "jane@example.com",
      "config --show-origin --get user.email": "file:/srv/worktrees/tool/login/.git/config.worktree\tjane@example.com"
    })
    return Effect.gen(function*() {
      const result = yield* newWorktree({ ...options(), cwd: "/srv/tool", interactive: true })
      expect(result).toMatchObject({ _tag: "Created", email: "jane@example.com", path: "/srv/worktrees/tool/login" })
      expect(choices[0]?.slice().sort()).toEqual(["personal", "work"])
      expect(saved).toEqual([{ file: "/cfg/zwt.toml", identity: "personal", path: "/srv/tool" }])
      expect(fake.calls.some((c) => c.includes("--global"))).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, prompt, excludeRecorder().layer)))
  })

  it.effect("applies the selected identity when the folder save is declined", () => {
    const fake = Git.fake({
      ...baseResponses,
      "rev-parse --show-toplevel": "/srv/tool",
      "remote": "",
      "rev-parse --verify --quiet main^{commit}": "abc",
      "worktree add -b login /srv/worktrees/tool/login main": "",
      "config --worktree user.email jane@example.com": "",
      "config --get user.email": "jane@example.com",
      "config --show-origin --get user.email": "file:/srv/worktrees/tool/login/.git/config.worktree\tjane@example.com"
    })
    const config = Layer.succeed(Config, {
      load: () => parseConfig("valid.toml", source),
      upsertProject: () => Effect.die("save was declined")
    })
    return Effect.gen(function*() {
      const result = yield* newWorktree({ ...options(), cwd: "/srv/tool", interactive: true })
      expect(result).toMatchObject({ _tag: "Created", email: "jane@example.com" })
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, Prompt.scripted({ select: "personal", confirm: false }), excludeRecorder().layer)))
  })

  it.effect("fails with IdentityMismatch when the worktree email does not stick", () => {
    const fake = Git.fake({
      ...baseResponses,
      "config --get user.email": "other@example.com",
      "config --show-origin --get user.email": "file:/repo/.git/config\tother@example.com"
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree(options()))
      expect(error._tag).toBe("IdentityMismatch")
    }).pipe(Effect.provide(runtime(fake)))
  })

  it.effect("rejects an unknown --identity before any write", () => {
    const fake = Git.fake({ "rev-parse --show-toplevel": repo })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree({
        ...options(),
        flags: { ...options().flags, identity: Option.some("missing") }
      }))
      expect(error._tag).toBe("UnknownIdentity")
      expect(fake.calls.some((call) => call[0] === "config" || call[0] === "fetch" || call[1] === "add")).toBe(false)
    }).pipe(Effect.provide(runtime(fake)))
  })

  it.effect("an --email flag is what gets written, ahead of the project", () => {
    const fake = Git.fake({
      ...baseResponses,
      "config --worktree user.email flag@example.com": "",
      "config --get user.email": "flag@example.com",
      "config --show-origin --get user.email":
        "file:/home/jane/work/acme/worktrees/web/login/.git/config.worktree\tflag@example.com"
    })
    return Effect.gen(function*() {
      const result = yield* newWorktree({
        ...options(),
        flags: { ...options().flags, email: Option.some("flag@example.com") }
      })
      expect(result).toMatchObject({ _tag: "Created", email: "flag@example.com" })
    }).pipe(Effect.provide(runtime(fake)))
  })

  it.effect("warns when origin requires another identity and still creates the worktree", () => {
    const fake = Git.fake({ ...baseResponses, "remote get-url origin": otherOrg })
    return Effect.gen(function*() {
      const result = yield* newWorktree(options())
      expect(result).toMatchObject({ _tag: "Created", email: "jane.doe@example.com" })
      const text = logged(yield* TestConsole.errorLines)
      expect(text).toContain(`matches "github.com/other-org/"`)
      expect(text).toContain('requires identity "external"')
      expect(text).toContain('uses "work"')
      expect(text).toContain(`zwt identity set external ${repo}`)
      expect(fake.calls.some((call) => call[0] === "worktree" && call[1] === "add")).toBe(true)
    }).pipe(Effect.provide(withRemote(fake)))
  })

  it.effect("refuses to create when --strict and origin requires another identity", () => {
    const fake = Git.fake({ ...baseResponses, "remote get-url origin": otherOrg })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree({ ...options(), strict: true }))
      expect(error._tag).toBe("RemoteIdentityMismatch")
      if (error._tag === "RemoteIdentityMismatch") expect(error.fix).toBe(`zwt identity set external ${repo}`)
      expect(fake.calls.some((call) => call[0] === "fetch" || (call[0] === "worktree" && call[1] === "add"))).toBe(false)
    }).pipe(Effect.provide(withRemote(fake)))
  })

  it.effect("does not warn when the repo has no origin", () => {
    const fake = Git.fake({
      ...baseResponses,
      "remote": "",
      "remote get-url origin": new GitCommandFailed({
        args: ["remote", "get-url", "origin"],
        exitCode: 2,
        stderr: "error: No such remote 'origin'"
      }),
      "rev-parse --verify --quiet develop^{commit}": "abc",
      "worktree add -b feature/login /home/jane/work/acme/worktrees/web/login develop": ""
    })
    return Effect.gen(function*() {
      expect((yield* newWorktree(options()))._tag).toBe("Created")
      expect(logged(yield* TestConsole.errorLines)).toBe("")
    }).pipe(Effect.provide(withRemote(fake)))
  })

  it.effect("does not warn when origin matches no [[remote]] pattern", () => {
    const fake = Git.fake({ ...baseResponses, "remote get-url origin": "git@gitlab.com:acme/web.git" })
    return Effect.gen(function*() {
      expect((yield* newWorktree(options()))._tag).toBe("Created")
      expect(logged(yield* TestConsole.errorLines)).toBe("")
    }).pipe(Effect.provide(withRemote(fake)))
  })

  it.effect("does not warn when the folder already uses the identity origin requires", () => {
    const fake = Git.fake({
      ...baseResponses,
      "remote get-url origin": otherOrg,
      "config --worktree user.name Jane External": "",
      "config --worktree user.email jane.external@example.com": "",
      "config --get user.email": "jane.external@example.com",
      "config --show-origin --get user.email":
        "file:/home/jane/work/acme/worktrees/web/login/.git/config.worktree\tjane.external@example.com"
    })
    return Effect.gen(function*() {
      const result = yield* newWorktree({
        ...options(),
        flags: { ...options().flags, identity: Option.some("external") }
      })
      expect(result).toMatchObject({ _tag: "Created", email: "jane.external@example.com" })
      expect(logged(yield* TestConsole.errorLines)).toBe("")
    }).pipe(Effect.provide(withRemote(fake)))
  })

  it.effect("leaves an existing worktree alone when origin would require another identity", () => {
    const fake = Git.fake({
      ...baseResponses,
      "remote get-url origin": otherOrg,
      "worktree list --porcelain": `worktree ${repo}\nbranch refs/heads/main\n\nworktree /wt/login\nHEAD abc\nbranch refs/heads/feature/login`
    })
    return Effect.gen(function*() {
      expect(yield* newWorktree({ ...options(), strict: true })).toEqual({
        _tag: "Exists",
        path: "/wt/login",
        branch: "feature/login"
      })
      expect(logged(yield* TestConsole.errorLines)).toBe("")
      expect(fake.calls.some((call) => call[0] === "worktree" && call[1] === "add")).toBe(false)
    }).pipe(Effect.provide(withRemote(fake)))
  })

  it.effect("creates the branch named by the profile template", () => {
    const slug = "ABC-123"
    const path = "/home/jane/work/acme/worktrees/web/ABC-123"
    const fake = Git.fake({
      ...baseResponses,
      "worktree add -b feature/ABC-123 /home/jane/work/acme/worktrees/web/ABC-123 origin/develop": "",
      "config --show-origin --get user.email": `file:${path}/.git/config.worktree\tjane.doe@example.com`
    })
    const config = Layer.succeed(Config, {
      load: () => parseConfig("ticket.toml", ticketSource),
      upsertProject: () => Effect.die("not saved")
    })
    return Effect.gen(function*() {
      const result = yield* newWorktree(options(slug))
      expect(result).toEqual({
        _tag: "Created",
        path,
        branch: "feature/ABC-123",
        base: "origin/develop",
        email: "jane.doe@example.com"
      })
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, Prompt.scripted({}), excludeRecorder().layer)))
  })

  it.effect("does not fetch or create a worktree when the ticket key is missing", () => {
    const fake = Git.fake({ "rev-parse --show-toplevel": repo })
    const config = Layer.succeed(Config, {
      load: () => parseConfig("ticket.toml", ticketSource),
      upsertProject: () => Effect.die("not saved")
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree(options("login")))
      expect(error._tag).toBe("TicketKeyNotFound")
      if (error._tag === "TicketKeyNotFound") {
        expect(error.fix).toContain("zwt new ABC-123-my-task")
        expect(error.message).toContain("/[A-Z][A-Z0-9]+-[0-9]+/")
      }
      expect(fake.calls.some((call) => call[0] === "fetch" || call[1] === "add")).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, Prompt.scripted({}), excludeRecorder().layer)))
  })

  it.effect("does not create a worktree when the template renders an empty branch", () => {
    const fake = Git.fake({ "rev-parse --show-toplevel": repo })
    const config = Layer.succeed(Config, {
      load: () =>
        parseConfig(
          "empty.toml",
          [
            "version = 1",
            "[identity.work]",
            'name = "Jane Doe"',
            'email = "jane.doe@example.com"',
            "[[profile]]",
            'match = "~/work/acme/**"',
            'identity = "work"',
            'branch_template = "{prefix}"'
          ].join("\n")
        ),
      upsertProject: () => Effect.die("not saved")
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree(options()))
      expect(error._tag).toBe("EmptyBranchName")
      expect(fake.calls.some((call) => call[0] === "fetch" || call[1] === "add")).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, Prompt.scripted({}), excludeRecorder().layer)))
  })
})
