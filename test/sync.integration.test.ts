import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-sync-")))
const home = join(root, "home")
const origin = join(root, "origin.git")
const seed = join(root, "seed")
const ff = join(root, "ff")
const dry = join(root, "dry")
const split = join(root, "split")
const pair = join(root, "pair")
const live = join(root, "live")
const ahead = join(root, "ahead")
const linked = join(root, "linked")
const linkedMain = join(root, "linked-main")
const localOnly = join(root, "local-only")
const absent = join(root, "absent")
const mainTs = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
const runEnv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" }

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, env: runEnv, encoding: "utf8" }).trim()

const zwt = (...args: Array<string>) =>
  spawnSync(process.execPath, [mainTs, ...args], { cwd: root, env: runEnv, encoding: "utf8" })

const identify = (cwd: string) => {
  git(cwd, "config", "user.email", "jane@example.com")
  git(cwd, "config", "user.name", "Jane Doe")
}

const dirty = (cwd: string) => {
  writeFileSync(join(cwd, "file.txt"), "dirty tracked\n")
  writeFileSync(join(cwd, "notes.txt"), "dirty untracked\n")
}

const worktree = (cwd: string) => ({
  porcelain: git(cwd, "status", "--porcelain"),
  tracked: readFileSync(join(cwd, "file.txt"), "utf8"),
  untracked: readFileSync(join(cwd, "notes.txt"), "utf8"),
  branch: git(cwd, "branch", "--show-current"),
  head: git(cwd, "rev-parse", "HEAD")
})

const globalDigest = () => {
  const listed = spawnSync("git", ["config", "--global", "--list"], { env: runEnv, encoding: "utf8" })
  return createHash("sha256").update(listed.status === 0 ? listed.stdout : "").digest("hex")
}

const writeConfig = (paths: ReadonlyArray<string>) => {
  const file = join(root, `zwt-${paths.length}-${paths[0]?.replaceAll("/", "_") ?? "empty"}.toml`)
  const lines = [
    "version = 1",
    "[identity.personal]",
    'name = "Jane Doe"',
    'email = "jane@example.com"',
    ...paths.flatMap((path) => ["[[project]]", `path = ${JSON.stringify(path)}`, 'identity = "personal"'])
  ]
  writeFileSync(file, `${lines.join("\n")}\n`)
  return file
}

let originTip = ""
let splitMain = ""

beforeAll(() => {
  mkdirSync(home, { recursive: true })
  mkdirSync(absent, { recursive: true })
  git(root, "init", "-q", "--bare", "-b", "main", origin)
  git(root, "init", "-q", "-b", "main", seed)
  identify(seed)
  writeFileSync(join(seed, "file.txt"), "hello\n")
  git(seed, "add", "file.txt")
  git(seed, "commit", "-q", "-m", "init")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "-q", "origin", "HEAD:main")

  for (const path of [ff, dry, split, pair, live, ahead, linked]) {
    git(root, "clone", "-q", origin, path)
    identify(path)
  }
  git(root, "init", "-q", "-b", "main", localOnly)
  identify(localOnly)
  git(localOnly, "commit", "-q", "--allow-empty", "-m", "local")

  git(split, "commit", "-q", "--allow-empty", "-m", "local only")
  splitMain = git(split, "rev-parse", "main")
  git(split, "checkout", "-q", "-b", "feature")

  git(seed, "commit", "-q", "--allow-empty", "-m", "second")
  git(seed, "push", "-q", "origin", "HEAD:main")
  originTip = git(seed, "rev-parse", "main")

  git(ahead, "fetch", "-q", "origin", "main")
  git(ahead, "merge", "-q", "--ff-only", "origin/main")
  git(ahead, "commit", "-q", "--allow-empty", "-m", "local ahead")
  git(ahead, "checkout", "-q", "-b", "feature")

  git(dry, "fetch", "-q", "origin", "main")
  git(dry, "checkout", "-q", "-b", "feature")
  dirty(dry)

  for (const path of [ff, pair]) {
    git(path, "checkout", "-q", "-b", "feature")
    dirty(path)
  }

  dirty(live)

  git(linked, "checkout", "-q", "-b", "feature")
  git(linked, "worktree", "add", "-q", linkedMain, "main")
  dirty(linkedMain)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("zwt sync end to end (real git, temp repos)", () => {
  it("fast-forwards a base that is not checked out and leaves the dirty work tree", () => {
    const before = worktree(ff)
    const previous = git(ff, "rev-parse", "main")
    const globals = globalDigest()
    expect(previous).not.toBe(originTip)
    const file = writeConfig([ff])
    const result = zwt("sync", "--config", file)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`${ff} | main | fast-forward`)
    expect(git(ff, "rev-parse", "main")).toBe(originTip)
    expect(git(ff, "merge-base", "--is-ancestor", previous, "main")).toBe("")
    expect(git(ff, "rev-list", "--merges", "main")).toBe("")
    expect(worktree(ff)).toEqual(before)
    expect(globalDigest()).toBe(globals)

    const again = zwt("sync", "--config", file)
    expect(again.status).toBe(0)
    expect(again.stderr).toBe("")
    expect(again.stdout).toContain(`${ff} | main | up-to-date`)
    expect(git(ff, "rev-parse", "main")).toBe(originTip)
    expect(worktree(ff)).toEqual(before)
  })

  it("dry-run prints the summary and the fetches without moving the branch", () => {
    const before = worktree(dry)
    const main = git(dry, "rev-parse", "refs/heads/main")
    expect(main).not.toBe(git(dry, "rev-parse", "refs/remotes/origin/main"))
    const result = zwt("--dry-run", "sync", "--config", writeConfig([dry]))
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain(`${dry} | main | fast-forward`)
    expect(result.stdout).toContain("dry-run: planned writes")
    expect(result.stdout).toContain(`git -C ${dry} fetch --quiet origin main`)
    expect(result.stdout).toContain(`git -C ${dry} fetch --quiet . refs/remotes/origin/main:refs/heads/main`)
    expect(git(dry, "rev-parse", "refs/heads/main")).toBe(main)
    expect(worktree(dry)).toEqual(before)
  })

  it("fast-forwards one repo and reports another that has diverged", () => {
    const pairBefore = worktree(pair)
    const splitHead = git(split, "rev-parse", "HEAD")
    const result = zwt("sync", "--config", writeConfig([pair, split]))
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`${pair} | main | fast-forward`)
    expect(result.stdout).toContain(`${split} | main | diverged`)
    expect(result.stdout).toContain("does not merge or reset")
    expect(result.stderr).toContain("1 repo was not fast-forwarded")
    expect(result.stderr).toContain("does not merge or reset")
    expect(git(pair, "rev-parse", "main")).toBe(originTip)
    expect(worktree(pair)).toEqual(pairBefore)
    expect(git(split, "rev-parse", "refs/heads/main")).toBe(splitMain)
    expect(git(split, "rev-parse", "HEAD")).toBe(splitHead)
    expect(git(split, "rev-list", "--merges", "main")).toBe("")
  })

  it("does not touch a checked-out base or its local changes", () => {
    const before = worktree(live)
    const result = zwt("sync", "--config", writeConfig([live]))
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain(`${live} | main | checked-out`)
    expect(result.stdout).toContain(`checked out at ${live}`)
    expect(git(live, "rev-parse", "HEAD")).toBe(before.head)
    expect(git(live, "rev-parse", "refs/heads/main")).toBe(before.head)
    expect(git(live, "rev-parse", "refs/remotes/origin/main")).toBe(originTip)
    expect(worktree(live)).toEqual(before)
  })

  it("does not move a base that is checked out in a linked worktree", () => {
    const mainOid = git(linked, "rev-parse", "refs/heads/main")
    const before = worktree(linkedMain)
    const feature = git(linked, "rev-parse", "HEAD")
    const result = zwt("sync", "--config", writeConfig([linked]))
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("checked-out")
    expect(result.stdout).toContain(linkedMain)
    expect(git(linked, "rev-parse", "refs/heads/main")).toBe(mainOid)
    expect(git(linked, "rev-parse", "HEAD")).toBe(feature)
    expect(git(linked, "rev-parse", "refs/remotes/origin/main")).toBe(originTip)
    expect(worktree(linkedMain)).toEqual(before)
  })

  it("reports a base that is ahead and does not reset it", () => {
    const mainOid = git(ahead, "rev-parse", "refs/heads/main")
    expect(mainOid).not.toBe(originTip)
    const head = git(ahead, "rev-parse", "HEAD")
    const result = zwt("sync", "--config", writeConfig([ahead]))
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain(`${ahead} | main | ahead`)
    expect(result.stdout.includes("fix:")).toBe(false)
    expect(git(ahead, "rev-parse", "refs/heads/main")).toBe(mainOid)
    expect(git(ahead, "rev-parse", "HEAD")).toBe(head)
    expect(git(ahead, "rev-list", "--merges", "main")).toBe("")
  })

  it("reports a repo without origin and a configured path that is not a repository", () => {
    const localHead = git(localOnly, "rev-parse", "HEAD")
    const result = zwt("sync", "--config", writeConfig([localOnly, absent]))
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`${localOnly} | main | no-remote`)
    expect(result.stdout).toContain(`${absent} | - | not-a-repo`)
    expect(result.stderr).toContain("2 repos were not fast-forwarded")
    expect(git(localOnly, "rev-parse", "HEAD")).toBe(localHead)
    expect(result.stdout.includes("git init")).toBe(false)
  })
})
