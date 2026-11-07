import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { StatusReportSchema } from "../src/commands/status.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-status-")))
const home = join(root, "home")
const repo = join(root, "repo")
const feature = join(root, "feature")
const notes = join(root, "notes")
const empty = join(root, "empty")
const configPath = join(root, "zwt.toml")
const main = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
const runEnv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" }
const git = (cwd: string, args: ReadonlyArray<string>, when?: string) =>
  execFileSync("git", args, {
    cwd,
    env: when === undefined ? runEnv : { ...runEnv, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    encoding: "utf8"
  }).trim()
const zwt = (cwd: string, ...args: Array<string>) =>
  spawnSync(process.execPath, [main, ...args], { cwd, env: runEnv, encoding: "utf8" })
const decodeReport = Schema.decodeUnknownSync(StatusReportSchema, { onExcessProperty: "error" })
const day = 86_400_000

const commit = (cwd: string, message: string, when: string) => {
  git(cwd, ["add", "-A"])
  git(cwd, ["-c", "user.name=Jane Doe", "-c", "user.email=jane@example.com", "commit", "-q", "-m", message], when)
}

const indexFile = (cwd: string) => {
  const path = git(cwd, ["rev-parse", "--git-path", "index"])
  return isAbsolute(path) ? path : join(cwd, path)
}

const checksum = (cwd: string) => readFileSync(indexFile(cwd))

let repoIndex = Buffer.alloc(0)
let featureIndex = Buffer.alloc(0)
let mainDays = 0

beforeAll(() => {
  mkdirSync(home, { recursive: true })
  mkdirSync(empty, { recursive: true })
  const now = Date.now()
  const ago = (days: number) => new Date(now - days * day - 120_000).toISOString()
  git(root, ["init", "-q", "-b", "main", repo])
  writeFileSync(join(repo, "readme.txt"), "a\n")
  commit(repo, "base", ago(6))
  git(repo, ["worktree", "add", "-q", "-b", "feature", feature])
  writeFileSync(join(feature, "note.txt"), "b\n")
  commit(feature, "feature", ago(3))
  writeFileSync(join(repo, "readme.txt"), "c\n")
  commit(repo, "main again", ago(5))
  writeFileSync(join(feature, "note.txt"), "b\nchanged\n")
  git(root, ["init", "-q", "-b", "main", notes])
  writeFileSync(join(notes, "readme.txt"), "n\n")
  commit(notes, "notes", ago(1))
  const repoTop = git(repo, ["rev-parse", "--show-toplevel"])
  const notesTop = git(notes, ["rev-parse", "--show-toplevel"])
  writeFileSync(
    configPath,
    [
      "version = 1",
      "[identity.personal]",
      'name = "Jane Doe"',
      'email = "jane@example.com"',
      "[[project]]",
      `path = "${repoTop}"`,
      'base_branch = "main"',
      "[[project]]",
      `path = "${notesTop}"`,
      'base_branch = "main"'
    ].join("\n")
  )
  const committed = Number(git(repo, ["log", "-1", "--format=%ct"]))
  mainDays = Math.floor((Date.now() - committed * 1000) / day)
  repoIndex = checksum(repo)
  featureIndex = checksum(feature)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("zwt status end to end (real git, temp repos)", () => {
  it("reports ahead, behind, dirty, and days, and leaves the index alone", () => {
    const before = checksum(repo)
    const dirty = git(feature, ["status", "--porcelain"])
    const result = zwt(repo, "status", "--output", "json", "--config", configPath)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    const report = decodeReport(JSON.parse(result.stdout))
    expect(report.version).toBe(1)
    const featureTop = git(feature, ["rev-parse", "--show-toplevel"])
    const repoTop = git(repo, ["rev-parse", "--show-toplevel"])
    expect(report.worktrees).toEqual([
      {
        repo: repoTop,
        branch: "main",
        base: "main",
        ahead: 0,
        behind: 0,
        dirty: false,
        daysSinceActivity: mainDays
      },
      {
        repo: featureTop,
        branch: "feature",
        base: "main",
        ahead: 1,
        behind: 1,
        dirty: true,
        daysSinceActivity: 0
      }
    ])
    expect(mainDays).toBe(5)
    expect(checksum(repo)).toEqual(before)
    expect(checksum(feature)).toEqual(featureIndex)
    expect(git(feature, ["status", "--porcelain"])).toBe(dirty)
  })

  it("prints the same rows as text from a linked worktree", () => {
    const result = zwt(feature, "status", "--config", configPath)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("repo | branch | base | ahead | behind | dirty | days")
    expect(result.stdout).toContain("| feature | main | 1 | 1 | yes | 0")
    expect(result.stdout).toContain(`| main | main | 0 | 0 | no | ${mainDays}`)
  })

  it("dry-run prints that there is nothing to write", () => {
    const result = zwt(repo, "--dry-run", "status", "--config", configPath)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("dry-run: nothing to write")
    expect(result.stderr).toBe("")
    expect(checksum(repo)).toEqual(repoIndex)
    expect(checksum(feature)).toEqual(featureIndex)
  })

  it("lists every configured repo from a directory that is not a checkout", () => {
    const result = zwt(empty, "status", "--all", "--output", "json", "--config", configPath)
    expect(result.status).toBe(0)
    const report = decodeReport(JSON.parse(result.stdout))
    expect(report.worktrees.map((row) => row.branch)).toEqual(["main", "feature", "main"])
    expect(report.worktrees[2]?.repo).toBe(git(notes, ["rev-parse", "--show-toplevel"]))
    expect(report.worktrees[2]?.dirty).toBe(false)
  })

  it("fails outside a repository when --all is absent", () => {
    const result = zwt(empty, "status", "--config", configPath)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain("rev-parse --show-toplevel")
  })
})
