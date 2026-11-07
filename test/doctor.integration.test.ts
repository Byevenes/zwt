import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-doctor-")))
const home = join(root, "home")
const repo = join(root, "repo")
const configPath = join(root, "zwt.toml")
const main = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
const runEnv = {
  ...env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  GIT_CONFIG_NOSYSTEM: "1"
}
const git = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, env: runEnv, encoding: "utf8" }).trim()
const zwt = (...args: Array<string>) => spawnSync(process.execPath, [main, ...args], { cwd: repo, env: runEnv, encoding: "utf8" })
const localList = () => git(repo, "config", "--local", "--list")

beforeAll(() => {
  mkdirSync(home, { recursive: true })
  mkdirSync(repo, { recursive: true })
  git(root, "init", "-q", "-b", "main", repo)
  const toplevel = git(repo, "rev-parse", "--show-toplevel")
  writeFileSync(
    configPath,
    [
      "version = 1",
      "[identity.personal]",
      'name = "Jane Doe"',
      'email = "jane@example.com"',
      "[[profile]]",
      `match = "${toplevel}/**"`,
      'identity = "personal"'
    ].join("\n")
  )
  git(repo, "config", "user.name", "Jane Doe")
  git(repo, "config", "user.email", "other@example.com")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("zwt doctor end to end (real git, temp HOME)", () => {
  it("exits non-zero on an identity mismatch and names a fix", () => {
    const before = localList()
    const result = zwt("doctor", "--config", configPath)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain("identity fail")
    expect(`${result.stdout}\n${result.stderr}`).toContain("git -C")
    expect(`${result.stdout}\n${result.stderr}`).toContain("config --worktree user.email jane@example.com")
    expect(localList()).toBe(before)
  })

  it("exits zero when the email matches", () => {
    git(repo, "config", "user.email", "jane@example.com")
    const result = zwt("doctor", "--config", configPath)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("identity ok matches jane@example.com")
    expect(result.stderr).toBe("")
  })

  it("dry-run prints that there is nothing to write and leaves git config unchanged", () => {
    git(repo, "config", "user.email", "jane@example.com")
    const before = localList()
    const result = zwt("--dry-run", "doctor", "--config", configPath)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("dry-run: nothing to write")
    expect(result.stderr).toBe("")
    expect(localList()).toBe(before)
    expect(git(repo, "config", "--get", "user.email")).toBe("jane@example.com")
  })

  it("prints json for one repo", () => {
    git(repo, "config", "user.email", "jane@example.com")
    const result = zwt("doctor", "--output", "json", "--config", configPath)
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      readonly repo: string
      readonly currentEmail: string
      readonly expectedEmail: string
      readonly checks: ReadonlyArray<{ readonly name: string; readonly status: string }>
    }
    expect(parsed.repo).toBe(git(repo, "rev-parse", "--show-toplevel"))
    expect(parsed.currentEmail).toBe("jane@example.com")
    expect(parsed.expectedEmail).toBe("jane@example.com")
    expect(parsed.checks.map((check) => check.name)).toEqual(["identity", "expect_remote", "remote_identity", "hooksPath"])
    expect(parsed.checks[0]?.status).toBe("ok")
    expect(parsed.checks[1]?.status).toBe("ok")
  })

  it("fails when origin matches a [[remote]] that requires another identity", () => {
    git(repo, "config", "user.email", "jane@example.com")
    git(repo, "remote", "add", "origin", "https://github.com/other-org/app.git")
    const toplevel = git(repo, "rev-parse", "--show-toplevel")
    const file = join(root, "remote.toml")
    writeFileSync(
      file,
      [
        "version = 1",
        "[identity.personal]",
        'name = "Jane Doe"',
        'email = "jane@example.com"',
        "[identity.external]",
        'name = "Jane External"',
        'email = "jane.external@example.com"',
        "[[project]]",
        `path = "${toplevel}"`,
        'identity = "personal"',
        "[[remote]]",
        'pattern = "github.com/other-org/"',
        'identity = "external"'
      ].join("\n")
    )
    const result = zwt("doctor", "--config", file)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain("remote_identity fail")
    expect(result.stdout).toContain(`zwt identity set external ${toplevel}`)
    const all = zwt("doctor", "--all", "--output", "json", "--config", file)
    expect(all.status).not.toBe(0)
    const parsed = JSON.parse(all.stdout) as {
      readonly repos: ReadonlyArray<{
        readonly checks: ReadonlyArray<{ readonly name: string; readonly status: string; readonly fix?: string }>
      }>
    }
    const check = parsed.repos[0]?.checks.find((item) => item.name === "remote_identity")
    expect(check?.status).toBe("fail")
    expect(check?.fix).toContain(`zwt identity set external ${toplevel}`)
  })
})
