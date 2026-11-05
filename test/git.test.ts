import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { GitCommandFailed } from "../src/errors.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { Git, parseConfigOrigin } from "../src/services/Git.ts"

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
})
