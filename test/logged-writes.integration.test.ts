import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseActionLog, type ActionEntry } from "../src/action-log.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-logged-writes-")))
const home = join(root, "home")
const state = join(root, "state")
const logFile = join(state, "zwt", "actions.log")
const mainTs = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
const runEnv = {
  ...env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: state,
  GIT_CONFIG_NOSYSTEM: "1"
}

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@example.com", ...args], {
    cwd,
    env: runEnv,
    encoding: "utf8"
  }).trim()

const zwt = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [mainTs, ...args], { cwd, env: runEnv, encoding: "utf8" })

const readLog = (): ReadonlyArray<ActionEntry> =>
  existsSync(logFile) ? parseActionLog(readFileSync(logFile, "utf8")) : []

const mainCheckout = (repo: string) => {
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : repo
}

const linkedWorktrees = (repo: string): ReadonlyArray<{ readonly path: string; readonly branch: string }> => {
  const porcelain = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
    env: runEnv,
    encoding: "utf8"
  })
  const found: Array<{ path: string; branch: string }> = []
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0)
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length)
    if (path !== undefined && branch !== undefined) found.push({ path, branch })
  }
  const main = mainCheckout(repo)
  return found.filter((entry) => entry.path !== main)
}

const initRepo = (name: string) => {
  const repo = join(root, "src", name)
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
  return repo
}

const writeProfile = (file: string, extra: ReadonlyArray<string>) => {
  writeFileSync(
    file,
    [
      "version = 1",
      'worktrees_dir = "worktrees"',
      "[identity.ci]",
      'name = "CI"',
      'email = "ci@example.com"',
      "[[profile]]",
      `match = "${root}/src/**"`,
      'identity = "ci"',
      ...extra
    ].join("\n")
  )
}

beforeAll(() => {
  mkdirSync(home, { recursive: true })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("write actions recorded through run", () => {
  it("logs zwt rm of a clean merged worktree and does not delete the branch", () => {
    const repo = initRepo("rm")
    const config = join(root, "rm.toml")
    writeProfile(config, ['base_branch = "main"'])
    const created = zwt(repo, ["new", "done", "--config", config])
    expect(created.status, created.stderr).toBe(0)
    const linked = linkedWorktrees(repo).find((entry) => entry.branch === "done")
    expect(linked).toBeDefined()
    const before = readLog().length
    const removed = zwt(repo, ["rm", "done", "--config", config])
    expect(removed.status, removed.stderr).toBe(0)
    const added = readLog().slice(before)
    const checkout = mainCheckout(repo)
    expect(added).toContainEqual(expect.objectContaining({
      command: `git -C ${checkout} worktree remove ${linked?.path}`,
      result: "ok"
    }))
    expect(added.some((entry) => entry.command.includes("branch -d") || entry.command.includes("branch -D"))).toBe(false)
  })

  it("logs a worktree remove for each worktree zwt prune --merged removes", () => {
    const repo = initRepo("prune")
    const config = join(root, "prune.toml")
    writeProfile(config, ['base_branch = "main"'])
    const first = join(root, "wt", "one")
    const second = join(root, "wt", "two")
    mkdirSync(join(root, "wt"), { recursive: true })
    git(repo, "worktree", "add", "-q", "-b", "one", first, "main")
    git(repo, "worktree", "add", "-q", "-b", "two", second, "main")
    const paths = linkedWorktrees(repo).map((entry) => entry.path)
    expect(paths).toHaveLength(2)
    const before = readLog().length
    const pruned = zwt(repo, ["prune", "--merged", "--config", config])
    expect(pruned.status, pruned.stderr).toBe(0)
    const added = readLog().slice(before)
    const checkout = mainCheckout(repo)
    for (const path of paths) {
      expect(added).toContainEqual(expect.objectContaining({
        command: `git -C ${checkout} worktree remove ${path}`,
        result: "ok"
      }))
    }
    expect(added.some((entry) => entry.command.includes("branch -d") || entry.command.includes("branch -D"))).toBe(false)
  })

  it("logs branch -d when the removed branch is contained in HEAD", () => {
    const repo = initRepo("delete-d")
    const config = join(root, "delete-d.toml")
    writeProfile(config, ['base_branch = "main"'])
    const created = zwt(repo, ["new", "landed", "--config", config])
    expect(created.status, created.stderr).toBe(0)
    const linked = linkedWorktrees(repo).find((entry) => entry.branch === "landed")
    expect(linked).toBeDefined()
    const before = readLog().length
    const pruned = zwt(repo, ["prune", "--merged", "--delete-branch", "--config", config])
    expect(pruned.status, pruned.stderr).toBe(0)
    const added = readLog().slice(before)
    const checkout = mainCheckout(repo)
    expect(added).toContainEqual(expect.objectContaining({
      command: `git -C ${checkout} worktree remove ${linked?.path}`,
      result: "ok"
    }))
    expect(added).toContainEqual(expect.objectContaining({
      command: `git -C ${checkout} branch -d landed`,
      result: "ok"
    }))
  })

  it("logs branch -D when the removed branch is only in the base", () => {
    const repo = initRepo("delete-D")
    const config = join(root, "delete-D.toml")
    writeProfile(config, ['base_branch = "develop"', 'branch_prefix = "feature/"'])
    git(repo, "branch", "develop")
    const path = join(root, "src", "worktrees", "delete-D", "side")
    mkdirSync(join(root, "src", "worktrees", "delete-D"), { recursive: true })
    git(repo, "worktree", "add", "-q", "-b", "feature/side", path, "develop")
    git(path, "commit", "-q", "--allow-empty", "-m", "side")
    git(repo, "fetch", "-q", ".", "feature/side:develop")
    const linked = linkedWorktrees(repo).find((entry) => entry.branch === "feature/side")
    expect(linked).toBeDefined()
    const before = readLog().length
    const pruned = zwt(repo, ["prune", "--merged", "--delete-branch", "--config", config])
    expect(pruned.status, pruned.stderr).toBe(0)
    const added = readLog().slice(before)
    const checkout = mainCheckout(repo)
    expect(added).toContainEqual(expect.objectContaining({
      command: `git -C ${checkout} worktree remove ${linked?.path}`,
      result: "ok"
    }))
    expect(added).toContainEqual(expect.objectContaining({
      command: `git -C ${checkout} branch -D feature/side`,
      result: "ok"
    }))
  })

  it("logs the fetch and fast-forward of a base that is not checked out", () => {
    const origin = join(root, "origin.git")
    const seed = join(root, "seed")
    const repo = join(root, "ff")
    git(root, "init", "-q", "--bare", "-b", "main", origin)
    git(root, "init", "-q", "-b", "main", seed)
    writeFileSync(join(seed, "file.txt"), "hello\n")
    git(seed, "add", "file.txt")
    git(seed, "commit", "-q", "-m", "init")
    git(seed, "remote", "add", "origin", origin)
    git(seed, "push", "-q", "origin", "HEAD:main")
    git(root, "clone", "-q", origin, repo)
    git(repo, "checkout", "-q", "-b", "feature")
    git(seed, "commit", "-q", "--allow-empty", "-m", "second")
    git(seed, "push", "-q", "origin", "HEAD:main")
    const config = join(root, "sync.toml")
    writeFileSync(
      config,
      [
        "version = 1",
        "[identity.ci]",
        'name = "CI"',
        'email = "ci@example.com"',
        "[[project]]",
        `path = ${JSON.stringify(repo)}`,
        'identity = "ci"',
        'base_branch = "main"'
      ].join("\n")
    )
    const before = readLog().length
    const synced = zwt(repo, ["sync", "--config", config])
    expect(synced.status, synced.stderr).toBe(0)
    const added = readLog().slice(before)
    const checkout = mainCheckout(repo)
    const fetch = `git -C ${checkout} fetch --quiet origin main`
    const fastForward = `git -C ${checkout} fetch --quiet . refs/remotes/origin/main:refs/heads/main`
    const commands = added.map((entry) => entry.command)
    const fetchAt = commands.indexOf(fetch)
    const forwardAt = commands.indexOf(fastForward)
    expect(fetchAt).toBeGreaterThanOrEqual(0)
    expect(forwardAt).toBeGreaterThan(fetchAt)
    expect(added[fetchAt]?.result).toBe("ok")
    expect(added[forwardAt]?.result).toBe("ok")
  })
})
