import { describe, expect, it } from "@effect/vitest"
import { appendExcludeLine } from "../src/exclude.ts"

describe("appendExcludeLine", () => {
  it("appends a missing pattern as its own line", () => {
    expect(appendExcludeLine("# comments\n", ".scratch")).toBe("# comments\n.scratch\n")
    expect(appendExcludeLine("# comments", ".scratch")).toBe("# comments\n.scratch\n")
    expect(appendExcludeLine("", ".scratch")).toBe(".scratch\n")
  })

  it("leaves the file alone when the pattern is already a whole line", () => {
    const present = "# comments\n.scratch\n"
    expect(appendExcludeLine(present, ".scratch")).toBeUndefined()
    expect(appendExcludeLine("# comments\n  .scratch  \n", ".scratch")).toBeUndefined()
    expect(appendExcludeLine("# .scratch is a comment\n", ".scratch")).toBe("# .scratch is a comment\n.scratch\n")
  })

  it("does not add the pattern a second time", () => {
    const once = appendExcludeLine("keep\n", ".notes")
    expect(once).toBe("keep\n.notes\n")
    expect(appendExcludeLine(once ?? "", ".notes")).toBeUndefined()
  })
})
