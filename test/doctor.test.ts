import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { TestConsole } from "effect/testing"
import { runDoctor } from "../src/commands/doctor.ts"
import { GitCommandFailed } from "../src/errors.ts"
import { Config, type ZwtConfig } from "../src/services/Config.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { Git } from "../src/services/Git.ts"

const source = readFileSync(new URL("./fixtures/valid.toml", import.meta.url), "utf8")
const configLayer = Config.live.pipe(
  Layer.provide(FileSystem.layerNoop({
    readFileString: () => Effect.succeed(source),
    writeFileString: () => Effect.die("doctor must not write config")
  }))
)
const repo = "/home/jane/work/acme/web"
const home = "/home/jane"
const configFile = "/cfg/zwt.toml"
const hooksUnset = new GitCommandFailed({ args: ["config", "--get", "core.hooksPath"], exitCode: 1, stderr: "" })
const notRepo = new GitCommandFailed({ args: ["rev-parse", "--show-toplevel"], exitCode: 128, stderr: "fatal: not a git repository" })

const matching = {
  "rev-parse --show-toplevel": repo,
  "config --get user.email": "jane.doe@example.com",
  "remote get-url origin": "git@gitlab.com:acme/web.git",
  "config --get core.hooksPath": hooksUnset
}

const isWrite = (call: ReadonlyArray<string>) =>
  call[0] === "fetch" ||
  (call[0] === "worktree" && call[1] === "add") ||
  (call[0] === "config" && (call.includes("--worktree") || (call[1] === "--local" && !call.includes("--get"))))

const logged = (lines: ReadonlyArray<unknown>) => lines.map(String).join("\n")

const provide = (fake: ReturnType<typeof Git.fake>, config: Layer.Layer<Config> = configLayer) =>
  Layer.mergeAll(fake.layer, config, TestConsole.layer, DryRunLog.layer)

const doctor = (options: {
  readonly all?: boolean
  readonly output?: "text" | "json"
  readonly path?: Option.Option<string>
  readonly cwd?: string
} = {}) =>
  runDoctor({
    all: options.all ?? false,
    output: options.output ?? "text",
    path: options.path ?? Option.none(),
    cwd: options.cwd ?? repo,
    home,
    configFile
  })

describe("zwt doctor", () => {
  it("does not branch on the dry-run flag", () => {
    const text = readFileSync(new URL("../src/commands/doctor.ts", import.meta.url), "utf8")
    expect(text.includes("DryRun")).toBe(false)
    expect(text.includes("dry-run")).toBe(false)
    expect(text.includes("dryRun")).toBe(false)
    expect(text.includes("configSet")).toBe(false)
  })

  it.effect("reports a matching email, a matching origin and the git default hooks path", () => {
    const fake = Git.fake(matching)
    return Effect.gen(function*() {
      yield* doctor()
      expect(logged(yield* TestConsole.logLines)).toBe(
        [
          "identity ok matches jane.doe@example.com",
          "expect_remote ok origin contains gitlab.com:acme/",
          "hooksPath ok git default"
        ].join("\n")
      )
      expect(yield* (yield* DryRunLog).planned).toEqual([])
      expect(fake.calls.some(isWrite)).toBe(false)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("fails a mismatched email and still reports the other checks", () => {
    const fake = Git.fake({
      ...matching,
      "config --get user.email": "other@example.com",
      "remote get-url origin": new GitCommandFailed({
        args: ["remote", "get-url", "origin"],
        exitCode: 2,
        stderr: "error: No such remote 'origin'"
      })
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(doctor())
      expect(error._tag).toBe("DoctorFailed")
      if (error._tag === "DoctorFailed") {
        expect(error.message).toBe("2 checks failed")
        expect(error.fix).toContain(`git -C ${repo} config --worktree user.email jane.doe@example.com`)
        expect(error.fix).toContain("includeIf")
        expect(error.fix).toContain(`git -C ${repo} remote add origin`)
      }
      const text = logged(yield* TestConsole.logLines)
      expect(text).toContain("identity fail")
      expect(text).toContain("expect_remote fail")
      expect(text).toContain("hooksPath ok git default")
      expect(text).toContain("  fix: git -C")
      expect(fake.calls.some(isWrite)).toBe(false)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("fails an unresolved email without saying the selector was skipped", () => {
    const outside = "/srv/other/tool"
    const fake = Git.fake({
      "rev-parse --show-toplevel": outside,
      "config --get user.email": "jane@example.com",
      "config --get core.hooksPath": hooksUnset
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(doctor({ cwd: outside }))
      expect(error._tag).toBe("DoctorFailed")
      if (error._tag === "DoctorFailed") {
        expect(error.message).toBe("1 check failed")
        expect(error.fix).toContain("zwt identity set")
        expect(error.fix.includes("selector skipped")).toBe(false)
      }
      expect(logged(yield* TestConsole.logLines)).toContain("expect_remote ok no expect_remote")
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("accepts a repo with no expect_remote", () => {
    const notes = "/home/jane/personal/notes"
    const fake = Git.fake({
      "rev-parse --show-toplevel": notes,
      "config --get user.email": "jane@example.com",
      "config --get core.hooksPath": hooksUnset
    })
    return Effect.gen(function*() {
      yield* doctor({ cwd: notes })
      expect(logged(yield* TestConsole.logLines)).toContain("expect_remote ok no expect_remote")
      expect(fake.calls.some((call) => call[0] === "remote")).toBe(false)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("fails when the origin url misses the substring, including case", () => {
    const fake = Git.fake({ ...matching, "remote get-url origin": "https://GitLab.com/acme/web.git" })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(doctor())
      expect(error._tag).toBe("DoctorFailed")
      if (error._tag === "DoctorFailed") {
        expect(error.fix).toContain(`git -C ${repo} remote set-url origin`)
        expect(error.fix).toContain("gitlab.com:acme/")
      }
      expect(logged(yield* TestConsole.logLines)).toContain("expect_remote fail")
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("warns when hooksPath is set and still exits successfully", () => {
    const fake = Git.fake({ ...matching, "config --get core.hooksPath": "/custom/hooks" })
    return Effect.gen(function*() {
      yield* doctor()
      const text = logged(yield* TestConsole.logLines)
      expect(text).toContain("hooksPath warn /custom/hooks")
      expect(text.includes("hooksPath fail")).toBe(false)
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("normalizes a path argument the same way as identity check", () => {
    const fake = Git.fake({
      [`${repo}\0rev-parse --show-toplevel`]: repo,
      [`${repo}\0config --get user.email`]: "jane.doe@example.com",
      [`${repo}\0remote get-url origin`]: "git@gitlab.com:acme/web.git",
      [`${repo}\0config --get core.hooksPath`]: hooksUnset
    })
    return Effect.gen(function*() {
      yield* doctor({ path: Option.some("~/work/acme/web"), cwd: "/tmp" })
      expect(logged(yield* TestConsole.logLines)).toContain("identity ok matches jane.doe@example.com")
    }).pipe(Effect.provide(provide(fake)))
  })

  it.effect("prints one repo as json and includes fix only on failures", () => {
    const fake = Git.fake({ ...matching, "config --get user.email": "other@example.com" })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(doctor({ output: "json" }))
      expect(error._tag).toBe("DoctorFailed")
      const parsed = JSON.parse(logged(yield* TestConsole.logLines)) as {
        readonly repo: string
        readonly currentEmail: string
        readonly expectedEmail: string
        readonly status: string
        readonly checks: ReadonlyArray<{ readonly name: string; readonly status: string; readonly fix?: string }>
      }
      expect(parsed.repo).toBe(repo)
      expect(parsed.currentEmail).toBe("other@example.com")
      expect(parsed.expectedEmail).toBe("jane.doe@example.com")
      expect(parsed.status).toBe("fail")
      expect(parsed.checks.map((check) => check.name)).toEqual(["identity", "expect_remote", "hooksPath"])
      const identity = parsed.checks[0]
      expect(identity?.status).toBe("fail")
      expect(identity?.fix).toContain("config --worktree user.email")
      expect(parsed.checks[1]?.fix).toBeUndefined()
      expect(parsed.checks[2]?.fix).toBeUndefined()
    }).pipe(Effect.provide(provide(fake)))
  })
})

const allConfig = {
  version: 1 as const,
  identity: {
    personal: { name: "Jane Doe", email: "jane@example.com" },
    work: { name: "Jane Doe", email: "jane.doe@example.com" }
  },
  profile: [
    { match: "/home/jane/wide/**", identity: "personal" },
    { match: "/home/jane/repo/**", identity: "work", expect_remote: "gitlab.com:acme/" },
    { match: "/home/jane/repo/src/**", identity: "personal" },
    { match: "/home/jane/nested/app/**", identity: "personal" },
    { match: "/home/jane/solo/**", identity: "personal" }
  ],
  project: [
    { path: "/home/jane/repo/", identity: "work" },
    { path: "/home/jane/missing", identity: "personal" },
    { path: "/home/jane/nested/app/src", email: "jane.ext@example.com" }
  ]
} satisfies ZwtConfig

const allLayer = Layer.succeed(Config, {
  load: () => Effect.succeed(allConfig),
  upsertProject: () => Effect.die("doctor must not write config")
})

const key = (cwd: string, args: string) => `${cwd}\0${args}`

const allResponses = {
  [key("/home/jane/repo", "rev-parse --show-toplevel")]: "/home/jane/repo",
  [key("/home/jane/missing", "rev-parse --show-toplevel")]: notRepo,
  [key("/home/jane/nested/app/src", "rev-parse --show-toplevel")]: "/home/jane/nested/app",
  [key("/home/jane/wide", "rev-parse --show-toplevel")]: notRepo,
  [key("/home/jane/repo/src", "rev-parse --show-toplevel")]: "/home/jane/repo",
  [key("/home/jane/solo", "rev-parse --show-toplevel")]: "/home/jane/solo",
  [key("/home/jane/repo", "config --get user.email")]: "jane.doe@example.com",
  [key("/home/jane/repo", "remote get-url origin")]: "git@gitlab.com:acme/repo.git",
  [key("/home/jane/repo", "config --get core.hooksPath")]: hooksUnset,
  [key("/home/jane/nested/app", "config --get user.email")]: "jane@example.com",
  [key("/home/jane/nested/app", "config --get core.hooksPath")]: hooksUnset,
  [key("/home/jane/solo", "config --get user.email")]: "jane@example.com",
  [key("/home/jane/solo", "config --get core.hooksPath")]: hooksUnset
}

describe("zwt doctor --all", () => {
  it.effect("lists project toplevels, skips non-repo profile roots, and continues after a bad path", () => {
    const fake = Git.fake(allResponses)
    return Effect.gen(function*() {
      const error = yield* Effect.flip(doctor({ all: true, path: Option.some("/home/jane/ignored"), cwd: "/home/jane/ignored" }))
      expect(error._tag).toBe("DoctorFailed")
      if (error._tag === "DoctorFailed") expect(error.fix).toContain(`edit ${configFile}`)
      const text = logged(yield* TestConsole.logLines)
      expect(text.startsWith("repo | current email | expected email | status\n")).toBe(true)
      const rows = text.split("\n").filter((line) => line.startsWith("/")).map((line) => line.split(" | ")[0])
      expect(rows).toEqual([
        "/home/jane/repo",
        "/home/jane/missing",
        "/home/jane/nested/app",
        "/home/jane/solo"
      ])
      expect(text.includes("/home/jane/wide")).toBe(false)
      expect(text.includes("/home/jane/ignored")).toBe(false)
      expect(text.includes("/home/jane/repo/src")).toBe(false)
      expect(text.includes("/home/jane/nested/app/src")).toBe(false)
      expect(text).toContain("/home/jane/repo | jane.doe@example.com | jane.doe@example.com | ok")
      expect(text).toContain("/home/jane/missing | (unset) | (unresolved) | fail")
      expect(text).toContain("/home/jane/nested/app | jane@example.com | jane@example.com | ok")
      expect(text).toContain(`edit ${configFile}: [[project]] path /home/jane/missing is not a git repository`)
      expect(text.includes("git init")).toBe(false)
      expect(fake.calls.some(isWrite)).toBe(false)
    }).pipe(Effect.provide(provide(fake, allLayer)))
  })

  it.effect("prints the same rows as json", () => {
    const fake = Git.fake(allResponses)
    return Effect.gen(function*() {
      yield* Effect.flip(doctor({ all: true, output: "json" }))
      const parsed = JSON.parse(logged(yield* TestConsole.logLines)) as {
        readonly repos: ReadonlyArray<{
          readonly repo: string
          readonly status: string
          readonly checks: ReadonlyArray<{ readonly name: string; readonly fix?: string }>
        }>
      }
      expect(parsed.repos.map((row) => row.repo)).toEqual([
        "/home/jane/repo",
        "/home/jane/missing",
        "/home/jane/nested/app",
        "/home/jane/solo"
      ])
      expect(parsed.repos[0]?.status).toBe("ok")
      expect(parsed.repos[0]?.checks.every((check) => check.fix === undefined)).toBe(true)
      expect(parsed.repos[1]?.checks[0]).toMatchObject({ name: "repository" })
      expect(parsed.repos[1]?.checks[0]?.fix).toContain(configFile)
    }).pipe(Effect.provide(provide(fake, allLayer)))
  })

  it.effect("prints only the header when nothing is configured", () => {
    const empty = Layer.succeed(Config, {
      load: () => Effect.succeed({ version: 1 as const, identity: {} }),
      upsertProject: () => Effect.die("doctor must not write config")
    })
    const fake = Git.fake({})
    return Effect.gen(function*() {
      yield* doctor({ all: true })
      expect(logged(yield* TestConsole.logLines)).toBe("repo | current email | expected email | status")
    }).pipe(Effect.provide(provide(fake, empty)))
  })

  it.effect("prints an empty repos array as json when nothing is configured", () => {
    const empty = Layer.succeed(Config, {
      load: () => Effect.succeed({ version: 1 as const, identity: {} }),
      upsertProject: () => Effect.die("doctor must not write config")
    })
    return Effect.gen(function*() {
      yield* doctor({ all: true, output: "json" })
      expect(JSON.parse(logged(yield* TestConsole.logLines))).toEqual({ repos: [] })
    }).pipe(Effect.provide(provide(Git.fake({}), empty)))
  })

  it.effect("stops the scan when git fails for a reason other than a missing repo", () => {
    const broken = Layer.succeed(Config, {
      load: () =>
        Effect.succeed({
          version: 1 as const,
          identity: { personal: { name: "Jane Doe", email: "jane@example.com" } },
          project: [{ path: "/home/jane/repo", identity: "personal" }, { path: "/home/jane/next", identity: "personal" }]
        }),
      upsertProject: () => Effect.die("doctor must not write config")
    })
    const fake = Git.fake({
      [key("/home/jane/repo", "rev-parse --show-toplevel")]: new GitCommandFailed({
        args: ["rev-parse", "--show-toplevel"],
        exitCode: 1,
        stderr: "boom"
      })
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(doctor({ all: true }))
      expect(error._tag).toBe("GitCommandFailed")
      expect(logged(yield* TestConsole.logLines)).toBe("")
    }).pipe(Effect.provide(provide(fake, broken)))
  })
})
