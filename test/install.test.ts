import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const installSh = join(repoRoot, "install.sh")
const releaseSh = join(repoRoot, "scripts/release.sh")

const releaseTargets = [
  { asset: "zwt-linux-x64", os: "linux", arch: "x64" },
  { asset: "zwt-linux-arm64", os: "linux", arch: "arm64" },
  { asset: "zwt-darwin-x64", os: "darwin", arch: "x64" },
  { asset: "zwt-darwin-arm64", os: "darwin", arch: "arm64" }
] as const

const tempDir = () => mkdtempSync(join(tmpdir(), "zwt-install-"))

const env = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/bin:/bin",
  HOME: tmpdir(),
  TMPDIR: tmpdir(),
  ...extra
})

const run = (args: Array<string>, extra: Record<string, string> = {}) =>
  spawnSync("/bin/sh", [installSh, ...args], { encoding: "utf8", env: env(extra), cwd: repoRoot })

const expectOk = (result: SpawnSyncReturns<string>) => {
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
}

const writeRelease = (dir: string, linux = "linux-bytes\n") => {
  for (const row of releaseTargets) {
    writeFileSync(join(dir, row.asset), row.asset === "zwt-linux-x64" ? linux : `other ${row.asset}\n`)
  }
  const checksums = spawnSync("bash", [releaseSh, "checksums", dir], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() }
  })
  expect(checksums.status, checksums.stderr).toBe(0)
}

describe("install.sh", () => {
  it("parses as POSIX sh", () => {
    expectOk(spawnSync("/bin/sh", ["-n", installSh], { encoding: "utf8" }))
    expectOk(spawnSync("bash", ["-n", releaseSh], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }))
  })

  it("prints usage", () => {
    const result = run(["--help"])
    expectOk(result)
    expect(result.stdout).toContain("checksums.txt")
  })

  it("dry-run works when the script is piped to sh", () => {
    const home = tempDir()
    try {
      const result = spawnSync("/bin/sh", ["-s", "--", "--dry-run"], {
        encoding: "utf8",
        input: readFileSync(installSh),
        env: env({ HOME: home, ZWT_OS: "linux", ZWT_ARCH: "x64" })
      })
      expectOk(result)
      expect(result.stdout).toContain("https://github.com/Byevenes/zwt/releases/latest/download/zwt-linux-x64")
      expect(existsSync(join(home, ".local"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("rejects unknown arguments and versions that are not latest or vX.Y.Z", () => {
    const unknown = run(["--nope"])
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toContain("unknown argument")
    for (const version of ["0.1.0", "v1.2", "v1.2.3-rc1", "../v1.2.3", "v1.2.3.4"]) {
      const result = run(["--version", version, "--dry-run"])
      expect(result.status, version).not.toBe(0)
      expect(result.stderr).toContain("version must be latest or vX.Y.Z")
    }
  })

  it("dry-run names the asset and writes nothing", () => {
    const home = tempDir()
    try {
      for (const row of releaseTargets) {
        const result = run(["--dir", join(home, "bin"), "--version", "v0.1.0", "--dry-run"], {
          HOME: home,
          ZWT_OS: row.os,
          ZWT_ARCH: row.arch
        })
        expectOk(result)
        expect(result.stdout).toBe(
          [
            `would download https://github.com/Byevenes/zwt/releases/download/v0.1.0/${row.asset}`,
            "would verify sha256 using https://github.com/Byevenes/zwt/releases/download/v0.1.0/checksums.txt",
            `would install ${join(home, "bin")}/zwt`,
            ""
          ].join("\n")
        )
      }
      const latest = run(["--dry-run"], { HOME: home, ZWT_OS: "linux", ZWT_ARCH: "arm64", ZWT_REPO: "example/zwt" })
      expectOk(latest)
      expect(latest.stdout).toContain("https://github.com/example/zwt/releases/latest/download/zwt-linux-arm64")
      const missing = run(["--dry-run"], {
        HOME: home,
        ZWT_OS: "darwin",
        ZWT_ARCH: "x64",
        ZWT_RELEASE_BASE: "file:///no/such/zwt-release"
      })
      expectOk(missing)
      expect(existsSync(join(home, ".local"))).toBe(false)
      expect(existsSync(join(home, "bin"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("asks for --dir when HOME is unset", () => {
    const result = spawnSync("/bin/sh", [installSh, "--dry-run"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), ZWT_OS: "linux", ZWT_ARCH: "x64" }
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("HOME is unset")
  })

  it("rejects an unsupported os or arch before downloading", () => {
    const os = run(["--dry-run"], { ZWT_OS: "windows", ZWT_ARCH: "x64" })
    expect(os.status).not.toBe(0)
    expect(os.stderr).toContain("unsupported operating system")
    const arch = run(["--dry-run"], { ZWT_OS: "linux", ZWT_ARCH: "riscv64" })
    expect(arch.status).not.toBe(0)
    expect(arch.stderr).toContain("unsupported architecture")
  })

  it("installs the checked binary and replaces it on a second run", () => {
    const release = tempDir()
    const home = tempDir()
    try {
      writeRelease(release, "first\n")
      const destDir = join(home, "My Bin")
      const dest = join(destDir, "zwt")
      const first = run(["--dir", destDir], {
        HOME: home,
        ZWT_OS: "linux",
        ZWT_ARCH: "x64",
        ZWT_RELEASE_BASE: `file://${release}/`
      })
      expectOk(first)
      expect(readFileSync(dest, "utf8")).toBe("first\n")
      expect(statSync(dest).mode & 0o111).not.toBe(0)
      expect(first.stdout).toContain(`installed ${dest}`)
      expect(first.stderr).toContain(`${destDir} is not on PATH`)
      expect(existsSync(join(destDir, ".zwt.installing"))).toBe(false)

      writeRelease(release, "second\n")
      const second = run(["--dir", destDir], {
        HOME: home,
        PATH: `/usr/bin:/bin:${destDir}`,
        ZWT_OS: "linux",
        ZWT_ARCH: "x64",
        ZWT_RELEASE_BASE: `file://${release}`
      })
      expectOk(second)
      expect(readFileSync(dest, "utf8")).toBe("second\n")
      expect(second.stderr).not.toContain("is not on PATH")
    } finally {
      rmSync(release, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("leaves an existing install in place when the checksum is wrong", () => {
    const release = tempDir()
    const destDir = tempDir()
    try {
      writeFileSync(join(release, "zwt-linux-x64"), "tampered\n")
      writeFileSync(join(release, "checksums.txt"), `${"ab".repeat(32)}  zwt-linux-x64\n`)
      writeFileSync(join(destDir, "zwt"), "previous")
      writeFileSync(join(destDir, "keep"), "keep")
      const result = run(["--dir", destDir], {
        ZWT_OS: "linux",
        ZWT_ARCH: "x64",
        ZWT_RELEASE_BASE: `file://${release}`
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("checksum mismatch for zwt-linux-x64")
      expect(readFileSync(join(destDir, "zwt"), "utf8")).toBe("previous")
      expect(readFileSync(join(destDir, "keep"), "utf8")).toBe("keep")
      expect(existsSync(join(destDir, ".zwt.installing"))).toBe(false)
    } finally {
      rmSync(release, { recursive: true, force: true })
      rmSync(destDir, { recursive: true, force: true })
    }
  })

  it("stops when checksums.txt has no sha256 for this asset", () => {
    const release = tempDir()
    const destDir = join(tempDir(), "bin")
    try {
      writeFileSync(join(release, "zwt-linux-x64"), "bytes")
      writeFileSync(join(release, "checksums.txt"), `${"cd".repeat(32)}  zwt-darwin-arm64\n`)
      const missing = run(["--dir", destDir], {
        ZWT_OS: "linux",
        ZWT_ARCH: "x64",
        ZWT_RELEASE_BASE: `file://${release}`
      })
      expect(missing.status).not.toBe(0)
      expect(missing.stderr).toContain("has no entry for zwt-linux-x64")
      expect(existsSync(join(destDir, "zwt"))).toBe(false)

      writeFileSync(join(release, "checksums.txt"), "abcd  zwt-linux-x64\n")
      const short = run(["--dir", destDir], {
        ZWT_OS: "linux",
        ZWT_ARCH: "x64",
        ZWT_RELEASE_BASE: `file://${release}`
      })
      expect(short.status).not.toBe(0)
      expect(short.stderr).toContain("not sha256")
      expect(existsSync(join(destDir, "zwt"))).toBe(false)
    } finally {
      rmSync(release, { recursive: true, force: true })
      rmSync(join(destDir, ".."), { recursive: true, force: true })
    }
  })

  it("stops when curl and wget are both missing", () => {
    const release = tempDir()
    const bin = tempDir()
    try {
      writeFileSync(join(release, "zwt-linux-x64"), "bytes")
      writeFileSync(join(release, "checksums.txt"), `${"ab".repeat(32)}  zwt-linux-x64\n`)
      symlinkSync("/usr/bin/mktemp", join(bin, "mktemp"))
      const result = run(["--dir", join(tempDir(), "out")], {
        PATH: bin,
        ZWT_OS: "linux",
        ZWT_ARCH: "x64",
        ZWT_RELEASE_BASE: `file://${release}`
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("need curl or wget")
    } finally {
      rmSync(release, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
