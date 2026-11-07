import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-log-")))
const home = join(root, "home")
const repo = join(root, "src", "r")
const state = join(root, "state")
const logFile = join(state, "zwt", "actions.log")
const configPath = join(root, "zwt.toml")
const main = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
const runEnv = {
  ...env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: state,
  GIT_CONFIG_NOSYSTEM: "1"
}
const zwt = (args: ReadonlyArray<string>, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [main, ...args], { cwd: repo, env: { ...runEnv, ...extra }, encoding: "utf8" })

beforeAll(() => {
  mkdirSync(home, { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: runEnv })
  execFileSync("git", ["-C", repo, "-c", "user.name=CI", "-c", "user.email=ci@example.com", "commit", "-q", "--allow-empty", "-m", "init"], {
    env: runEnv
  })
  writeFileSync(
    configPath,
    [
      "version = 1",
      'worktrees_dir = "worktrees"',
      "[identity.ci]",
      'name = "CI"',
      'email = "ci@example.com"',
      "[[profile]]",
      `match = "${root}/src/**"`,
      'identity = "ci"',
      'base_branch = "main"'
    ].join("\n")
  )
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("zwt log", () => {
  it("appends real writes and does not append a dry-run", () => {
    const missing = zwt(["log"])
    expect(missing.status).toBe(0)
    expect(missing.stdout.trim()).toBe("no actions")
    expect(missing.stderr).toBe("")
    expect(existsSync(logFile)).toBe(false)

    const dry = zwt(["--dry-run", "new", "planned", "--config", configPath])
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain("would create")
    expect(dry.stdout).not.toContain("actions.log")
    expect(existsSync(logFile)).toBe(false)
    expect(existsSync(join(root, "src", "worktrees", "r", "planned"))).toBe(false)

    const created = zwt(["new", "demo", "--config", configPath])
    expect(created.status).toBe(0)
    expect(created.stderr).toBe("")
    expect(created.stdout).toContain("created")

    const entries = readFileSync(logFile, "utf8").trim().split("\n").map((line) =>
      JSON.parse(line) as { timestamp: string; command: string; result: string }
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const item of entries) {
      expect(item.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(item.result).toBe("ok")
    }
    const commands = entries.map((item) => item.command)
    expect(commands.some((command) => command.includes("worktree add -b"))).toBe(true)
    expect(commands.some((command) => command.includes("config --worktree user.email ci@example.com"))).toBe(true)
    expect(commands.some((command) => command.includes("info/exclude"))).toBe(true)
    expect(commands.some((command) => command.includes("--global"))).toBe(false)

    const shown = zwt(["log"])
    expect(shown.status).toBe(0)
    expect(shown.stderr).toBe("")
    const shownLines = shown.stdout.trim().split("\n")
    expect(shownLines).toHaveLength(entries.length)
    expect(shownLines[0]).toContain("ok")
    expect(shownLines[0]).toContain(entries[0]?.command)

    const before = readFileSync(logFile)
    const againDry = zwt(["--dry-run", "new", "other", "--config", configPath])
    expect(againDry.status).toBe(0)
    expect(againDry.stdout).toContain("would create")
    expect(readFileSync(logFile)).toEqual(before)
    expect(existsSync(join(root, "src", "worktrees", "r", "other"))).toBe(false)

    const again = zwt(["new", "demo", "--config", configPath])
    expect(again.status).toBe(0)
    expect(again.stdout).toContain("exists")
    expect(readFileSync(logFile)).toEqual(before)

    const nope = zwt(["new", "nope", "--base", "missing", "--config", configPath])
    expect(nope.status).not.toBe(0)
    expect(readFileSync(logFile)).toEqual(before)

    const dryLog = zwt(["--dry-run", "log"])
    expect(dryLog.status).toBe(0)
    expect(dryLog.stdout).toContain("dry-run: nothing to write")
    expect(dryLog.stdout).toContain(entries[0]?.command)
    expect(readFileSync(logFile)).toEqual(before)
  })

  it("uses ~/.local/state when XDG_STATE_HOME is unset", () => {
    const { XDG_STATE_HOME: _state, ...withoutState } = runEnv
    const result = spawnSync(process.execPath, [main, "new", "fallback", "--config", configPath], {
      cwd: repo,
      env: withoutState,
      encoding: "utf8"
    })
    expect(result.status).toBe(0)
    const fallback = join(home, ".local", "state", "zwt", "actions.log")
    expect(readFileSync(fallback, "utf8")).toContain("worktree add")
  })
})
