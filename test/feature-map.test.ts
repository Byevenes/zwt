import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { Option } from "effect"
import { GlobalFlag, type Flag, Param } from "effect/cli"
import { DryRun, walkUserCommands, zwt } from "../src/cli.ts"

const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const mapPath = repoFile("docs/feature-map.md")
const ciPath = repoFile(".github/workflows/ci.yml")
const main = repoFile("src/main.ts")

type FlagParam = Param.Param<"flag", unknown>

const isWrapped = (
  param: FlagParam
): param is
  | Param.Map<"flag", unknown, unknown>
  | Param.Transform<"flag", unknown, unknown>
  | Param.Optional<"flag", unknown>
  | Param.Variadic<"flag", unknown> => param._tag !== "Single"

const namedFlag = (param: FlagParam): Param.Single<"flag", unknown> => {
  if (Param.isSingle(param)) return param
  if (isWrapped(param)) return namedFlag(param.param)
  throw new Error("flag has no name")
}

const flow = (flag: Flag.Flag<unknown>) => {
  const single = namedFlag(flag)
  return {
    command: `--${single.name}`,
    description: Option.getOrElse(single.description, () => "")
  }
}

const parseMap = (markdown: string) =>
  markdown.split("\n").flatMap((line) => {
    if (!line.startsWith("|")) return []
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
    const command = cells[0]?.replaceAll("`", "") ?? ""
    const what = cells[1]?.replaceAll("`", "") ?? ""
    const verified = cells[2] ?? ""
    if (command.length === 0 || command === "Command" || /^:?-+:?$/.test(command)) return []
    return [{ command, what, verified }]
  })

const verifiedSpans = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "")

describe("feature map", () => {
  it("lists each tree command and the dry-run and wizard flows", () => {
    const expected = new Map<string, string>()
    for (const row of walkUserCommands(zwt)) expected.set(row.command, row.description)
    for (const row of [flow(DryRun.flag), flow(GlobalFlag.Wizard.flag)]) expected.set(row.command, row.description)

    const rows = parseMap(readFileSync(mapPath, "utf8"))
    expect(rows.map((row) => row.command).sort()).toEqual([...expected.keys()].sort())
    for (const row of rows) expect(row.what).toBe(expected.get(row.command))

    const ci = readFileSync(ciPath, "utf8")
    for (const row of rows) {
      const spans = verifiedSpans(row.verified)
      expect(spans.length).toBeGreaterThan(0)
      for (const span of spans) {
        if (span.includes(" ")) {
          expect(ci).toContain(span)
          continue
        }
        expect(span.startsWith("test/") || span.startsWith("scripts/")).toBe(true)
        expect(existsSync(repoFile(span))).toBe(true)
      }
    }
  })

  const home = mkdtempSync(join(tmpdir(), "zwt-feature-map-"))
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    GIT_CONFIG_NOSYSTEM: "1"
  }
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it("prints usage and global flags from --help", () => {
    const help = spawnSync(process.execPath, [main, "--help"], { encoding: "utf8", env })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain("USAGE")
    expect(help.stdout).toContain("GLOBAL FLAGS")
  })

  it("prints the command wizard banner from --wizard", () => {
    const wizard = spawnSync(process.execPath, [main, "--wizard"], {
      encoding: "utf8",
      env,
      input: "",
      timeout: 10000
    })
    expect(`${wizard.stdout}${wizard.stderr}`).toContain("Command wizard")
  })
})
