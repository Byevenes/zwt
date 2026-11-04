import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { GitCommandFailed } from "../src/errors.ts"
import { Git } from "../src/services/Git.ts"

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
})
