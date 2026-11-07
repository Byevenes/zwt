import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { expectTypeOf } from "vitest"
import { defaultConfig, type IsZwtConfigShape } from "../src/default-config.ts"
import { parseConfig } from "../src/services/Config.ts"
import invalidFixture from "./fixtures/invalid.toml"
import unknownKeyFixture from "./fixtures/unknown-key.toml"
import validFixture from "./fixtures/valid.toml"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

type Minimal = {
  readonly version: 1
  readonly identity: {
    readonly personal: { readonly name: "Jane Doe"; readonly email: "jane@example.com" }
  }
}

describe("Motherload config types", () => {
  it("types the bundled example and fixtures from their contents", () => {
    expectTypeOf(defaultConfig.version).toEqualTypeOf<1>()
    expectTypeOf(defaultConfig.identity.personal.email).toEqualTypeOf<"jane@example.com">()
    expectTypeOf(defaultConfig.profile[1].guards).toEqualTypeOf<readonly ["pre-commit", "pre-push"]>()
    expectTypeOf(validFixture.identity.work.email).toEqualTypeOf<"jane.doe@example.com">()
    expectTypeOf(invalidFixture.identity.personal.email).toEqualTypeOf<"not-an-email">()
    expectTypeOf(unknownKeyFixture.token).toEqualTypeOf<"abc">()

    expectTypeOf<IsZwtConfigShape<typeof defaultConfig>>().toEqualTypeOf<true>()
    expectTypeOf<IsZwtConfigShape<typeof validFixture>>().toEqualTypeOf<true>()
    // A bad email and an unknown identity are still strings. Schema rejects them; the shape does not.
    expectTypeOf<IsZwtConfigShape<typeof invalidFixture>>().toEqualTypeOf<true>()
    expectTypeOf<IsZwtConfigShape<typeof unknownKeyFixture>>().toEqualTypeOf<false>()
  })

  it("rejects shapes Schema would reject for structure, and keeps open identity keys", () => {
    expectTypeOf<IsZwtConfigShape<Minimal>>().toEqualTypeOf<true>()
    expectTypeOf<IsZwtConfigShape<Omit<Minimal, "version">>>().toEqualTypeOf<false>()
    expectTypeOf<IsZwtConfigShape<{ readonly version: 2; readonly identity: Minimal["identity"] }>>().toEqualTypeOf<false>()
    expectTypeOf<IsZwtConfigShape<Minimal & { readonly token: "abc" }>>().toEqualTypeOf<false>()
    expectTypeOf<
      IsZwtConfigShape<{
        readonly version: 1
        readonly identity: {
          readonly personal: { readonly name: "Jane Doe"; readonly email: "jane@example.com"; readonly token: "abc" }
        }
      }>
    >().toEqualTypeOf<false>()
    expectTypeOf<
      IsZwtConfigShape<{
        readonly version: 1
        readonly identity: Minimal["identity"] & {
          readonly external: { readonly name: "Jane External"; readonly email: "jane.external@example.com" }
        }
      }>
    >().toEqualTypeOf<true>()
    expectTypeOf<
      IsZwtConfigShape<{
        readonly version: 1
        readonly identity: Minimal["identity"]
        readonly profile: readonly [{
          readonly match: "~/personal/**"
          readonly identity: "personal"
          readonly guards: readonly ["pre-commit", "lint"]
        }]
      }>
    >().toEqualTypeOf<false>()
  })

  it.effect("decodes the example and the valid fixture to the imported values", () =>
    Effect.gen(function*() {
      const example = yield* parseConfig("examples/zwt.toml", read("../examples/zwt.toml"))
      const valid = yield* parseConfig("valid.toml", read("./fixtures/valid.toml"))
      expect(example).toEqual(defaultConfig)
      expect(valid).toEqual(validFixture)
      expect(example.remote?.[0]).toEqual({ pattern: "github.com/other-org/", identity: "external" })
    }))

  it.effect("still rejects the invalid fixture and an unknown key at runtime", () =>
    Effect.gen(function*() {
      const invalid = yield* Effect.flip(parseConfig("invalid.toml", read("./fixtures/invalid.toml")))
      expect(invalid.issues[0]).toMatchObject({ path: "identity.personal.email", line: 5 })
      const extra = yield* Effect.flip(parseConfig("unknown-key.toml", read("./fixtures/unknown-key.toml")))
      expect(extra.issues[0]?.path).toBe("token")
    }))
})
