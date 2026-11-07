import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const releaseSh = join(repoRoot, "scripts/release.sh")
const targetsPath = join(repoRoot, "scripts/release-targets.tsv")

const releaseTargets = [
  { target: "bun-linux-x64", asset: "zwt-linux-x64", os: "linux", arch: "x64" },
  { target: "bun-linux-arm64", asset: "zwt-linux-arm64", os: "linux", arch: "arm64" },
  { target: "bun-darwin-x64", asset: "zwt-darwin-x64", os: "darwin", arch: "x64" },
  { target: "bun-darwin-arm64", asset: "zwt-darwin-arm64", os: "darwin", arch: "arm64" }
] as const

const packageVersion = (): string => {
  const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("package.json has no version")
  }
  return parsed.version
}

const parseTargets = (source: string) =>
  source.split("\n").flatMap((line) => {
    if (line === "" || line.startsWith("#")) return []
    const parts = line.split("\t")
    if (parts.length !== 4 || parts.some((part) => part === "")) throw new Error(`bad release target row: ${JSON.stringify(line)}`)
    const [target, asset, os, arch] = parts
    return [{ target, asset, os, arch }]
  })

const tempDir = () => mkdtempSync(join(tmpdir(), "zwt-release-"))

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: tmpdir(),
  TMPDIR: tmpdir(),
  ...extra
})

const run = (args: Array<string>, extra: Record<string, string> = {}) =>
  spawnSync("bash", [releaseSh, ...args], { encoding: "utf8", env: env(extra), cwd: repoRoot })

const expectOk = (result: SpawnSyncReturns<string>) => {
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
}

const fillAssets = (dir: string) => {
  for (const row of releaseTargets) writeFileSync(join(dir, row.asset), `bytes ${row.asset}\n`)
}

describe("release packaging", () => {
  it("lists the four host targets from the issue", () => {
    expect(parseTargets(readFileSync(targetsPath, "utf8"))).toEqual([...releaseTargets])
  })

  it("prints the plan from release-targets.tsv", () => {
    const result = run(["plan"])
    expectOk(result)
    expect(result.stdout.trim().split("\n")).toEqual(
      releaseTargets.map((row) => `target ${row.target} asset ${row.asset} os ${row.os} arch ${row.arch}`)
    )
  })

  it("dry-run build prints bun commands and writes nothing", () => {
    const out = join(tempDir(), "out")
    const result = run(["build", "--dry-run", out], { PATH: "/usr/bin:/bin" })
    expectOk(result)
    expect(existsSync(out)).toBe(false)
    for (const row of releaseTargets) expect(result.stdout).toContain(`would build ${row.target} -> ${out}/${row.asset}`)
  })

  it("build invokes bun --compile for each target", () => {
    const root = tempDir()
    try {
      const bin = join(root, "bin")
      const log = join(root, "bun.log")
      mkdirSync(bin)
      const bun = join(bin, "bun")
      writeFileSync(
        bun,
        `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
outfile=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--outfile" ]; then outfile="$arg"; fi
  prev="$arg"
done
mkdir -p "$(dirname "$outfile")"
printf 'built %s\\n' "$outfile" > "$outfile"
`
      )
      chmodSync(bun, 0o755)
      const out = join(root, "out")
      const result = run(["build", out], { PATH: `${bin}:/usr/bin:/bin` })
      expectOk(result)
      const logText = readFileSync(log, "utf8")
      for (const row of releaseTargets) {
        expect(logText).toContain("--compile")
        expect(logText).toContain(`--target=${row.target}`)
        expect(logText).toContain(`${out}/${row.asset}`)
        expect(readFileSync(join(out, row.asset), "utf8")).toContain(row.asset)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("writes sha256 checksums for the release assets only", () => {
    const dir = tempDir()
    try {
      fillAssets(dir)
      writeFileSync(join(dir, "notes.txt"), "skip")
      writeFileSync(join(dir, "zwt"), "skip")
      expectOk(run(["checksums", dir]))
      const lines = readFileSync(join(dir, "checksums.txt"), "utf8").replace(/\n$/, "").split("\n")
      expect(lines.map((line) => line.split("  ")[1])).toEqual(releaseTargets.map((row) => row.asset))
      for (const row of releaseTargets) {
        const line = lines.find((entry) => entry.endsWith(`  ${row.asset}`))
        expect(line).toBeDefined()
        const hash = createHash("sha256").update(readFileSync(join(dir, row.asset))).digest("hex")
        expect(line).toBe(`${hash}  ${row.asset}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses checksums when a target binary is missing", () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, "zwt-linux-x64"), "only-one")
      const result = run(["checksums", dir])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("missing")
      expect(existsSync(join(dir, "checksums.txt"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts only the tag that matches package.json", () => {
    const version = packageVersion()
    expectOk(run(["check-tag"], { ZWT_TAG: `v${version}` }))
    const wrong = run(["check-tag"], { ZWT_TAG: "v9.9.9" })
    expect(wrong.status).not.toBe(0)
    expect(wrong.stderr).toContain(`package.json version ${version}`)
    const missing = run(["check-tag"])
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain("ZWT_TAG")
  })

  it("dry-run publish lists the assets and does not call gh", () => {
    const dir = tempDir()
    try {
      fillAssets(dir)
      expectOk(run(["checksums", dir]))
      const bin = join(dir, "bin")
      const ghLog = join(dir, "gh.log")
      mkdirSync(bin)
      writeFileSync(bin + "/gh", `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(ghLog)}\nexit 99\n`)
      chmodSync(join(bin, "gh"), 0o755)
      const version = packageVersion()
      const extra = { ZWT_TAG: `v${version}`, PATH: `${bin}:/usr/bin:/bin` }
      const result = run(["publish", "--dry-run", dir], extra)
      expectOk(result)
      expect(result.stdout).toContain(`would publish v${version}`)
      for (const row of releaseTargets) expect(result.stdout).toContain(`would upload ${row.asset}`)
      expect(result.stdout).toContain("would upload checksums.txt")
      expect(existsSync(ghLog)).toBe(false)

      const wrong = run(["publish", "--dry-run", dir], { ...extra, ZWT_TAG: "v9.9.9" })
      expect(wrong.status).not.toBe(0)
      expect(existsSync(ghLog)).toBe(false)

      const noSums = tempDir()
      fillAssets(noSums)
      const bare = run(["publish", "--dry-run", noSums], extra)
      expect(bare.status).not.toBe(0)
      expect(bare.stderr).toContain("checksums.txt")
      rmSync(noSums, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("publishes from the workflow only on a version tag", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8")
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
    expect(workflow).toContain("bash scripts/release.sh check-tag")
    expect(workflow).toContain("bash scripts/release.sh build dist/release")
    expect(workflow).toContain("bash scripts/release.sh checksums dist/release")
    expect(workflow).toContain("bash scripts/release.sh publish dist/release")
    expect(workflow).toContain("contents: write")
    expect(workflow).toContain("bun-version: 1.4.2")
    expect(ci).toContain("bun-version: 1.4.2")
    expect(workflow).toContain('tags:\n      - "v*.*.*"')
    expect(workflow.match(/github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/g)).toHaveLength(2)
    expect(workflow).not.toContain("pull_request")
    expect(readme).toContain("https://raw.githubusercontent.com/Byevenes/zwt/main/install.sh")
    expect(readme).toContain(`--version v${packageVersion()}`)
    for (const row of releaseTargets) expect(readme).toContain(row.asset)
  })
})
