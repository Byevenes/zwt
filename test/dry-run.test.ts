import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { DryRunLog, renderPlan } from "../src/services/DryRun.ts"
import { dryRunFileSystem } from "../src/services/FileSystem.ts"
import { Git } from "../src/services/Git.ts"

const forbiddenWrites = FileSystem.layerNoop({
  writeFileString: () => Effect.die("real write during dry-run"),
  makeDirectory: () => Effect.die("real mkdir during dry-run"),
  readFileString: () => Effect.succeed("read passes through")
})

const dryRun = Layer.mergeAll(Git.dryRun, dryRunFileSystem).pipe(
  Layer.provideMerge(DryRunLog.layer),
  Layer.provide(forbiddenWrites)
)

describe("dry-run layers", () => {
  it.effect("record git and fs writes instead of running them", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* (yield* Git).addWorktree({ cwd: "/repo", path: "/wt/feat-x", branch: "feat/x", base: "main" })
      yield* fs.makeDirectory("/wt")
      yield* fs.writeFileString("/repo/.git/info/exclude", ".scratch/\n")
      expect(yield* fs.readFileString("/any")).toBe("read passes through")

      const planned = yield* (yield* DryRunLog).planned
      expect(planned).toEqual([
        { kind: "git", description: "git -C /repo worktree add -b feat/x /wt/feat-x main" },
        { kind: "fs", description: "mkdir /wt" },
        { kind: "fs", description: "write /repo/.git/info/exclude" }
      ])
      expect(renderPlan(planned)).toContain("[git] git -C /repo worktree add")
    }).pipe(Effect.provide(dryRun)))
})
