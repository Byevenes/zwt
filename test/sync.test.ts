import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { GitCommandFailed } from "../src/errors.ts"
import { isBlocking, renderSyncTable, syncFailure, syncRepos, syncStatuses, type SyncStatus } from "../src/commands/sync.ts"
import { Config, type ZwtConfig } from "../src/services/Config.ts"
import { Git } from "../src/services/Git.ts"

const home = "/home/jane"
const configFile = "/cfg/zwt.toml"
const repo = "/home/jane/work/acme/web"
const local = "a".repeat(40)
const remote = "b".repeat(40)
const failed = (args: ReadonlyArray<string>, exitCode = 1, stderr = "") =>
  new GitCommandFailed({ args, exitCode, stderr })

const work = { name: "Jane Doe", email: "jane.doe@example.com" }

const configOf = (config: ZwtConfig) =>
  Layer.succeed(Config, {
    load: () => Effect.succeed(config),
    upsertProject: () => Effect.die("sync must not write config")
  })

const run = (config: ZwtConfig, fake: ReturnType<typeof Git.fake>) =>
  syncRepos({ home, configFile }).pipe(Effect.provide(Layer.mergeAll(fake.layer, configOf(config))))

const porcelain = (path: string, branch: string) =>
  [`worktree ${path}`, "HEAD abc", `branch refs/heads/${branch}`].join("\n")

const projectConfig = (extra?: Partial<ZwtConfig>): ZwtConfig => ({
  version: 1,
  identity: { work },
  profile: [{ match: "/home/jane/work/acme/**", identity: "work", base_branch: "develop" }],
  project: [{ path: repo, identity: "work", base_branch: "main" }],
  ...extra
})

const ancestorArgs = (ancestor: string, descendant: string) => ["merge-base", "--is-ancestor", ancestor, descendant]

const behind = (branch = "feature"): Record<string, string | GitCommandFailed> => ({
  "rev-parse --show-toplevel": repo,
  "remote": "origin",
  "fetch --quiet origin main": "",
  "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": remote,
  "rev-parse --verify --quiet refs/heads/main^{commit}": local,
  [ancestorArgs(local, remote).join(" ")]: "",
  "worktree list --porcelain": porcelain(repo, branch)
})

const writes = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.some((call) =>
    call[0] === "merge" ||
    call[0] === "reset" ||
    call[0] === "checkout" ||
    call[0] === "stash" ||
    call[0] === "rebase" ||
    call.includes("--global") ||
    call.includes("--force") ||
    call.some((arg) => arg.startsWith("+"))
  )

describe("zwt sync", () => {
  it("does not branch on the dry-run flag", () => {
    const text = readFileSync(new URL("../src/commands/sync.ts", import.meta.url), "utf8")
    expect(text.includes("DryRun")).toBe(false)
    expect(text.includes("dry-run")).toBe(false)
    expect(text.includes("dryRun")).toBe(false)
  })

  it("blocks only the rows that were not brought in line with origin", () => {
    const open = ["fast-forward", "up-to-date", "ahead", "checked-out"] as const satisfies ReadonlyArray<SyncStatus>
    const shut = ["diverged", "missing", "no-remote", "fetch-failed", "not-a-repo"] as const satisfies ReadonlyArray<SyncStatus>
    expect(open.every((status) => !isBlocking(status))).toBe(true)
    expect(shut.every((status) => isBlocking(status))).toBe(true)
    expect([...open, ...shut].sort()).toEqual([...syncStatuses].sort())
  })

  it.effect("returns no rows when nothing is configured", () => {
    const fake = Git.fake({})
    const config = { version: 1 as const, identity: {} } satisfies ZwtConfig
    return Effect.gen(function*() {
      const rows = yield* run(config, fake)
      expect(rows).toEqual([])
      expect(syncFailure(rows)).toBeUndefined()
      expect(renderSyncTable(rows)).toBe("repo | base | status | detail")
      expect(fake.calls).toEqual([])
    })
  })

  it.effect("fast-forwards a base that is behind and not checked out", () => {
    const fake = Git.fake({
      ...behind(),
      "fetch --quiet . refs/remotes/origin/main:refs/heads/main": ""
    })
    const config = {
      version: 1 as const,
      identity: { work },
      project: [{ path: repo, base_branch: "main" }]
    } satisfies ZwtConfig
    return Effect.gen(function*() {
      const rows = yield* run(config, fake)
      expect(rows).toEqual([{
        repo,
        base: "main",
        status: "fast-forward",
        detail: `${local.slice(0, 7)}..${remote.slice(0, 7)}`
      }])
      expect(syncFailure(rows)).toBeUndefined()
      expect(fake.calls.map((call) => call.join(" "))).toEqual([
        "rev-parse --show-toplevel",
        "remote",
        "fetch --quiet origin main",
        "rev-parse --verify --quiet refs/remotes/origin/main^{commit}",
        "rev-parse --verify --quiet refs/heads/main^{commit}",
        ancestorArgs(local, remote).join(" "),
        "worktree list --porcelain",
        "fetch --quiet . refs/remotes/origin/main:refs/heads/main"
      ])
      expect(writes(fake.calls)).toBe(false)
    })
  })

  it.effect("fetches but does not move a checked-out base", () => {
    const fake = Git.fake(behind("main"))
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]).toMatchObject({
        status: "checked-out",
        detail: `origin/main fetched; checked out at ${repo}; local main left unchanged`
      })
      expect(rows[0]?.fix).toBeUndefined()
      expect(syncFailure(rows)).toBeUndefined()
      expect(fake.calls.some((call) => call[0] === "fetch" && call[1] === "--quiet" && call[2] === ".")).toBe(false)
      expect(writes(fake.calls)).toBe(false)
    })
  })

  it.effect("reports a refused update of a checked-out branch without failing the command", () => {
    const spec = "refs/remotes/origin/main:refs/heads/main"
    const args = ["fetch", "--quiet", ".", spec]
    const fake = Git.fake({
      ...behind(),
      [args.join(" ")]: failed(args, 128, "fatal: refusing to fetch into branch 'refs/heads/main' checked out at '/repo'")
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]?.status).toBe("checked-out")
      expect(syncFailure(rows)).toBeUndefined()
      expect(writes(fake.calls)).toBe(false)
    })
  })

  it.effect("reports divergence and does not update the ref", () => {
    const localToRemote = ancestorArgs(local, remote)
    const remoteToLocal = ancestorArgs(remote, local)
    const fake = Git.fake({
      ...behind(),
      [localToRemote.join(" ")]: failed(localToRemote),
      [remoteToLocal.join(" ")]: failed(remoteToLocal)
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]?.status).toBe("diverged")
      expect(rows[0]?.detail).toBe("local main and origin/main have diverged")
      expect(rows[0]?.fix).toContain("does not merge or reset")
      expect(rows[0]?.fix).toContain(`git -C ${repo} log --oneline --left-right main...origin/main`)
      const failure = syncFailure(rows)
      expect(failure?.message).toBe("1 repo was not fast-forwarded")
      expect(failure?.fix).toContain("does not merge or reset")
      expect(fake.calls.some((call) => call[0] === "fetch" && call[2] === ".")).toBe(false)
      expect(renderSyncTable(rows)).toContain("  fix: ")
      expect(writes(fake.calls)).toBe(false)
    })
  })

  it.effect("reports a local base that is ahead and does not move it", () => {
    const localToRemote = ancestorArgs(local, remote)
    const remoteToLocal = ancestorArgs(remote, local)
    const fake = Git.fake({
      ...behind(),
      [localToRemote.join(" ")]: failed(localToRemote),
      [remoteToLocal.join(" ")]: ""
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]).toMatchObject({ status: "ahead", detail: "local main is ahead of origin/main" })
      expect(rows[0]?.fix).toBeUndefined()
      expect(syncFailure(rows)).toBeUndefined()
      expect(fake.calls.some((call) => call[2] === ".")).toBe(false)
    })
  })

  it.effect("reports up-to-date without moving the ref", () => {
    const fake = Git.fake({
      "rev-parse --show-toplevel": repo,
      "remote": "origin",
      "fetch --quiet origin main": "",
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": local,
      "rev-parse --verify --quiet refs/heads/main^{commit}": local
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]).toEqual({ repo, base: "main", status: "up-to-date", detail: local.slice(0, 7) })
      expect(fake.calls.some((call) => call[0] === "merge-base" || call[2] === ".")).toBe(false)
    })
  })

  it.effect("reports a missing local branch and does not create it", () => {
    const missing = ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]
    const fake = Git.fake({
      "rev-parse --show-toplevel": repo,
      "remote": "origin",
      "fetch --quiet origin main": "",
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": remote,
      [missing.join(" ")]: failed(missing)
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]?.status).toBe("missing")
      expect(rows[0]?.detail).toBe("local main does not exist")
      expect(rows[0]?.fix).toBe(`git -C ${repo} branch main origin/main`)
      expect(fake.calls.some((call) => call[0] === "branch")).toBe(false)
    })
  })

  it.effect("reports a missing origin branch after a successful fetch", () => {
    const missing = ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]
    const fake = Git.fake({
      "rev-parse --show-toplevel": repo,
      "remote": "origin",
      "fetch --quiet origin main": "",
      [missing.join(" ")]: failed(missing)
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]?.status).toBe("missing")
      expect(rows[0]?.detail).toBe("origin/main does not exist")
      expect(rows[0]?.fix).toContain(configFile)
      expect(fake.calls.some((call) => call[0] === "branch" || call[2] === ".")).toBe(false)
    })
  })

  it.effect("reports no origin and does not fetch", () => {
    const fake = Git.fake({
      "rev-parse --show-toplevel": repo,
      "remote": ""
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]).toMatchObject({ status: "no-remote", detail: "no origin" })
      expect(fake.calls.some((call) => call[0] === "fetch")).toBe(false)
    })
  })

  it.effect("continues after a fetch failure and still fast-forwards the next repo", () => {
    const first = "/repos/a"
    const second = "/repos/b"
    const key = (cwd: string, args: string) => `${cwd}\0${args}`
    const fetchArgs = ["fetch", "--quiet", "origin", "main"]
    const fake = Git.fake({
      [key(first, "rev-parse --show-toplevel")]: first,
      [key(second, "rev-parse --show-toplevel")]: second,
      [key(first, "remote")]: "origin",
      [key(second, "remote")]: "origin",
      [key(first, fetchArgs.join(" "))]: failed(fetchArgs, 128, "fatal: couldn't find remote ref main"),
      [key(second, "fetch --quiet origin main")]: "",
      [key(second, "rev-parse --verify --quiet refs/remotes/origin/main^{commit}")]: remote,
      [key(second, "rev-parse --verify --quiet refs/heads/main^{commit}")]: local,
      [key(second, ancestorArgs(local, remote).join(" "))]: "",
      [key(second, "worktree list --porcelain")]: porcelain(second, "feature"),
      [key(second, "fetch --quiet . refs/remotes/origin/main:refs/heads/main")]: ""
    })
    const config = {
      version: 1 as const,
      identity: { work },
      project: [{ path: first }, { path: second }]
    } satisfies ZwtConfig
    return Effect.gen(function*() {
      const rows = yield* run(config, fake)
      expect(rows.map((entry) => entry.status)).toEqual(["fetch-failed", "fast-forward"])
      expect(rows[0]?.detail).toContain("couldn't find remote ref")
      expect(syncFailure(rows)?.message).toBe("1 repo was not fast-forwarded")
      expect(fake.calls.filter((call) => call[2] === ".").length).toBe(1)
      expect(writes(fake.calls)).toBe(false)
    })
  })

  it.effect("lists project toplevels, skips a non-repo profile root, and reports a missing path", () => {
    const solo = "/home/jane/solo"
    const missing = "/home/jane/missing"
    const notRepo = failed(["rev-parse", "--show-toplevel"], 128, "fatal: not a git repository")
    const key = (cwd: string, args: string) => `${cwd}\0${args}`
    const fake = Git.fake({
      [key(repo, "rev-parse --show-toplevel")]: repo,
      [key("/home/jane/work/acme", "rev-parse --show-toplevel")]: notRepo,
      [key(missing, "rev-parse --show-toplevel")]: notRepo,
      [key("/home/jane/wide", "rev-parse --show-toplevel")]: notRepo,
      [key(solo, "rev-parse --show-toplevel")]: solo,
      [key(repo, "remote")]: "",
      [key(solo, "remote")]: ""
    })
    const config = {
      version: 1 as const,
      identity: { work },
      profile: [
        { match: "/home/jane/work/acme/**", identity: "work", base_branch: "develop" },
        { match: "/home/jane/wide/**", identity: "work" },
        { match: `${solo}/**`, identity: "work", base_branch: "develop" }
      ],
      project: [{ path: `${repo}/`, base_branch: "main" }, { path: missing }]
    } satisfies ZwtConfig
    return Effect.gen(function*() {
      const rows = yield* run(config, fake)
      expect(rows.map((entry) => [entry.repo, entry.base, entry.status])).toEqual([
        [repo, "main", "no-remote"],
        [missing, "-", "not-a-repo"],
        [solo, "develop", "no-remote"]
      ])
      expect(rows.some((entry) => entry.repo.includes("wide"))).toBe(false)
      expect(syncFailure(rows)?.message).toBe("3 repos were not fast-forwarded")
      expect(rows[1]?.fix).toContain(configFile)
    })
  })

  it.effect("uses the project base branch over the profile", () => {
    const fake = Git.fake({
      "rev-parse --show-toplevel": repo,
      "remote": "origin",
      "fetch --quiet origin main": failed(["fetch", "--quiet", "origin", "main"], 128, "stopped")
    })
    return Effect.gen(function*() {
      const rows = yield* run(projectConfig(), fake)
      expect(rows[0]?.base).toBe("main")
      expect(fake.calls.some((call) => call.join(" ") === "fetch --quiet origin develop")).toBe(false)
      expect(fake.calls.some((call) => call.join(" ") === "fetch --quiet origin main")).toBe(true)
    })
  })
})
