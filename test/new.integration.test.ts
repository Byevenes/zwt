import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-new-")))
const home = join(root, "home")
const repo = join(home, "work", "acme", "web")
const main = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")))
const runEnv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" }
const git = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, env: runEnv, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
const zwt = (...args: Array<string>) => spawnSync(process.execPath, [main, ...args], { cwd: repo, env: runEnv, encoding: "utf8" })

beforeAll(() => {
  mkdirSync(join(home, ".config", "zwt"), { recursive: true })
  // Only the config file is copied in: no other zwt state exists on this "machine" (#8).
  writeFileSync(
    join(home, ".config", "zwt", "zwt.toml"),
    [
      "version = 1",
      "[identity.work]",
      'name = "Jane Doe"',
      'email = "jane@example.com"',
      "[[profile]]",
      'match = "~/work/acme/**"',
      'identity = "work"',
      'base_branch = "develop"',
      'branch_prefix = "feature/"'
    ].join("\n")
  )
  git(root, "init", "-q", "--bare", "-b", "develop", "origin.git")
  git(root, "clone", "-q", join(root, "origin.git"), repo)
  git(repo, "config", "user.email", "jane@example.com")
  git(repo, "config", "user.name", "Jane Doe")
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
  git(repo, "push", "-q", "origin", "HEAD:develop")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("zwt new end to end (real git, temp HOME)", () => {
  it("creates the worktree from origin/develop, then reports it on re-run", () => {
    const first = zwt("new", "login")
    expect(first.stderr).toBe("")
    const path = join(home, "work", "acme", "worktrees", "web", "login")
    expect(first.stdout).toContain(`created ${path}`)
    expect(first.stdout).toContain("branch feature/login from origin/develop")
    expect(git(path, "branch", "--show-current")).toBe("feature/login")

    const again = zwt("new", "login")
    expect(again.status).toBe(0)
    expect(again.stdout).toContain(`exists ${path}`)
  })

  it("fails clearly when the base branch exists nowhere", () => {
    const result = zwt("new", "x", "--base", "nope")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('branch "nope" does not exist')
    expect(result.stderr).toContain("fix:")
    expect(result.stderr).toContain("warning: could not fetch origin nope")
  })

  it("dry-run plans the fetch and worktree add without writing", () => {
    const result = zwt("--dry-run", "new", "dry")
    expect(result.stdout).toContain("would create")
    expect(result.stdout).toContain("[git] git -C")
    expect(result.stdout).toContain("worktree add -b feature/dry")
    expect(existsSync(join(home, "work", "acme", "worktrees", "web", "dry"))).toBe(false)
  })
})
