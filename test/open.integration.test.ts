import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = realpathSync(mkdtempSync(join(tmpdir(), "zwt-open-")))
const home = join(root, "home")
const repo = join(home, "work", "acme", "web")
const bin = join(root, "bin")
const main = new URL("../src/main.ts", import.meta.url).pathname
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
const runEnv = {
  ...env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: `${bin}${delimiter}${env.PATH ?? ""}`
}
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, env: runEnv, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
const zwt = (marker: string, ...args: Array<string>) =>
  spawnSync(process.execPath, [main, ...args], { cwd: repo, env: { ...runEnv, MARKER: marker }, encoding: "utf8" })
const markerFile = (name: string) => join(root, `${name}.marker`)
const worktree = (slug: string) => join(home, "work", "acme", "worktrees", "web", slug)

const profile = (command: string) =>
  [
    "version = 1",
    "[identity.work]",
    'name = "Jane Doe"',
    'email = "jane@example.com"',
    "[[profile]]",
    'match = "~/work/acme/**"',
    'identity = "work"',
    'base_branch = "main"',
    'branch_prefix = "feature/"',
    command
  ].join("\n")

beforeAll(() => {
  mkdirSync(join(home, ".config", "zwt"), { recursive: true })
  mkdirSync(join(home, "work", "acme"), { recursive: true })
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "zwt-rec")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "{",
      "  printf 'pwd=%s\\n' \"$PWD\"",
      "  printf 'argc=%s\\n' \"$#\"",
      "  n=1",
      "  for arg in \"$@\"; do",
      "    printf 'arg%s=%s\\n' \"$n\" \"$arg\"",
      "    n=$((n + 1))",
      "  done",
      "} > \"${MARKER:?}\"",
      ""
    ].join("\n")
  )
  chmodSync(script, 0o755)
  writeFileSync(join(home, ".config", "zwt", "zwt.toml"), profile('open_command = "zwt-rec --flag"\nagent_command = "zwt-rec"'))
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "config", "user.email", "jane@example.com")
  git(repo, "config", "user.name", "Jane Doe")
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("zwt open / zwt agent", () => {
  it("refuses to open a slug that has no worktree", () => {
    const marker = markerFile("absent")
    const result = zwt(marker, "open", "absent")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no worktree for branch "feature/absent"')
    expect(result.stderr).toContain("fix:")
    expect(result.stderr).toContain("zwt new absent")
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(worktree("absent"))).toBe(false)
  })

  it("creates with --open, then opens and starts an agent in that worktree", () => {
    const slug = "login"
    const path = worktree(slug)
    const created = zwt(markerFile("create"), "new", slug, "--open")
    expect(created.status).toBe(0)
    expect(created.stderr).toBe("")
    expect(created.stdout.indexOf(`created ${path}`)).toBeGreaterThanOrEqual(0)
    expect(created.stdout.indexOf(`created ${path}`)).toBeLessThan(created.stdout.indexOf(`zwt-rec --flag ${path}`))
    expect(created.stdout.indexOf(`zwt-rec --flag ${path}`)).toBeLessThan(created.stdout.indexOf(`opened ${path}`))
    expect(readFileSync(markerFile("create"), "utf8")).toBe(`pwd=${path}\nargc=2\narg1=--flag\narg2=${path}\n`)
    expect(git(path, "branch", "--show-current")).toBe("feature/login")

    const again = zwt(markerFile("again"), "new", slug, "--open")
    expect(again.status).toBe(0)
    expect(again.stdout).toContain(`exists ${path}`)
    expect(readFileSync(markerFile("again"), "utf8")).toContain(`arg2=${path}`)

    const opened = zwt(markerFile("open"), "open", slug)
    expect(opened.status).toBe(0)
    expect(opened.stderr).toBe("")
    expect(opened.stdout.indexOf(`zwt-rec --flag ${path}`)).toBeLessThan(opened.stdout.indexOf(`opened ${path}`))
    expect(readFileSync(markerFile("open"), "utf8")).toBe(`pwd=${path}\nargc=2\narg1=--flag\narg2=${path}\n`)

    const started = zwt(markerFile("agent"), "agent", slug)
    expect(started.status).toBe(0)
    expect(started.stderr).toBe("")
    expect(started.stdout.indexOf(`(cwd ${path}) zwt-rec`)).toBeLessThan(started.stdout.indexOf(`started ${path}`))
    expect(readFileSync(markerFile("agent"), "utf8")).toBe(`pwd=${path}\nargc=0\n`)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("does not create a worktree when --open has no open_command", () => {
    const config = join(root, "unset.toml")
    writeFileSync(config, profile(""))
    const marker = markerFile("unset")
    const path = worktree("no-open")
    const result = zwt(marker, "new", "no-open", "--open", "--config", config)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("no open_command")
    expect(result.stderr).toContain("fix:")
    expect(result.stdout.includes("created")).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  it("fails with a clear error when the executable is not installed", () => {
    const seeded = zwt(markerFile("seed-missing"), "new", "login")
    expect(seeded.status).toBe(0)
    expect(existsSync(markerFile("seed-missing"))).toBe(false)
    const config = join(root, "missing.toml")
    writeFileSync(config, profile('open_command = "zwt-missing-bin"'))
    const marker = markerFile("missing")
    const path = worktree("login")
    const result = zwt(marker, "open", "login", "--config", config)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("command not found: zwt-missing-bin")
    expect(result.stderr).toContain("fix:")
    expect(result.stderr).toContain("open_command")
    expect(result.stdout).toContain(`zwt-missing-bin ${path}`)
    expect(existsSync(marker)).toBe(false)
  })

  it("prints the command on --dry-run and does not run it", () => {
    const seeded = zwt(markerFile("seed-dry"), "new", "login")
    expect(seeded.status).toBe(0)
    const path = worktree("login")
    const marker = markerFile("dry-open")
    const opened = zwt(marker, "--dry-run", "open", "login")
    expect(opened.status).toBe(0)
    expect(opened.stdout).toContain(`would open ${path}`)
    expect(opened.stdout).toContain(`[exec] zwt-rec --flag ${path}`)
    expect(existsSync(marker)).toBe(false)

    const planned = worktree("planned")
    const created = zwt(markerFile("dry-new"), "--dry-run", "new", "planned", "--open")
    expect(created.status).toBe(0)
    expect(created.stdout).toContain("would create")
    expect(created.stdout).toContain("worktree add -b feature/planned")
    expect(created.stdout).toContain(`[exec] zwt-rec --flag ${planned}`)
    expect(existsSync(planned)).toBe(false)
    expect(existsSync(markerFile("dry-new"))).toBe(false)
  })
})
