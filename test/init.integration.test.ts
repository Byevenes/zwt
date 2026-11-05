import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-init-")))
const home = join(root, "home")
const configPath = join(root, "out", "zwt.toml")
const gitconfig = join(home, ".gitconfig")
const main = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
const runEnv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" }
const zwt = (...args: Array<string>) => spawnSync(process.execPath, [main, ...args], { cwd: root, env: runEnv, encoding: "utf8" })

const personal = [
  "[user]",
  "\tname = Jane Doe",
  "\temail = jane@example.com"
].join("\n")
const work = [
  "[user]",
  "\tname = Jane Doe",
  "\temail = jane.doe@example.com"
].join("\n")

beforeAll(() => {
  mkdirSync(join(home, ".config", "git"), { recursive: true })
  writeFileSync(join(home, ".config", "git", "config"), [
    "[includeIf \"gitdir:~/personal/\"]",
    "\tpath = ~/.config/git/personal"
  ].join("\n"))
  writeFileSync(join(home, ".config", "git", "personal"), personal)
  writeFileSync(join(home, ".config", "git", "work"), work)
  writeFileSync(gitconfig, [
    "[user]",
    "\tname = Global Jane",
    "\temail = global@example.com",
    "[includeIf \"gitdir:~/work/\"]",
    "\tpath = ~/.config/git/work"
  ].join("\n"))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("zwt init end to end (temp HOME)", () => {
  it("imports includeIf identities into zwt.toml and passes config check", () => {
    const before = readFileSync(gitconfig, "utf8")
    const result = zwt("init", "--config", configPath)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain(`wrote ${configPath} (2 identities)`)
    const written = readFileSync(configPath, "utf8")
    expect(written).toContain("email = \"jane@example.com\"")
    expect(written).toContain("email = \"jane.doe@example.com\"")
    expect(written).toContain("match = \"~/personal/**\"")
    expect(written).toContain("match = \"~/work/**\"")
    expect(written).not.toContain("global@example.com")
    expect(readFileSync(gitconfig, "utf8")).toBe(before)
    expect(readFileSync(join(home, ".config", "git", "personal"), "utf8")).toBe(personal)

    const check = zwt("config", "check", "--config", configPath)
    expect(check.status).toBe(0)
    expect(check.stdout).toContain(`ok ${configPath}: 2 identities, 2 profiles`)
  })

  it("refuses to overwrite an existing zwt.toml without confirmation", () => {
    const before = readFileSync(configPath, "utf8")
    const gitBefore = readFileSync(gitconfig, "utf8")
    const result = zwt("init", "--config", configPath)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(`refusing to overwrite ${configPath}`)
    expect(readFileSync(configPath, "utf8")).toBe(before)
    expect(readFileSync(gitconfig, "utf8")).toBe(gitBefore)
  })

  it("dry-run prints the file it would write and does not create it", () => {
    const starter = join(root, "dry", "zwt.toml")
    const result = zwt("--dry-run", "init", "--yes", "--config", starter)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`would write ${starter}`)
    expect(result.stdout).toContain("dry-run: planned writes")
    expect(result.stdout).toContain(`[fs] write ${starter}`)
    expect(() => readFileSync(starter, "utf8")).toThrow()
    expect(readFileSync(gitconfig, "utf8")).toContain("global@example.com")
  })

  it("writes a starter when git has no includeIf identity", () => {
    const emptyHome = join(root, "empty-home")
    mkdirSync(emptyHome, { recursive: true })
    const starter = join(root, "starter.toml")
    const result = spawnSync(process.execPath, [main, "init", "--config", starter], {
      cwd: root,
      env: { ...runEnv, HOME: emptyHome, XDG_CONFIG_HOME: join(emptyHome, ".config") },
      encoding: "utf8"
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`wrote starter ${starter}`)
    const check = zwt("config", "check", "--config", starter)
    expect(check.status).toBe(0)
    expect(check.stdout).toContain("1 identities, 1 profiles")
    expect(readFileSync(starter, "utf8")).toContain("jane@example.com")
    expect(readFileSync(starter, "utf8")).toContain("~/personal/**")
  })

  it("--yes replaces an existing file", () => {
    const before = readFileSync(gitconfig, "utf8")
    writeFileSync(configPath, "version = 0\n")
    const result = zwt("init", "--yes", "--config", configPath)
    expect(result.status).toBe(0)
    expect(readFileSync(configPath, "utf8")).toContain("jane@example.com")
    expect(readFileSync(configPath, "utf8")).not.toContain("version = 0")
    expect(readFileSync(gitconfig, "utf8")).toBe(before)
  })
})
