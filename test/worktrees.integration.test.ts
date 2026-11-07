import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const entry = new URL("../src/main.ts", import.meta.url).pathname
const roots: Array<string> = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const makeRepo = (base = "main") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-wt-")))
  roots.push(root)
  const home = join(root, "home")
  const repo = join(home, "work", "acme", "web")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  const runEnv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" }
  mkdirSync(join(home, ".config", "zwt"), { recursive: true })
  const configFile = join(home, ".config", "zwt", "zwt.toml")
  writeFileSync(
    configFile,
    [
      "version = 1",
      "[identity.work]",
      'name = "Jane Doe"',
      'email = "jane@example.com"',
      "[[profile]]",
      'match = "~/work/acme/**"',
      'identity = "work"',
      `base_branch = "${base}"`,
      'branch_prefix = "feature/"'
    ].join("\n")
  )
  const git = (cwd: string, ...args: Array<string>) =>
    execFileSync("git", args, { cwd, env: runEnv, encoding: "utf8" }).trim()
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "config", "user.email", "jane@example.com")
  git(repo, "config", "user.name", "Jane Doe")
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
  const zwt = (args: Array<string>, cwd = repo) =>
    spawnSync(process.execPath, [entry, ...args], { cwd, env: runEnv, encoding: "utf8" })
  const add = (slug: string, kind: "merged" | "ahead" | "dirty") => {
    const path = join(home, "work", "acme", "worktrees", "web", slug)
    git(repo, "worktree", "add", "-q", "-b", `feature/${slug}`, path, "main")
    if (kind === "ahead") git(path, "commit", "-q", "--allow-empty", "-m", slug)
    if (kind === "dirty") writeFileSync(join(path, "notes.txt"), "wip\n")
    return path
  }
  return { configFile, git, repo, zwt, add }
}

const branchListed = (git: (cwd: string, ...args: Array<string>) => string, repo: string, branch: string) =>
  git(repo, "branch", "--list", branch) !== ""

describe("zwt list, prune and rm against a temp repo", () => {
  it("lists merged and dirty worktrees", () => {
    const { add, repo, zwt } = makeRepo()
    const done = add("listed-done", "merged")
    const wip = add("listed-wip", "ahead")
    const dirty = add("listed-dirty", "dirty")
    const result = zwt(["list"])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("path | branch | merged | dirty")
    expect(result.stdout).toContain(`${repo} | main | yes | no`)
    expect(result.stdout).toContain(`${done} | feature/listed-done | yes | no`)
    expect(result.stdout).toContain(`${wip} | feature/listed-wip | no | no`)
    expect(result.stdout).toContain(`${dirty} | feature/listed-dirty | yes | yes`)
  })

  it("does nothing without --merged", () => {
    const { add, zwt } = makeRepo()
    const path = add("stay", "merged")
    const result = zwt(["prune"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("--merged")
    expect(existsSync(path)).toBe(true)
  })

  it("dry-run lists the removal and leaves the worktree and the branch", () => {
    const { add, git, repo, zwt } = makeRepo()
    const path = add("dry-done", "merged")
    const result = zwt(["--dry-run", "prune", "--merged", "--delete-branch"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`would remove ${path}`)
    expect(result.stdout).toContain("would delete branch feature/dry-done")
    expect(result.stdout).toContain(`worktree remove ${path}`)
    expect(result.stdout).toContain("branch -d feature/dry-done")
    expect(existsSync(path)).toBe(true)
    expect(branchListed(git, repo, "feature/dry-done")).toBe(true)
  })

  it("prune --merged removes only a clean merged worktree and keeps its branch", () => {
    const { add, git, repo, zwt } = makeRepo()
    const done = add("drop-done", "merged")
    const wip = add("keep-wip", "ahead")
    const dirty = add("keep-dirty", "dirty")
    const result = zwt(["prune", "--merged"])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain(`removed ${done} (branch feature/drop-done)`)
    expect(result.stdout).toContain(`kept ${wip} (unmerged)`)
    expect(result.stdout).toContain(`kept ${dirty} (dirty)`)
    expect(result.stdout).not.toContain("deleted branch")
    expect(existsSync(done)).toBe(false)
    expect(existsSync(wip)).toBe(true)
    expect(existsSync(dirty)).toBe(true)
    expect(branchListed(git, repo, "feature/drop-done")).toBe(true)
    const again = zwt(["prune", "--merged"])
    expect(again.status).toBe(0)
    expect(again.stdout).toContain("nothing to remove")
    expect(existsSync(wip)).toBe(true)
  })

  it("prune --delete-branch deletes the local branch", () => {
    const { add, git, repo, zwt } = makeRepo()
    const path = add("drop-branch", "merged")
    const result = zwt(["prune", "--merged", "--delete-branch"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`deleted branch feature/drop-branch`)
    expect(existsSync(path)).toBe(false)
    expect(branchListed(git, repo, "feature/drop-branch")).toBe(false)
  })

  it("does not remove the worktree you are in", () => {
    const { add, zwt } = makeRepo()
    const path = add("rm-here", "merged")
    const pruned = zwt(["prune", "--merged"], path)
    expect(pruned.status).toBe(0)
    expect(pruned.stdout).toContain(`kept ${path} (current)`)
    expect(existsSync(path)).toBe(true)
    const removed = zwt(["rm", "rm-here", "--force"], path)
    expect(removed.status).toBe(1)
    expect(removed.stderr).toContain("current directory")
    expect(existsSync(path)).toBe(true)
  })

  it("rm refuses a dirty or unmerged worktree unless --force, and does not delete an unmerged branch", () => {
    const { add, git, repo, zwt } = makeRepo()
    const dirty = add("rm-dirty", "dirty")
    const refused = zwt(["rm", "rm-dirty"])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("dirty")
    expect(existsSync(dirty)).toBe(true)
    const forced = zwt(["rm", "rm-dirty", "--force"])
    expect(forced.status).toBe(0)
    expect(existsSync(dirty)).toBe(false)
    expect(branchListed(git, repo, "feature/rm-dirty")).toBe(true)

    const wip = add("rm-wip", "ahead")
    const blocked = zwt(["rm", "rm-wip", "--delete-branch"])
    expect(blocked.status).toBe(1)
    expect(blocked.stderr).toContain("not merged")
    expect(existsSync(wip)).toBe(true)
    const gone = zwt(["rm", "rm-wip", "--force", "--delete-branch"])
    expect(gone.status).toBe(0)
    expect(gone.stdout).toContain("kept branch feature/rm-wip (unmerged)")
    expect(existsSync(wip)).toBe(false)
    expect(branchListed(git, repo, "feature/rm-wip")).toBe(true)
  })

  it("rm --delete-branch deletes a merged branch and a missing slug is a no-op", () => {
    const { add, git, repo, zwt } = makeRepo()
    const path = add("rm-done", "merged")
    const dry = zwt(["--dry-run", "rm", "rm-done", "--delete-branch"])
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain(`would remove ${path}`)
    expect(dry.stdout).toContain("would delete branch feature/rm-done")
    expect(existsSync(path)).toBe(true)
    const result = zwt(["rm", "rm-done", "--delete-branch"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`deleted branch feature/rm-done`)
    expect(existsSync(path)).toBe(false)
    expect(branchListed(git, repo, "feature/rm-done")).toBe(false)
    const again = zwt(["rm", "rm-done"])
    expect(again.status).toBe(0)
    expect(again.stdout).toContain("absent rm-done")
  })

  it("deletes a branch that is merged into the base but not into HEAD", () => {
    const { configFile, git, repo, zwt } = makeRepo("develop")
    const ancestor = (rev: string, descendant: string) => {
      try {
        git(repo, "merge-base", "--is-ancestor", rev, descendant)
        return true
      } catch {
        return false
      }
    }
    git(repo, "branch", "develop")
    const path = join(dirname(repo), "worktrees", "web", "side")
    mkdirSync(dirname(path), { recursive: true })
    git(repo, "worktree", "add", "-q", "-b", "feature/side", path, "develop")
    git(path, "commit", "-q", "--allow-empty", "-m", "side")
    const sha = git(path, "rev-parse", "HEAD")
    git(repo, "fetch", ".", "feature/side:develop")
    expect(ancestor("feature/side", "develop")).toBe(true)
    expect(ancestor("feature/side", "HEAD")).toBe(false)
    const result = zwt(["prune", "--merged", "--delete-branch", "--config", configFile])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`removed ${path} (branch feature/side)`)
    expect(result.stdout).toContain("deleted branch feature/side")
    expect(existsSync(path)).toBe(false)
    expect(branchListed(git, repo, "feature/side")).toBe(false)
    expect(branchListed(git, repo, "develop")).toBe(true)
    expect(git(repo, "merge-base", "--is-ancestor", sha, "develop")).toBe("")
    expect(git(repo, "branch", "--show-current")).toBe("main")
  })
})
