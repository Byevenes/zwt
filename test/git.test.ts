import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { GitCommandFailed } from "../src/errors.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { Git, parseAheadBehind, parseConfigOrigin, parseWorktreeList, parseWorktrees } from "../src/services/Git.ts"

const notFound = (args: ReadonlyArray<string>) => new GitCommandFailed({ args, exitCode: 1, stderr: "" })

describe("fake Git layer", () => {
  it.effect("maps a missing ref to BranchNotFound with a fix", () => {
    const args = ["rev-parse", "--verify", "--quiet", "develop^{commit}"]
    const fake = Git.fake({ [args.join(" ")]: notFound(args) })
    return Effect.gen(function*() {
      const error = yield* Effect.flip((yield* Git).requireBranch("develop", "/repo"))
      expect(error._tag).toBe("BranchNotFound")
      expect(error._tag === "BranchNotFound" && error.fix).toBe("git -C /repo fetch origin develop")
      expect(fake.calls).toEqual([args])
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reads config values and treats exit 1 as unset", () => {
    const fake = Git.fake({
      "config --get user.email": "jane@example.com",
      "config --get user.signingkey": notFound(["config", "--get", "user.signingkey"])
    })
    return Effect.gen(function*() {
      const git = yield* Git
      expect(yield* git.configGet("user.email", "/repo")).toEqual(Option.some("jane@example.com"))
      expect(yield* git.configGet("user.signingkey", "/repo")).toEqual(Option.none())
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("sets worktree config without a --global argument", () => {
    const fake = Git.fake({ "config --worktree user.email ada@example.com": "" })
    return Effect.gen(function*() {
      yield* (yield* Git).configSet("user.email", "ada@example.com", "/wt", "worktree")
      expect(fake.calls).toEqual([["config", "--worktree", "user.email", "ada@example.com"]])
      expect(fake.calls.some((call) => call.includes("--global"))).toBe(false)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reads the origin url", () => {
    const fake = Git.fake({ "remote get-url origin": "git@gitlab.com:acme/web.git" })
    return Effect.gen(function*() {
      expect(yield* (yield* Git).originUrl("/repo")).toEqual(Option.some("git@gitlab.com:acme/web.git"))
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("treats a missing origin as an empty read", () => {
    const args = ["remote", "get-url", "origin"]
    const fake = Git.fake({ [args.join(" ")]: new GitCommandFailed({ args, exitCode: 2, stderr: "error: No such remote 'origin'" }) })
    return Effect.gen(function*() {
      expect(yield* (yield* Git).originUrl("/repo")).toEqual(Option.none())
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("answers one command differently for each cwd", () => {
    const fake = Git.fake({
      "/a\0rev-parse --show-toplevel": "/a",
      "/b\0rev-parse --show-toplevel": "/b"
    })
    return Effect.gen(function*() {
      const git = yield* Git
      expect(yield* git.repoRoot("/a")).toBe("/a")
      expect(yield* git.repoRoot("/b")).toBe("/b")
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("commitOf returns the oid and treats a missing ref as none", () => {
    const missing = ["rev-parse", "--verify", "--quiet", "refs/heads/nope^{commit}"]
    const fake = Git.fake({
      "rev-parse --verify --quiet refs/heads/main^{commit}": "abc",
      [missing.join(" ")]: notFound(missing)
    })
    return Effect.gen(function*() {
      const git = yield* Git
      expect(yield* git.commitOf("refs/heads/main", "/repo")).toEqual(Option.some("abc"))
      expect(yield* git.commitOf("refs/heads/nope", "/repo")).toEqual(Option.none())
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("isAncestor is false when git exits 1", () => {
    const args = ["merge-base", "--is-ancestor", "child", "parent"]
    const fake = Git.fake({ [args.join(" ")]: notFound(args) })
    return Effect.gen(function*() {
      expect(yield* (yield* Git).isAncestor("child", "parent", "/repo")).toBe(false)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("fast-forwards with a local fetch and no force flag", () => {
    const spec = "refs/remotes/origin/main:refs/heads/main"
    const fake = Git.fake({ [`fetch --quiet . ${spec}`]: "" })
    return Effect.gen(function*() {
      yield* (yield* Git).fastForwardBranch("main", "refs/remotes/origin/main", "/repo")
      expect(fake.calls).toEqual([["fetch", "--quiet", ".", spec]])
      expect(fake.calls.some((call) => call.some((arg) => arg.startsWith("+") || arg === "--force"))).toBe(false)
    }).pipe(Effect.provide(fake.layer))
  })

  it("parses every worktree, and still finds one branch", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /wt",
      "HEAD bbb",
      "branch refs/heads/feature/login",
      "locked",
      "",
      "worktree /det",
      "HEAD ccc",
      "detached",
      "",
      "worktree /bare.git",
      "HEAD ddd",
      "bare"
    ].join("\n")
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/repo", head: { _tag: "Branch", name: "main" }, locked: false, prunable: false },
      { path: "/wt", head: { _tag: "Branch", name: "feature/login" }, locked: true, prunable: false },
      { path: "/det", head: { _tag: "Detached" }, locked: false, prunable: false },
      { path: "/bare.git", head: { _tag: "Bare" }, locked: false, prunable: false }
    ])
    expect(parseWorktreeList(porcelain, "feature/login")).toEqual(Option.some("/wt"))
    expect(parseWorktreeList(porcelain, "missing")).toEqual(Option.none())
    expect(parseWorktrees("")).toEqual([])
  })

  it("parses ahead/behind counts", () => {
    expect(parseAheadBehind("1\t2")).toEqual(Option.some({ behind: 1, ahead: 2 }))
    expect(parseAheadBehind("0 0\n")).toEqual(Option.some({ behind: 0, ahead: 0 }))
    expect(parseAheadBehind("nope")).toEqual(Option.none())
    expect(parseAheadBehind("-1\t2")).toEqual(Option.none())
  })

  it("parses git config --show-origin", () => {
    expect(parseConfigOrigin("file:/repo/.git/worktrees/login/config.worktree\tada@example.com\n")).toEqual(
      Option.some({ file: "/repo/.git/worktrees/login/config.worktree", value: "ada@example.com" })
    )
  })
})

describe("dry-run git config", () => {
  it.effect("remembers a worktree email so the later read matches the planned write", () =>
    Effect.gen(function*() {
      const git = yield* Git
      yield* git.configSet("user.email", "ada@example.com", "/wt", "worktree")
      expect(yield* git.configGet("user.email", "/wt")).toEqual(Option.some("ada@example.com"))
      expect(yield* git.configShowOrigin("user.email", "/wt")).toEqual(
        Option.some({ file: "/wt/.git/config.worktree", value: "ada@example.com" })
      )
      const planned = yield* (yield* DryRunLog).planned
      expect(planned.map((write) => write.description).join("\n")).toContain("config --worktree user.email ada@example.com")
      expect(planned.some((write) => write.description.includes("--global"))).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(Git.dryRun, DryRunLog.layer).pipe(Layer.provideMerge(DryRunLog.layer)))))

  it.effect("does not record an origin read", () =>
    Effect.gen(function*() {
      yield* (yield* Git).originUrl(process.cwd())
      expect(yield* (yield* DryRunLog).planned).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(Git.dryRun, DryRunLog.layer).pipe(Layer.provideMerge(DryRunLog.layer)))))
})
