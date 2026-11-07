import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { parseConfig } from "../src/services/Config.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

const bundled = [
  ["examples/zwt.toml", "../examples/zwt.toml"],
  ["valid.toml", "./fixtures/valid.toml"]
] as const

describe("bundled config files", () => {
  it.effect("parse with the schema", () =>
    Effect.gen(function*() {
      for (const [name, path] of bundled) {
        const config = yield* parseConfig(name, read(path))
        expect(config.version).toBe(1)
        expect(Object.keys(config.identity).length).toBeGreaterThan(0)
      }
    }))
})
