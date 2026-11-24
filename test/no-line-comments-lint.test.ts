import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const oxlint = join(root, "node_modules", ".bin", "oxlint")
const fixture = (name: string) =>
  join(root, "tools", "oxlint", "no-line-comments", "fixtures", name)

const lint = (name: string) =>
  spawnSync(
    oxlint,
    [
      "-A",
      "all",
      "-D",
      "zwt/no-line-comments",
      "--deny-warnings",
      "-c",
      join(root, "oxlint.config.ts"),
      fixture(name)
    ],
    { encoding: "utf8", cwd: root }
  )

describe("zwt/no-line-comments", () => {
  it("fails on a `//` contract of the kind left after #56", () => {
    const result = lint("forbidden-line-comment.ts")
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain("zwt(no-line-comments)")
  })

  it("allows JSDoc contracts", () => {
    const result = lint("allowed-jsdoc.ts")
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
  })

  it("allows block comments", () => {
    const result = lint("allowed-block.ts")
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
  })

  it("allows compiler and lint directives", () => {
    const result = lint("allowed-directives.ts")
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
  })
})
