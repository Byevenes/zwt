import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { listWorktrees, mainWorktreePath, pruneMerged, removeWorktreeBySlug, renderList } from "../src/commands/worktrees.ts"
import { GitCommandFailed } from "../src/errors.ts"
import { Config } from "../src/services/Config.ts"
import { Git } from "../src/services/Git.ts"

const source = readFileSync(new URL("./fixtures/valid.toml", import.meta.url), "utf8")
const configLayer = Config.live.pipe(Layer.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(source) })))
const repo = "/home/jane/work/acme/web"
const done = "/home/jane/work/acme/worktrees/web/done"
const landed = "/home/jane/work/acme/worktrees/web/landed"
const wip = "/home/jane/work/acme/worktrees/web/wip"
const dirty = "/home/jane/work/acme/worktrees/web/dirty"
const locked = "/tmp/locked"
const detached = "/tmp/detached"
const missing = "/tmp/missing"
const onBase = "/tmp/on-base"
const home = "/home/jane"
const configFile = "/cfg/zwt.toml"

const exit1 = (args: string) => new GitCommandFailed({ args: args.split(" "), exitCode: 1, stderr: "" })

const block = (lines: ReadonlyArray<string>) => lines.join("\n")

const porcelain = [
  block([`worktree ${repo}`, "HEAD aaa", "branch refs/heads/main"]),
  block([`worktree ${done}`, "HEAD bbb", "branch refs/heads/feature/done"]),
  block([`worktree ${landed}`, "HEAD ccc", "branch refs/heads/feature/landed"]),
  block([`worktree ${wip}`, "HEAD ddd", "branch refs/heads/feature/wip"]),
  block([`worktree ${dirty}`, "HEAD eee", "branch refs/heads/feature/dirty"]),
  block([`worktree ${locked}`, "HEAD fff", "branch refs/heads/feature/locked", "locked held"]),
  block([`worktree ${detached}`, "HEAD ggg", "detached"]),
  block([`worktree ${missing}`, "HEAD hhh", "branch refs/heads/feature/gone", "prunable gitdir file points to non-existent location"]),
  block([`worktree ${onBase}`, "HEAD iii", "branch refs/heads/develop"])
].join("\n\n")

const status = (path: string, text: string) => ({ [`${path}\0--no-optional-locks status --porcelain=v1 -z`]: text })

const ancestor = (branch: string, descendant: string, merged: boolean) => {
  const args = `merge-base --is-ancestor ${branch} ${descendant}`
  return { [args]: merged ? "" : exit1(args) }
}

const responses = {
  "rev-parse --show-toplevel": repo,
  "rev-parse --path-format=absolute --git-common-dir": `${repo}/.git`,
  "rev-parse --verify --quiet develop^{commit}": "abc",
  "worktree list --porcelain": porcelain,
  ...status(repo, ""),
  ...status(done, ""),
  ...status(landed, ""),
  ...status(wip, ""),
  ...status(dirty, "?? notes"),
  ...status(locked, ""),
  ...status(detached, ""),
  ...status(onBase, ""),
  ...ancestor("main", "develop", false),
  ...ancestor("feature/done", "develop", true),
  ...ancestor("feature/landed", "develop", true),
  ...ancestor("feature/wip", "develop", false),
  ...ancestor("feature/dirty", "develop", true),
  ...ancestor("feature/dirty", "HEAD", true),
  ...ancestor("feature/locked", "develop", true),
  ...ancestor("feature/gone", "develop", true),
  ...ancestor("develop", "develop", true),
  ...ancestor("feature/done", "HEAD", true),
  ...ancestor("feature/landed", "HEAD", false),
  ...ancestor("develop", "HEAD", false),
  [`worktree remove ${done}`]: "",
  [`worktree remove ${landed}`]: "",
  [`worktree remove ${onBase}`]: "",
  [`worktree remove --force ${dirty}`]: "",
  [`worktree remove --force ${wip}`]: "",
  [`worktree remove --force ${detached}`]: "",
  "branch -d feature/done": "",
  "branch -d feature/dirty": "",
  "branch -D feature/landed": ""
}

const calls = (fake: ReturnType<typeof Git.fake>) => fake.calls.map((call) => call.join(" "))

const run = <A, E>(effect: Effect.Effect<A, E, Git | Config>, extra: Record<string, string | GitCommandFailed> = {}) => {
  const fake = Git.fake({ ...responses, ...extra })
  return {
    fake,
    effect: effect.pipe(Effect.provide(Layer.mergeAll(fake.layer, configLayer)))
  }
}

const options = {
  cwd: repo,
  home,
  configFile
}

describe("zwt list, prune and rm", () => {
  it("does not branch on the dry-run flag", () => {
    const text = readFileSync(new URL("../src/commands/worktrees.ts", import.meta.url), "utf8")
    expect(text.includes("DryRun")).toBe(false)
    expect(text.includes("dry-run")).toBe(false)
    expect(text.includes("dryRun")).toBe(false)
  })

  it("reads the main checkout from the common git dir", () => {
    expect(mainWorktreePath(`${repo}/.git`)).toBe(repo)
    expect(mainWorktreePath("/bare.git")).toBeUndefined()
  })

  it("renders the list header", () => {
    expect(renderList([{ path: "/wt", branch: "feature/login", merged: "no", dirty: "yes" }])).toBe(
      "path | branch | merged | dirty\n/wt | feature/login | no | yes"
    )
  })

  it.effect("lists path, branch, merged and dirty, including a missing directory", () => {
    const { effect } = run(listWorktrees(options))
    return Effect.gen(function*() {
      const rows = yield* effect
      expect(rows).toContainEqual({ path: repo, branch: "main", merged: "no", dirty: "no" })
      expect(rows).toContainEqual({ path: done, branch: "feature/done", merged: "yes", dirty: "no" })
      expect(rows).toContainEqual({ path: wip, branch: "feature/wip", merged: "no", dirty: "no" })
      expect(rows).toContainEqual({ path: dirty, branch: "feature/dirty", merged: "yes", dirty: "yes" })
      expect(rows).toContainEqual({ path: detached, branch: "detached", merged: "no", dirty: "no" })
      expect(rows).toContainEqual({ path: missing, branch: "feature/gone", merged: "yes", dirty: "missing" })
    })
  })

  it.effect("refuses to prune unless --merged is set", () => {
    const { effect, fake } = run(pruneMerged({ ...options, merged: false, deleteBranch: true }))
    return Effect.gen(function*() {
      const error = yield* Effect.flip(effect)
      expect(error._tag).toBe("PruneNeedsMerged")
      expect(error._tag === "PruneNeedsMerged" && error.fix).toBe("zwt prune --merged")
      expect(fake.calls).toEqual([])
    })
  })

  it.effect("removes only clean merged linked worktrees and keeps their branches", () => {
    const { effect, fake } = run(pruneMerged({ ...options, merged: true, deleteBranch: false }))
    return Effect.gen(function*() {
      const items = yield* effect
      expect(items).toContainEqual({ _tag: "Removed", path: done, branch: "feature/done", branchDeleted: false, branchKept: undefined })
      expect(items).toContainEqual({ _tag: "Removed", path: landed, branch: "feature/landed", branchDeleted: false, branchKept: undefined })
      expect(items).toContainEqual({ _tag: "Removed", path: onBase, branch: "develop", branchDeleted: false, branchKept: undefined })
      expect(items).toContainEqual({ _tag: "Kept", path: wip, branch: "feature/wip", reason: "unmerged" })
      expect(items).toContainEqual({ _tag: "Kept", path: dirty, branch: "feature/dirty", reason: "dirty" })
      expect(items).toContainEqual({ _tag: "Kept", path: locked, branch: "feature/locked", reason: "locked" })
      expect(items).toContainEqual({ _tag: "Kept", path: detached, branch: "detached", reason: "detached" })
      expect(items).toContainEqual({ _tag: "Kept", path: missing, branch: "feature/gone", reason: "missing" })
      expect(items.some((item) => item.path === repo)).toBe(false)
      const ran = calls(fake)
      expect(ran).toContain(`worktree remove ${done}`)
      expect(ran).toContain(`worktree remove ${landed}`)
      expect(ran).toContain(`worktree remove ${onBase}`)
      expect(ran.some((call) => call.startsWith("branch "))).toBe(false)
      expect(ran.some((call) => call.includes(wip) && call.startsWith("worktree remove"))).toBe(false)
      expect(ran.some((call) => call.includes("--global"))).toBe(false)
      expect(ran.some((call) => call.includes("--force"))).toBe(false)
    })
  })

  it.effect("deletes a merged branch with -d or -D and never deletes the base", () => {
    const { effect, fake } = run(pruneMerged({ ...options, merged: true, deleteBranch: true }))
    return Effect.gen(function*() {
      const items = yield* effect
      expect(items).toContainEqual({ _tag: "Removed", path: done, branch: "feature/done", branchDeleted: true, branchKept: undefined })
      expect(items).toContainEqual({ _tag: "Removed", path: landed, branch: "feature/landed", branchDeleted: true, branchKept: undefined })
      expect(items).toContainEqual({ _tag: "Removed", path: onBase, branch: "develop", branchDeleted: false, branchKept: "base" })
      const ran = calls(fake)
      expect(ran).toContain("branch -d feature/done")
      expect(ran).toContain("branch -D feature/landed")
      expect(ran.some((call) => call.includes("branch -d develop") || call.includes("branch -D develop"))).toBe(false)
    })
  })

  it.effect("keeps the worktree you are in", () => {
    const { effect, fake } = run(
      pruneMerged({ ...options, cwd: done, merged: true, deleteBranch: true }),
      { [`${done}\0rev-parse --show-toplevel`]: done }
    )
    return Effect.gen(function*() {
      const items = yield* effect
      expect(items).toContainEqual({ _tag: "Kept", path: done, branch: "feature/done", reason: "current" })
      expect(calls(fake).some((call) => call === `worktree remove ${done}`)).toBe(false)
    })
  })

  it.effect("rm refuses a dirty or unmerged worktree", () => {
    const dirtyRun = run(removeWorktreeBySlug({ ...options, slug: "dirty", force: false, deleteBranch: false }))
    const wipRun = run(removeWorktreeBySlug({ ...options, slug: "wip", force: false, deleteBranch: true }))
    return Effect.gen(function*() {
      const dirtyError = yield* Effect.flip(dirtyRun.effect)
      expect(dirtyError._tag).toBe("WorktreeDirty")
      expect(dirtyError._tag === "WorktreeDirty" && dirtyError.fix).toContain("zwt rm dirty --force")
      expect(calls(dirtyRun.fake).some((call) => call.startsWith("worktree remove"))).toBe(false)
      const wipError = yield* Effect.flip(wipRun.effect)
      expect(wipError._tag).toBe("WorktreeUnmerged")
      expect(calls(wipRun.fake).some((call) => call.startsWith("worktree remove"))).toBe(false)
    })
  })

  it.effect("rm --force removes a dirty worktree and still keeps an unmerged branch", () => {
    const dirtyRun = run(removeWorktreeBySlug({ ...options, slug: "dirty", force: true, deleteBranch: true }))
    const wipRun = run(removeWorktreeBySlug({ ...options, slug: "wip", force: true, deleteBranch: true }))
    return Effect.gen(function*() {
      expect(yield* dirtyRun.effect).toMatchObject({ _tag: "Removed", path: dirty, branchDeleted: true })
      expect(calls(dirtyRun.fake)).toContain(`worktree remove --force ${dirty}`)
      expect(calls(dirtyRun.fake)).toContain("branch -d feature/dirty")
      const removed = yield* wipRun.effect
      expect(removed).toMatchObject({ _tag: "Removed", path: wip, branchDeleted: false, branchKept: "unmerged" })
      expect(calls(wipRun.fake).some((call) => call.startsWith("branch "))).toBe(false)
    })
  })

  it.effect("rm deletes a merged branch only when asked, and is idempotent when absent", () => {
    const kept = run(removeWorktreeBySlug({ ...options, slug: "done", force: false, deleteBranch: false }))
    const deleted = run(removeWorktreeBySlug({ ...options, slug: "done", force: false, deleteBranch: true }))
    const absent = run(removeWorktreeBySlug({ ...options, slug: "nope", force: false, deleteBranch: true }))
    return Effect.gen(function*() {
      expect(yield* kept.effect).toMatchObject({ _tag: "Removed", branchDeleted: false, branchKept: undefined })
      expect(calls(kept.fake).some((call) => call.startsWith("branch "))).toBe(false)
      expect(yield* deleted.effect).toMatchObject({ _tag: "Removed", branchDeleted: true })
      expect(calls(deleted.fake)).toContain("branch -d feature/done")
      expect(yield* absent.effect).toEqual({ _tag: "Absent", slug: "nope" })
      expect(calls(absent.fake).some((call) => call.startsWith("worktree remove"))).toBe(false)
    })
  })

  it.effect("rm refuses the main checkout, a locked worktree, the current directory and an ambiguous slug", () => {
    const main = run(removeWorktreeBySlug({ ...options, slug: "web", force: true, deleteBranch: true }))
    const held = run(removeWorktreeBySlug({ ...options, slug: "locked", force: true, deleteBranch: false }))
    const here = run(
      removeWorktreeBySlug({ ...options, cwd: done, slug: "done", force: true, deleteBranch: false }),
      { [`${done}\0rev-parse --show-toplevel`]: done }
    )
    const ambiguousPorcelain = [
      block([`worktree ${repo}`, "HEAD aaa", "branch refs/heads/main"]),
      block(["worktree /tmp/a/login", "HEAD bbb", "branch refs/heads/feature/other"]),
      block(["worktree /tmp/b/other", "HEAD ccc", "branch refs/heads/feature/login"])
    ].join("\n\n")
    const ambiguous = run(
      removeWorktreeBySlug({ ...options, slug: "login", force: true, deleteBranch: false }),
      {
        "worktree list --porcelain": ambiguousPorcelain,
        ...status("/tmp/a/login", ""),
        ...status("/tmp/b/other", ""),
        ...ancestor("feature/other", "develop", true),
        ...ancestor("feature/login", "develop", true)
      }
    )
    return Effect.gen(function*() {
      expect((yield* Effect.flip(main.effect))._tag).toBe("MainWorktree")
      expect((yield* Effect.flip(held.effect))._tag).toBe("WorktreeLocked")
      expect((yield* Effect.flip(here.effect))._tag).toBe("WorktreeCurrent")
      const clash = yield* Effect.flip(ambiguous.effect)
      expect(clash._tag).toBe("AmbiguousWorktree")
      expect(calls(main.fake).some((call) => call.startsWith("worktree remove"))).toBe(false)
      expect(calls(held.fake).some((call) => call.startsWith("worktree remove"))).toBe(false)
      expect(calls(here.fake).some((call) => call.startsWith("worktree remove"))).toBe(false)
      expect(calls(ambiguous.fake).some((call) => call.startsWith("worktree remove"))).toBe(false)
    })
  })
})
