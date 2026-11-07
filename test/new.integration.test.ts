import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
const globalDigest = () => {
  const listed = spawnSync("git", ["config", "--global", "--list"], { env: runEnv, encoding: "utf8" })
  return createHash("sha256").update(listed.status === 0 ? listed.stdout : "").digest("hex")
}

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

const excludePath = (cwd: string) => {
  const located = git(cwd, "rev-parse", "--git-path", "info/exclude")
  return located.startsWith("/") ? located : join(cwd, located)
}

describe("zwt new end to end (real git, temp HOME)", () => {
  it("creates the worktree from origin/develop, then reports it on re-run", () => {
    const before = globalDigest()
    const gitignore = join(repo, ".gitignore")
    writeFileSync(gitignore, "keep\n")
    const gitignoreBefore = readFileSync(gitignore)
    const exclude = excludePath(repo)
    const first = zwt("new", "login")
    expect(first.stderr).toBe("")
    const path = join(home, "work", "acme", "worktrees", "web", "login")
    expect(first.stdout).toContain(`created ${path}`)
    expect(first.stdout).toContain("branch feature/login from origin/develop")
    expect(first.stdout).toContain("identity jane@example.com")
    expect(git(path, "branch", "--show-current")).toBe("feature/login")
    expect(git(path, "config", "--get", "user.email")).toBe("jane@example.com")
    expect(git(path, "config", "--get", "user.name")).toBe("Jane Doe")
    expect(git(path, "config", "--show-origin", "--get", "user.email")).toContain("config.worktree")
    expect(git(repo, "config", "--local", "--get", "extensions.worktreeConfig")).toBe("true")
    expect(globalDigest()).toBe(before)
    const excluded = readFileSync(exclude, "utf8")
    expect(excluded.split(/\r?\n/).filter((line) => line.trim() === ".scratch")).toEqual([".scratch"])
    expect(readFileSync(gitignore)).toEqual(gitignoreBefore)

    const again = zwt("new", "login")
    expect(again.status).toBe(0)
    expect(again.stdout).toContain(`exists ${path}`)
    expect(readFileSync(exclude, "utf8")).toBe(excluded)
    expect(readFileSync(gitignore)).toEqual(gitignoreBefore)

    const check = spawnSync(process.execPath, [main, "identity", "check"], { cwd: path, env: runEnv, encoding: "utf8" })
    expect(check.status).toBe(0)
    expect(check.stdout).toContain("effective: jane@example.com")
    expect(check.stdout).toContain("expected: jane@example.com")
    expect(check.stdout).toContain("config.worktree")
  })

  it("fails clearly when the base branch exists nowhere", () => {
    const result = zwt("new", "x", "--base", "nope")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('branch "nope" does not exist')
    expect(result.stderr).toContain("fix:")
    expect(result.stderr).toContain("warning: could not fetch origin nope")
  })

  it("dry-run plans the fetch, worktree add and exclude append without writing", () => {
    const configPath = join(root, "dry-scratch.toml")
    writeFileSync(
      configPath,
      [
        "version = 1",
        'scratch_dir = ".dry-scratch"',
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
    const exclude = excludePath(repo)
    const before = readFileSync(exclude)
    const gitignore = join(repo, ".gitignore")
    const gitignoreBefore = existsSync(gitignore) ? readFileSync(gitignore) : undefined
    const result = zwt("--dry-run", "new", "dry", "--config", configPath)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("would create")
    expect(result.stdout).toContain("[git] git -C")
    expect(result.stdout).toContain("worktree add -b feature/dry")
    expect(result.stdout).toContain("[fs] write")
    expect(result.stdout).toContain("info/exclude")
    expect(existsSync(join(home, "work", "acme", "worktrees", "web", "dry"))).toBe(false)
    expect(result.stdout).toContain("config --worktree user.email")
    expect(readFileSync(exclude)).toEqual(before)
    if (gitignoreBefore !== undefined) expect(readFileSync(gitignore)).toEqual(gitignoreBefore)
  })

  it("applies --email on the new worktree and leaves the main repo email", () => {
    const result = zwt("new", "ext", "--email", "ext@example.com")
    expect(result.status).toBe(0)
    const ext = join(home, "work", "acme", "worktrees", "web", "ext")
    expect(git(ext, "config", "--get", "user.email")).toBe("ext@example.com")
    expect(git(ext, "config", "--show-origin", "--get", "user.email")).toContain("config.worktree")
    expect(git(repo, "config", "--local", "--get", "user.email")).toBe("jane@example.com")
  })

  it("identity list prints the profile and set does not write without a terminal", () => {
    const list = zwt("identity", "list")
    expect(list.status).toBe(0)
    expect(list.stdout).toContain("jane@example.com")
    const file = join(home, ".config", "zwt", "zwt.toml")
    const before = readFileSync(file, "utf8")
    const set = zwt("identity", "set", "work")
    expect(set.status).toBe(1)
    expect(set.stderr).toContain("not interactive")
    expect(readFileSync(file, "utf8")).toBe(before)
  })

  it("does not create a worktree when --strict and origin requires another identity", () => {
    const previous = git(repo, "remote", "get-url", "origin")
    const configPath = join(root, "strict-remote.toml")
    const slug = "remote-id"
    const path = join(home, "work", "acme", "worktrees", "web", slug)
    writeFileSync(
      configPath,
      [
        "version = 1",
        "[identity.work]",
        'name = "Jane Doe"',
        'email = "jane@example.com"',
        "[identity.external]",
        'name = "Jane External"',
        'email = "jane.external@example.com"',
        "[[profile]]",
        'match = "~/work/acme/**"',
        'identity = "work"',
        'base_branch = "develop"',
        'branch_prefix = "feature/"',
        "[[remote]]",
        'pattern = "github.com/other-org/"',
        'identity = "external"'
      ].join("\n")
    )
    git(repo, "remote", "set-url", "origin", "https://github.com/other-org/web.git")
    try {
      const result = zwt("new", slug, "--strict", "--config", configPath)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('requires identity "external"')
      expect(result.stderr).toContain("zwt identity set external")
      expect(result.stdout.includes("created")).toBe(false)
      expect(existsSync(path)).toBe(false)
    } finally {
      git(repo, "remote", "set-url", "origin", previous)
    }
  })

  it("names the branch from the ticket template, then reports it on re-run", () => {
    const configPath = join(root, "ticket.toml")
    writeFileSync(
      configPath,
      [
        "version = 1",
        "[identity.work]",
        'name = "Jane Doe"',
        'email = "jane@example.com"',
        "[[profile]]",
        'match = "~/work/acme/**"',
        'identity = "work"',
        'base_branch = "develop"',
        'branch_prefix = "feature/"',
        'ticket_pattern = "[A-Z][A-Z0-9]+-[0-9]+"',
        'branch_template = "feature/{ticket}-{slug}"'
      ].join("\n")
    )
    const key = "ABC-123"
    const keyPath = join(home, "work", "acme", "worktrees", "web", key)
    const created = zwt("new", key, "--config", configPath)
    expect(created.stderr).toBe("")
    expect(created.status).toBe(0)
    expect(created.stdout).toContain(`created ${keyPath}`)
    expect(created.stdout).toContain("branch feature/ABC-123 from origin/develop")
    expect(git(keyPath, "branch", "--show-current")).toBe("feature/ABC-123")

    const again = zwt("new", key, "--config", configPath)
    expect(again.status).toBe(0)
    expect(again.stdout).toContain(`exists ${keyPath}`)

    const described = "ABC-456-fix-login"
    const describedPath = join(home, "work", "acme", "worktrees", "web", described)
    const withSlug = zwt("new", described, "--config", configPath)
    expect(withSlug.status).toBe(0)
    expect(git(describedPath, "branch", "--show-current")).toBe("feature/ABC-456-fix-login")

    const missing = zwt("new", "notes", "--config", configPath)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain("does not start with a ticket key")
    expect(missing.stderr).toContain("fix:")
    expect(existsSync(join(home, "work", "acme", "worktrees", "web", "notes"))).toBe(false)

    const prefixed = zwt("new", "plain", "--prefix", "hotfix/", "--config", configPath)
    expect(prefixed.status).toBe(0)
    expect(git(join(home, "work", "acme", "worktrees", "web", "plain"), "branch", "--show-current")).toBe("hotfix/plain")
  })
})
