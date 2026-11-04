import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Git } from "../src/services/Git.ts"

const root = mkdtempSync(join(tmpdir(), "zwt-it-"))
const repo = join(root, "repo")
const leakedEnv = { GIT_DIR: join(root, "not-a-repo"), GIT_WORK_TREE: root, GIT_INDEX_FILE: join(root, "index") }

beforeAll(() => {
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  git("init", "-q", "-b", "main", repo)
  git("-C", repo, "config", "user.email", "jane@example.com")
  git("-C", repo, "config", "user.name", "Jane Doe")
  git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init")
  Object.assign(process.env, leakedEnv)
})

afterAll(() => {
  for (const key of Object.keys(leakedEnv)) delete process.env[key]
  rmSync(root, { recursive: true, force: true })
})

describe("Git live layer against a temp repo", () => {
  it.effect("ignores GIT_* variables leaked from hooks and acts on cwd", () =>
    Effect.gen(function*() {
      const git = yield* Git
      expect(yield* git.configGet("user.email", repo)).toEqual(Option.some("jane@example.com"))
      yield* git.requireBranch("main", repo)
      const missing = yield* Effect.flip(git.requireBranch("nope", repo))
      expect(missing._tag).toBe("BranchNotFound")

      const path = join(root, "wt-feat")
      yield* git.addWorktree({ cwd: repo, path, branch: "feat/x", base: "main" })
      expect(existsSync(join(path, ".git"))).toBe(true)
      expect(yield* git.run(["branch", "--show-current"], path)).toBe("feat/x")
    }).pipe(Effect.provide(Git.live)))
})
