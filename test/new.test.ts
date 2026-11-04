import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { newWorktree } from "../src/commands/new.ts"
import { GitCommandFailed } from "../src/errors.ts"
import { Config } from "../src/services/Config.ts"
import { Git } from "../src/services/Git.ts"

const source = readFileSync(new URL("./fixtures/valid.toml", import.meta.url), "utf8")
const configLayer = Config.live.pipe(Layer.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(source) })))
const repo = "/home/jane/work/acme/web"
const options = (slug = "login") => ({
  slug,
  cwd: repo,
  home: "/home/jane",
  configFile: "/cfg/zwt.toml",
  flags: { base: Option.none<string>(), prefix: Option.none<string>() }
})
const notFound = (args: string) => new GitCommandFailed({ args: args.split(" "), exitCode: 1, stderr: "" })

const baseResponses = {
  "rev-parse --show-toplevel": repo,
  "worktree list --porcelain": `worktree ${repo}\nHEAD abc\nbranch refs/heads/main`,
  "remote": "origin",
  "fetch --quiet origin develop": "",
  "rev-parse --verify --quiet refs/remotes/origin/develop^{commit}": "abc",
  "worktree add -b feature/login /home/jane/work/acme/worktrees/web/login origin/develop": ""
}

describe("zwt new with a fake Git layer", () => {
  it.effect("fetches the base and creates the branch from origin", () => {
    const fake = Git.fake(baseResponses)
    return Effect.gen(function*() {
      const result = yield* newWorktree(options())
      expect(result).toMatchObject({ _tag: "Created", branch: "feature/login", base: "origin/develop" })
      expect(fake.calls.map((c) => c.join(" "))).toContain("fetch --quiet origin develop")
    }).pipe(Effect.provide(Layer.merge(fake.layer, configLayer)))
  })

  it.effect("reports the existing worktree on re-run", () => {
    const fake = Git.fake({
      ...baseResponses,
      "worktree list --porcelain": `worktree ${repo}\nbranch refs/heads/main\n\nworktree /wt/login\nHEAD abc\nbranch refs/heads/feature/login`
    })
    return Effect.gen(function*() {
      expect(yield* newWorktree(options())).toEqual({ _tag: "Exists", path: "/wt/login", branch: "feature/login" })
      expect(fake.calls.some((c) => c[0] === "worktree" && c[1] === "add")).toBe(false)
    }).pipe(Effect.provide(Layer.merge(fake.layer, configLayer)))
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
    }).pipe(Effect.provide(Layer.merge(fake.layer, configLayer)))
  })

  it.effect("fails with IdentityUnresolved outside every profile, before any write", () => {
    const fake = Git.fake({ ...baseResponses, "rev-parse --show-toplevel": "/srv/tool" })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree({ ...options(), cwd: "/srv/tool" }))
      expect(error._tag).toBe("IdentityUnresolved")
      if (error._tag === "IdentityUnresolved") expect(error.fix).toContain('match = "/srv/tool/**"')
      expect(fake.calls.some((c) => c[0] === "fetch" || c[1] === "add")).toBe(false)
    }).pipe(Effect.provide(Layer.merge(fake.layer, configLayer)))
  })

  it.effect("rejects slugs that would escape the worktrees dir", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(newWorktree(options("../x")))
      expect(error._tag).toBe("InvalidSlug")
    }).pipe(Effect.provide(Layer.merge(Git.fake({}).layer, configLayer))))
})
